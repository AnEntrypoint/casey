// case-tools-record-report.js  --  case_report: the one tool that writes the
// structured report blob (plus the case's own lat/lon columns) for the turn's
// bound active case.
//
// Split out of case-tools-record.js verbatim -- the tool name and description
// still come straight from the loaded config via store/report-shape.js, the
// parameter schema is unchanged, and the handler performs the same steps in the
// same order. What changed is only that each step of that order is now a named
// function below instead of one long inline body: bind-and-authorise the target,
// validate the arguments, merge the report under the store's own lock, write the
// coordinate columns, keep the derived location in step, audit, then wire
// provenance. Every one of those steps has its own failure discipline (fail
// closed, reject loudly, best-effort) and the comments that state it travel with
// the step.

import { AGENT_USER, REPORT_KEYS } from './case-store.js'
import { toStorable } from './store/guards.js'
import { REPORT_FIELD_DEFS, REPORT_GEO_FIELD_DEFS, REPORT_TOOL_NAME, REPORT_TOOL_DESCRIPTION } from './store/report-shape.js'
import { normalizeLocation } from './location-normalize.js'
import { recordProvenanceObservation } from './provenance-wire.js'
import { defTool, str, pick, boundCase, isValidLatLon } from './case-tools-shared.js'

const OBSERVE_BLOCKED = { error: 'case autonomy is "observe"; agent edits are disabled. Use case_observe to record notes.' }
const LOCATION_SOURCE_VALUES = new Set(['gps', 'estimated', 'confirmed'])

export function buildCaseReportTools(store) {
  return [
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
        const target = await resolveReportTarget(store, id, ctx)
        if (target.error) return { error: target.error }
        id = target.id
        const args = validateReportArgs({ fields, lat, lon, location_source })
        if (args.error) return { error: args.error, ...(args.allowed ? { allowed: args.allowed } : {}) }
        const { incoming, hasLatLon, resolvedLocationSource } = args

        const merged = await mergeIncomingReport(store, id, incoming)
        if (merged.error) return { error: merged.error }
        const { res, priorReport } = merged

        if (hasLatLon) {
          const wrote = await writeReportLocation(store, id, { lat, lon, resolvedLocationSource })
          if (wrote.error) return { error: wrote.error }
        }
        await syncDerivedLocation(store, id, incoming)
        await auditReportWrite(store, id, { incoming, priorReport, hasLatLon, lat, lon })
        await wireProvenance(store, ctx, id, { incoming, res, hasLatLon, lat, lon })
        return { ok: true, report: res.report, fieldsRecorded: recordedFields(incoming, hasLatLon), ...(res.cappedFields?.length ? { cappedFields: res.cappedFields } : {}) }
      }),
  ]
}

// Bind server-side to the turn's active case. A model error or prompt-injected
// inbound text naming another case's ref must never be able to write into a
// stranger's case.
// Fail CLOSED: a turn with no bound active case has nothing legitimate to check
// the argument against, so it is rejected too, not let through -- otherwise any
// caller path that fails to populate ctx.activeCaseId (a race before binding, a
// malformed ctx, a degraded turn) would silently regain the pre-fix
// trust-the-argument-blindly behaviour this exists to close.
// The model may pass either name of the bound case -- the internal id or the ref
// (enquiryRow hands it both, and the prompt speaks in refs) -- both name the SAME
// case, so accepting either preserves the invariant (writes only ever land on the
// active conversation case). The returned id is normalized to the internal id no
// matter which name the model passed.
async function resolveReportTarget(store, id, ctx) {
  const bound = boundCase(ctx)
  if (bound.id && (id === bound.id || id === bound.ref)) return { id: bound.id }
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

function validateReportArgs({ fields, lat, lon, location_source }) {
  const incoming = pick(fields, [...REPORT_KEYS])
  const latLonSupplied = typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon)
  const hasLatLon = latLonSupplied && isValidLatLon(lat, lon)
  // A supplied-but-out-of-range coordinate (e.g. swapped lat/lon) must not be
  // silently dropped indistinguishably from "never supplied" -- surface it so
  // the caller/agent can correct it instead of the map pin quietly never
  // appearing with no explanation.
  if (latLonSupplied && !hasLatLon) {
    return { error: `lat/lon out of range: lat=${lat}, lon=${lon} (expected |lat|<=90, |lon|<=180)` }
  }
  // location_source is validated the same strict way as case_type/priority
  // (case_update): an explicit bad value is rejected loudly, never silently
  // dropped -- but lat/lon may still arrive with no source named at all (an
  // older prompt build, a model that forgot the arg), and that must not simply
  // reject the whole coordinate write. Defaults to 'estimated' -- the SAFER of
  // the two real provenance states when the model is silent about which one it
  // means, so a pin never gets mislabeled 'gps'-trustworthy by omission.
  if (location_source != null && !LOCATION_SOURCE_VALUES.has(location_source)) {
    return { error: `invalid location_source: ${location_source}`, allowed: [...LOCATION_SOURCE_VALUES] }
  }
  if (!Object.keys(incoming).length && !hasLatLon) return { error: 'no report fields supplied' }
  return { incoming, hasLatLon, resolvedLocationSource: hasLatLon ? (location_source || 'estimated') : null }
}

// Atomic read-merge-write in the store, under the per-conversation lock, so two
// concurrent agent turns for the same case cannot read the same stale report and
// clobber each other's fields. Later messages refine earlier ones; a field
// already given is never lost.
//
// The PRIOR value of every field this call touches comes from mergeReport's own
// return (res.priorReport, read INSIDE its per-conversation lock), not from a
// separate unlocked read -- an unlocked read taken before the lock is acquired
// can be stale if a concurrent write (another buffered turn, an operator PATCH)
// lands in between, producing a correction diff that silently omits the
// intermediate value.
async function mergeIncomingReport(store, id, incoming) {
  if (!Object.keys(incoming).length) return { res: { report: null }, priorReport: {} }
  const res = await store().mergeReport(id, incoming, AGENT_USER)
  if (res.error === 'observe') return { error: OBSERVE_BLOCKED.error }
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
  return { res, priorReport: res.priorReport || {} }
}

// lat/lon are real case columns, not report JSON, and the model's own estimate
// (or the worker's exact GPS) is the ONLY source -- casey does no server-side
// lookup. A later, more specific case_report call simply overwrites the
// coordinate with the model's improved estimate.
//
// Routed through updateCaseChecked (re-reads autonomy INSIDE the
// per-conversation lock, same discipline mergeReport/case_update already use)
// rather than a raw getCase-then-check-then-write -- that stale-read-then-write
// shape is exactly the TOCTOU race updateCaseChecked was introduced to close.
async function writeReportLocation(store, id, { lat, lon, resolvedLocationSource }) {
  const latLonResult = await store().updateCaseChecked(id, { lat, lon, location_source: resolvedLocationSource }, AGENT_USER)
  if (latLonResult.error === 'observe') return { error: OBSERVE_BLOCKED.error }
  if (latLonResult.error) return { error: latLonResult.error }
  const c = latLonResult.case
  // Propagate to the CONTACT as their last-reported location, distinct from both
  // case.lat/lon (this specific report's animal location, just written above) and
  // contact.last_location_* (a field_worker's own casual position check-in via
  // case_checkin -- a different axis entirely: where the WORKER is standing, not
  // where an animal report is). last_report_lat/lon/at is "where did this
  // contact's most recent report say the animals were", refined forward across
  // their reports the same way case.lat/lon itself refines on a later, more
  // specific case_report call. Best-effort: a contact-propagation failure must
  // never block the real case write above, which already succeeded.
  if (c?.contact_id) {
    try {
      await store().t.update('contact', c.contact_id, toStorable({
        last_report_lat: lat, last_report_lon: lon, last_report_at: new Date().toISOString(),
        last_report_case_id: id,
      }), AGENT_USER)
    } catch { /* best-effort -- the case's own lat/lon write is the source of truth */ }
  }
  return {}
}

// Keep the derived normalized_location field (case-store.js
// DERIVED_ONLY_FIELDS) in step with a newly-recorded/changed location, as the
// SYSTEM actor -- the write guard rejects this same field from AGENT_USER, so it
// must go through the system principal. Best-effort: a failure here must never
// block the real report write above.
async function syncDerivedLocation(store, id, incoming) {
  if (!('location' in incoming) || typeof store().systemUpdateDerived !== 'function') return
  try { await store().systemUpdateDerived(id, { normalized_location: normalizeLocation(incoming.location) }) }
  catch { /* best effort -- derived-field freshness, not the write itself, is at stake */ }
}

function recordedFields(incoming, hasLatLon) {
  return [...Object.keys(incoming), ...(hasLatLon ? ['lat', 'lon', 'location_source'] : [])]
}

// photos/audio append rather than overwrite (see mergeReport), so a changed
// prior-vs-new value there is an ADDITION, not a correction -- exclude them from
// the correction diff, which is only meaningful for fields that genuinely
// replace their prior value.
async function auditReportWrite(store, id, { incoming, priorReport, hasLatLon, lat, lon }) {
  const fieldsRecorded = recordedFields(incoming, hasLatLon)
  const corrections = Object.keys(incoming)
    .filter(k => k !== 'photos' && k !== 'audio' && k !== 'sites')
    .filter(k => priorReport[k] != null && String(priorReport[k]).trim() !== '' && String(priorReport[k]) !== String(incoming[k]))
    .map(k => `${k} ${priorReport[k]} -> ${incoming[k]}`)
  const text = corrections.length
    ? `recorded report fields: ${fieldsRecorded.join(', ')}; changed: ${corrections.join(', ')}`
    : `recorded report fields: ${fieldsRecorded.join(', ')}`
  await store().appendEvent(id, { kind: 'action', actor: 'agent', text, data: { ...incoming, ...(hasLatLon ? { lat, lon } : {}), ...(corrections.length ? { corrections } : {}) } })
}

// ADDITIVE ONLY: also produce a provenance-tagged Observation in the ground-truth
// subsystem (src/core/, src/packs/) alongside the real thatcher write above --
// never instead of it, never blocking it (the real write already succeeded by
// this point). Best-effort: a failure here must never surface to the agent/contact.
//
// A field mergeReport rejected for exceeding its append-length cap
// (res.cappedFields, warned above) was never actually written to the real report
// -- it must not be recorded as 'reported' in the provenance ledger either, since
// that ledger has no update/delete and would then permanently claim a fact that
// never landed.
async function wireProvenance(store, ctx, id, { incoming, res, hasLatLon, lat, lon }) {
  try {
    const dataDir = store().dataDir
    const provenanceIncoming = res.cappedFields?.length
      ? Object.fromEntries(Object.entries(incoming).filter(([k]) => !res.cappedFields.includes(k)))
      : incoming
    if (dataDir) await recordProvenanceObservation({ dataDir, caseId: id, author: ctx?.author, incoming: provenanceIncoming, hasLatLon, lat, lon })
  } catch { /* best-effort -- the provenance ledger is additive, never load-bearing for the real write */ }
}
