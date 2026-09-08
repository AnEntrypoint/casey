// case-tools-record.js  --  the tools that WRITE to a case: edit its fields,
// record the report, add an observation, move it through the workflow.
//
// Split out of case-tools.js verbatim -- names, descriptions (case_report's
// come straight from the loaded config via report-shape.js), parameter schemas
// and handler bodies are unchanged. Every tool here is autonomy-aware: an
// operator's `observe` setting blocks content edits, which is why the writes
// route through updateCaseChecked/mergeReport (autonomy re-read INSIDE the
// per-conversation lock) rather than a read-then-write of their own.

import { AGENT_USER, REPORT_KEYS } from './case-store.js'
import { REPORT_FIELD_DEFS, REPORT_GEO_FIELD_DEFS, REPORT_TOOL_NAME, REPORT_TOOL_DESCRIPTION } from './store/report-shape.js'
import { normalizeLocation } from './location-normalize.js'
import { recordProvenanceObservation } from './provenance-wire.js'
import {
  defTool, str, pick, ownsCase, slimCase, boundCase, isValidLatLon, OBSERVE_TEXT_MAX_LEN,
} from './case-tools-shared.js'

export function buildRecordTools(store, { caseTypeValues, priorityValues, stageValues }) {
  return [
    defTool('case_update', 'cases',
      'Update editable case fields (subject, summary, priority, assignee, autonomy, case_type). Keep `summary` current -- it is your working memory of the case. You may set `case_type` ONLY when the worker or farmer directly and explicitly said which category applies (e.g. they used the word "outbreak", named a lab sample/test, or said the animals were recently moved/imported) -- never from your own inference about severity, onset speed, or whether a disease is notifiable. This is recording a stated fact, not diagnosing or triaging; a technician makes that call. Leave it unset whenever the category was not explicitly stated -- unset is correct and expected far more often than not.',
      {
        type: 'object',
        properties: {
          id: str('Case id'),
          subject: str('Short human title'),
          summary: str('One-paragraph rolling summary of the case state'),
          priority: str('Priority', { enum: priorityValues }),
          assignee: str('Operator handle, or "agent"'),
          case_type: str('Category, set ONLY when directly and explicitly stated by the worker/farmer -- never inferred from severity or symptoms. Leave unset when not explicitly stated.', { enum: caseTypeValues }),
        },
        required: ['id'],
      },
      async ({ id, ...patch }, ctx) => {
        // Validate case_type/priority BEFORE pick()'s empty-string filtering: an
        // explicit case_type:"" must be rejected the same way a bogus value is,
        // not silently dropped as if the field were never supplied -- pick()
        // would otherwise treat an empty-string write as a no-op, which looks
        // like the update succeeded to a caller who doesn't check fieldsRecorded.
        // Live config-declared enum (falling back to the same hint the model
        // was shown, when the config leaves case_type/priority undeclared), so
        // a deployment's own thatcher.config.yml options are the ones actually
        // enforced, not a second hardcoded copy of the list. Hint and
        // enforcement now read the SAME store, so the model can no longer be
        // offered a value this check would reject.
        const caseTypeValueSet = new Set(store().getFieldEnum('case.case_type', caseTypeValues))
        const priorityValueSet = new Set(store().getFieldEnum('case.priority', priorityValues))
        if ('case_type' in patch && !caseTypeValueSet.has(patch.case_type)) {
          return { error: `invalid case_type: ${patch.case_type}`, allowed: [...caseTypeValueSet] }
        }
        if ('priority' in patch && !priorityValueSet.has(patch.priority)) {
          return { error: `invalid priority: ${patch.priority}`, allowed: [...priorityValueSet] }
        }
        const clean = pick(patch, ['subject', 'summary', 'priority', 'assignee', 'case_type'])
        if (!Object.keys(clean).length) return { error: 'no editable fields supplied' }
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        // A field_worker may learn another case's id via case_list/case_mine
        // (PII-free rows still carry `id`) -- ownership must be checked here too,
        // same gate case_get/case_switch already apply, or any worker could edit
        // a stranger's case (priority/assignee/case_type/subject/summary).
        const author = ctx?.author || ctx?.principal?.id
        if (!ownsCase(c.external_id, author)) {
          return { error: `case ${id} does not belong to you -- cannot update it` }
        }
        // Autonomy is operator control: it is set only from the dashboard, never by
        // the agent -- otherwise the agent could flip observe back to auto and
        // escape the very mode an operator used to stop it acting. So in observe
        // mode the agent may only observe; all content edits are blocked. Routed
        // through updateCaseChecked (re-reads autonomy INSIDE the per-conversation
        // lock, same discipline as mergeReport) rather than this outer read-then-
        // write, so an operator's dashboard observe-mode flip landing between this
        // handler's own read and its write cannot be raced.
        const result = await store().updateCaseChecked(id, clean, AGENT_USER)
        if (result.error === 'observe') {
          return { error: 'case autonomy is "observe"; agent edits are disabled. Use case_observe to record notes.' }
        }
        if (result.error) return result
        const { case: updated, prior } = result
        const caseTypeChanged = 'case_type' in clean && (prior.case_type || 'unset') !== clean.case_type
        // Audited as its own from/to action, matching the dashboard's own
        // reclassification event shape, so /api/report.json's per-type analytics
        // can trace an agent-driven reclassification the same way as an operator one.
        if (caseTypeChanged) {
          await store().appendEvent(id, {
            kind: 'action', actor: 'agent',
            text: `case_type ${prior.case_type || 'unset'} -> ${clean.case_type}`,
            data: { from: prior.case_type || 'unset', to: clean.case_type, field: 'case_type' },
          })
        }
        const otherKeys = Object.keys(clean).filter(k => k !== 'case_type')
        if (otherKeys.length) {
          await store().appendEvent(id, { kind: 'action', actor: 'agent', text: `updated ${otherKeys.join(', ')}`, data: Object.fromEntries(otherKeys.map(k => [k, clean[k]])) })
        }
        return { ok: true, case: slimCase(updated) }
      }),
    defTool(REPORT_TOOL_NAME, 'cases',
      REPORT_TOOL_DESCRIPTION,
      {
        type: 'object',
        properties: {
          id: str('Case id'),
          ...Object.fromEntries(REPORT_FIELD_DEFS.map(f => [f.key, str(f.description)])),
          ...Object.fromEntries(REPORT_GEO_FIELD_DEFS.map(f => [f.key, { type: 'number', description: f.description }])),
          location_source: str(
            'REQUIRED whenever lat/lon are supplied. "gps" ONLY if the person read out exact coordinates. ' +
            'Otherwise "estimated" -- your own best-effort guess from a place name, not yet confirmed with them. ' +
            'After you voice an estimate back and they confirm it or give a better description, call again with ' +
            '"confirmed" and your refined lat/lon. Never guess "confirmed" -- it means they actually agreed.',
            { enum: ['gps', 'estimated', 'confirmed'] },
          ),
        },
        required: ['id'],
      },
      async ({ id, lat, lon, location_source, ...fields }, ctx) => {
        // Bind server-side to the turn's active case. A model error or
        // prompt-injected inbound text naming another case's ref must never
        // be able to write into a stranger's case.
        // Fail CLOSED: a turn with no bound active case has nothing legitimate to
        // check the argument against, so it is rejected too, not let through --
        // otherwise any caller path that fails to populate ctx.activeCaseId (a
        // race before binding, a malformed ctx, a degraded turn) would silently
        // regain the pre-fix trust-the-argument-blindly behaviour this exists to close.
        // The model may pass either name of the bound case -- the internal id
        // or the ref (enquiryRow hands it both, and the prompt speaks in refs)
        // -- both name the SAME case, so accepting either preserves the
        // invariant (writes only ever land on the active conversation case).
        const bound = boundCase(ctx)
        if (!bound.id || (id !== bound.id && id !== bound.ref)) {
          try {
            const logTarget = bound.id || id
            await store().appendEvent(logTarget, {
              kind: 'observation', actor: 'system',
              text: `SECURITY: case_report called with id=${id} but this turn's active case is ${bound.id || '(none)'}; write rejected.`,
              data: { attemptedId: id, activeCaseId: bound.id, tool: 'case_report' },
            })
          } catch { /* best effort -- never let the audit write block the rejection */ }
          return { error: bound.id
            ? `case_report must target this conversation's active case (${bound.ref || bound.id}), not ${id}`
            : 'case_report has no bound active case on this turn -- cannot target an arbitrary case id' }
        }
        // Normalize the write target to the internal id no matter which name
        // the model passed.
        id = bound.id
        const incoming = pick(fields, [...REPORT_KEYS])
        const latLonSupplied = typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon)
        const hasLatLon = latLonSupplied && isValidLatLon(lat, lon)
        // A supplied-but-out-of-range coordinate (e.g. swapped lat/lon) must not
        // be silently dropped indistinguishably from "never supplied" -- surface
        // it so the caller/agent can correct it instead of the map pin quietly
        // never appearing with no explanation.
        if (latLonSupplied && !hasLatLon) {
          return { error: `lat/lon out of range: lat=${lat}, lon=${lon} (expected |lat|<=90, |lon|<=180)` }
        }
        // location_source is validated the same strict way as case_type/priority
        // (case_update above): an explicit bad value is rejected loudly, never
        // silently dropped -- but lat/lon may still arrive with no source named
        // at all (an older prompt build, a model that forgot the arg), and that
        // must not simply reject the whole coordinate write. Defaults to
        // 'estimated' -- the SAFER of the two real provenance states when the
        // model is silent about which one it means, so a pin never gets
        // mislabeled 'gps'-trustworthy by omission.
        const LOCATION_SOURCE_VALUES = new Set(['gps', 'estimated', 'confirmed'])
        if (location_source != null && !LOCATION_SOURCE_VALUES.has(location_source)) {
          return { error: `invalid location_source: ${location_source}`, allowed: [...LOCATION_SOURCE_VALUES] }
        }
        const resolvedLocationSource = hasLatLon ? (location_source || 'estimated') : null
        if (!Object.keys(incoming).length && !hasLatLon) return { error: 'no report fields supplied' }
        // The PRIOR value of every field this call touches, so a correction (a
        // field already non-null being overwritten) is distinguishable in the
        // timeline from a first-time fill -- mirrors case_update's existing
        // case_type a->b change-tracking pattern. Taken from mergeReport's own
        // return (res.priorReport, read INSIDE its per-conversation lock), not
        // from a separate unlocked read here -- an unlocked read taken before
        // the lock is acquired can be stale if a concurrent write (another
        // buffered turn, an operator PATCH) lands in between, producing a
        // correction diff that silently omits the intermediate value.
        let priorReport = {}
        let res = { report: null }
        if (Object.keys(incoming).length) {
          // Atomic read-merge-write in the store, under the per-conversation lock, so
          // two concurrent agent turns for the same case cannot read the same stale
          // report and clobber each other's fields. Later messages refine earlier
          // ones; a field already given is never lost.
          res = await store().mergeReport(id, incoming, AGENT_USER)
          priorReport = res.priorReport || {}
          if (res.error === 'observe') return { error: 'case autonomy is "observe"; agent edits are disabled. Use case_observe to record notes.' }
          if (res.error) return { error: res.error }
          if (res.reportWasCorrupted) {
            try {
              await store().appendEvent(id, {
                kind: 'observation', actor: 'system',
                text: 'WARNING: this case\'s stored report JSON was corrupted and has been reset before merging in this turn\'s fields -- some previously recorded fields may be lost. Review the case history for what was said before this point.',
              })
            } catch { /* best-effort -- the report write itself already succeeded */ }
          }
          if (res.cappedFields?.length) {
            try {
              await store().appendEvent(id, {
                kind: 'observation', actor: 'system',
                text: `WARNING: field(s) ${res.cappedFields.join(', ')} reached their maximum accumulated length -- this turn's new note(s) were NOT attached. A human should review the case for a length reset.`,
                data: { cappedFields: res.cappedFields },
              })
            } catch { /* best-effort -- the report write itself already succeeded */ }
          }
        }
        // lat/lon are real case columns, not report JSON, and the model's own
        // estimate (or the worker's exact GPS) is the ONLY source -- casey does
        // no server-side lookup. A later, more specific case_report call simply
        // overwrites the coordinate with the model's improved estimate.
        if (hasLatLon) {
          // Routed through updateCaseChecked (re-reads autonomy INSIDE the
          // per-conversation lock, same discipline mergeReport/case_update
          // already use) rather than a raw getCase-then-check-then-write --
          // that stale-read-then-write shape is exactly the TOCTOU race
          // updateCaseChecked was introduced to close, and this lat/lon
          // branch had silently kept the old unlocked shape.
          const latLonResult = await store().updateCaseChecked(id, { lat, lon, location_source: resolvedLocationSource }, AGENT_USER)
          if (latLonResult.error === 'observe') return { error: 'case autonomy is "observe"; agent edits are disabled. Use case_observe to record notes.' }
          if (latLonResult.error) return { error: latLonResult.error }
          const c = latLonResult.case
          // Propagate to the CONTACT as their last-reported location, distinct
          // from both case.lat/lon (this specific report's animal location,
          // just written above) and contact.last_location_* (a field_worker's
          // own casual position check-in via case_checkin -- a different axis
          // entirely: where the WORKER is standing, not where an animal report
          // is). last_report_lat/lon/at is "where did this contact's most
          // recent report say the animals were", refined forward across their
          // reports the same way case.lat/lon itself refines on a later, more
          // specific case_report call. Best-effort: a contact-propagation
          // failure must never block the real case write above, which already
          // succeeded.
          if (c?.contact_id) {
            try {
              await store().t.update('contact', c.contact_id, {
                last_report_lat: lat, last_report_lon: lon, last_report_at: new Date().toISOString(),
                last_report_case_id: id,
              }, AGENT_USER)
            } catch { /* best-effort -- the case's own lat/lon write is the source of truth */ }
          }
        }
        // Keep the derived normalized_location field (case-store.js
        // DERIVED_ONLY_FIELDS) in step with a newly-recorded/changed location,
        // as the SYSTEM actor -- the write guard rejects this same field from
        // AGENT_USER, so it must go through the system principal. Best-effort:
        // a failure here must never block the real report write above.
        if ('location' in incoming && typeof store().systemUpdateDerived === 'function') {
          try { await store().systemUpdateDerived(id, { normalized_location: normalizeLocation(incoming.location) }) }
          catch { /* best effort -- derived-field freshness, not the write itself, is at stake */ }
        }
        const fieldsRecorded = [...Object.keys(incoming), ...(hasLatLon ? ['lat', 'lon', 'location_source'] : [])]
        // photos/audio append rather than overwrite (see mergeReport), so a
        // changed prior-vs-new value there is an ADDITION, not a correction --
        // exclude them from the correction diff, which is only meaningful for
        // fields that genuinely replace their prior value.
        const corrections = Object.keys(incoming)
          .filter(k => k !== 'photos' && k !== 'audio' && k !== 'sites')
          .filter(k => priorReport[k] != null && String(priorReport[k]).trim() !== '' && String(priorReport[k]) !== String(incoming[k]))
          .map(k => `${k} ${priorReport[k]} -> ${incoming[k]}`)
        const text = corrections.length
          ? `recorded report fields: ${fieldsRecorded.join(', ')}; changed: ${corrections.join(', ')}`
          : `recorded report fields: ${fieldsRecorded.join(', ')}`
        await store().appendEvent(id, { kind: 'action', actor: 'agent', text, data: { ...incoming, ...(hasLatLon ? { lat, lon } : {}), ...(corrections.length ? { corrections } : {}) } })
        // ADDITIVE ONLY: also produce a provenance-tagged Observation in the
        // new ground-truth subsystem (src/core/, src/packs/) alongside the
        // real thatcher write above -- never instead of it, never blocking
        // it (the real write already succeeded by this point). Best-effort:
        // a failure here must never surface to the agent/contact.
        try {
          const dataDir = store().dataDir
          // A field mergeReport rejected for exceeding its append-length cap
          // (res.cappedFields, warned above) was never actually written to
          // the real report -- it must not be recorded as 'reported' in the
          // provenance ledger either, since that ledger has no update/delete
          // and would then permanently claim a fact that never landed.
          const provenanceIncoming = res.cappedFields?.length
            ? Object.fromEntries(Object.entries(incoming).filter(([k]) => !res.cappedFields.includes(k)))
            : incoming
          if (dataDir) await recordProvenanceObservation({ dataDir, caseId: id, author: ctx?.author, incoming: provenanceIncoming, hasLatLon, lat, lon })
        } catch { /* best-effort -- the provenance ledger is additive, never load-bearing for the real write */ }
        return { ok: true, report: res.report, fieldsRecorded, ...(res.cappedFields?.length ? { cappedFields: res.cappedFields } : {}) }
      }),
    defTool('case_observe', 'cases',
      'Record an observation or internal note on the case timeline WITHOUT replying to the contact. Use for triage reasoning, flags, or anything an operator should see.',
      {
        type: 'object',
        properties: { id: str('Case id'), text: str('The observation', { maxLength: OBSERVE_TEXT_MAX_LEN }) },
        required: ['id', 'text'],
      },
      async ({ id, text }, ctx) => {
        if (String(text).length > OBSERVE_TEXT_MAX_LEN) {
          return { error: `text too long (${String(text).length} chars, max ${OBSERVE_TEXT_MAX_LEN})` }
        }
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        const author = ctx?.author || ctx?.principal?.id
        if (!ownsCase(c.external_id, author)) {
          return { error: `case ${id} does not belong to you -- cannot add an observation to it` }
        }
        await store().appendEvent(id, { kind: 'observation', actor: 'agent', text })
        return { ok: true }
      }),
    // (case_intent was deleted: it was a record-only stub whose INTENT-DECLARED
    // marker nothing read after the pure-LLM strip -- an enquiry declared through it
    // produced NOTHING. The prompt now directs the model straight to the real data
    // tools: case_today / case_mine / case_list / case_get.)
    defTool('case_transition', 'cases',
      'Move the case to a new workflow stage. Valid targets depend on current stage (new->triaging->in_progress->waiting->resolved->closed, with reopen paths). Call case_get first if unsure. Honour the case autonomy setting.',
      {
        type: 'object',
        properties: {
          id: str('Case id'),
          to: str('Target stage', { enum: stageValues }),
          reason: str('Why you are transitioning (recorded on the timeline)'),
        },
        required: ['id', 'to'],
      },
      async ({ id, to, reason = '' }, ctx) => {
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        const author = ctx?.author || ctx?.principal?.id
        if (!ownsCase(c.external_id, author)) {
          return { error: `case ${id} does not belong to you -- cannot transition it` }
        }
        if (c.autonomy === 'observe') return { error: 'case autonomy is "observe"; transitions are operator-only' }
        try {
          await store().transition(id, to, { user: AGENT_USER, reason })
          return { ok: true, from: c.status, to }
        } catch (e) {
          return { error: e.message }
        }
      }),
  ]
}
