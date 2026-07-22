// case-tools.js  --  the agent's hands on the case system of record.
//
// These are freddie tools ({ name, toolset, schema, handler }). They give the
// agent full autonomous control over a case while keeping every action on the
// append-only timeline, so a human can observe and override. The handlers close
// over a CaseStore (resolved lazily from case-runtime so the freddie plugin
// loader can import this without the store existing yet).

import { getCaseStore } from './case-runtime.js'
import { AGENT_USER, REPORT_KEYS } from './case-store.js'
import { CONVERSATION_PHASES } from './conversation-spec.js'
import { normalizeLocation } from './location-normalize.js'

const str = (description, extra = {}) => ({ type: 'string', description, ...extra })

// Constructor-shape dedup: every tool object below is { name, toolset, schema:
// { name, description, parameters }, handler }, with `name` repeated verbatim
// between the outer object and the inner schema. defTool takes it once and
// builds both. Purely structural -- does not touch handler logic, toolset
// values, description text, or parameters schemas.
function defTool(name, toolset, description, parameters, handler) {
  return { name, toolset, schema: { name, description, parameters }, handler }
}
// Shipped defaults -- used for the tool-schema `enum` hint shown to the model
// (built once at plugin-load time, before a store necessarily exists, so it
// cannot read live config) AND as the fallback when a config has no case_type/
// priority enum declared. The actual WRITE-TIME validation below reads the
// live config-declared enum via store().getFieldEnum(), so a deployment that
// adds/renames a case_type or priority value in thatcher.config.yml is
// enforced correctly even though the schema hint still shows the shipped list.
const DEFAULT_CASE_TYPE_VALUES = ['unset', 'outbreak', 'follow_up', 'lab_sample', 'import_alert']
const DEFAULT_PRIORITY_VALUES = ['low', 'normal', 'high', 'urgent']
// Same schema-hint-vs-enforcement split as case_type/priority above: the
// workflow's real stage graph (thatcher.config.yml workflows.case_lifecycle)
// is the actual authority (CaseStore._machine / getValidStatuses()), enforced
// wherever a transition is attempted. This default only seeds the tool-schema
// `enum` hint shown to the model before a store necessarily exists.
const DEFAULT_STAGE_VALUES = ['new', 'triaging', 'in_progress', 'waiting', 'resolved', 'closed']

// external_id is 'container:author' (a multi-author channel) or the bare author
// (a 1:1 chat) -- a case is "owned" by an author when their id appears as one
// of the colon-separated parts. Single source of truth for case_get's ownership
// gate and mineRows' "my cases" filter so a fix to one (case-insensitive ids, a
// different separator) can never diverge from the other and reopen a PII leak.
function ownsCase(externalId, author) {
  if (!author) return false
  const ext = String(externalId || '')
  const a = String(author)
  return ext === a || ext.split(':').includes(a) || ext.endsWith(':' + a)
}

// Build the array of tool objects bound to an explicit store (used by tests and
// by anywhere that wants the tools without the runtime singleton).
export function buildCaseToolset(storeOrNull) {
  const store = () => storeOrNull || getCaseStore()

  const tools = [
    defTool('case_get', 'cases',
      'Fetch a case by id, including its recent timeline events. Use to refresh your view before acting.',
      { type: 'object', properties: { id: str('Case id') }, required: ['id'] },
      async ({ id }, ctx) => {
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        // case_get's `id` param is agent-chosen -- the model can ask about ANY
        // case, not just the asking worker's own (a status ask like "how is
        // CASE-1234 going" names a ref the model resolves to some id). Ownership
        // scoping (same check as mineRows) decides which projection is safe: the
        // worker's OWN case gets the full slimCase (report incl. owner_name/
        // owner_contact -- their own case, their own data), a case belonging to
        // SOMEONE ELSE gets the PII-free enquiryRow, same as case_list/case_mine.
        // Without this, any worker asking about any case ref (even by typo/
        // overheard) got another contact's phone number and free-text account.
        const author = ctx?.author || ctx?.principal?.id
        // Fail CLOSED: no author on ctx means we cannot prove ownership, so treat
        // as not-owned (PII-free) rather than defaulting to full access.
        const owns = ownsCase(c.external_id, author)
        const events = owns ? await store().listEvents(id, { limit: 30 }) : []
        return { case: owns ? slimCase(c) : enquiryRow(c), events: events.map(slimEvent) }
      }),
    defTool('case_list', 'cases',
      'List cases, optionally filtered by status/channel/assignee/location. Use `location` (a town, area, or place a person mentions) to find reports in a place -- this is the place-enquiry tool. Use `near` (your own best-estimate lat/lon for the place the worker said they are at) to find the NEAREST reports -- this is the "closest case" / "cases near me" tool; it returns rows sorted by distance with a distance_km on each, so you can answer "the nearest on record is CASE-xxxx at <place>, about N km away" from the real result, never from memory. Returns most-recently-active first (or nearest-first when `near` is given), PII-free.',
      {
        type: 'object',
        properties: {
          status: str('Filter by workflow status', { enum: DEFAULT_STAGE_VALUES }),
          channel: str('Filter by channel'),
          assignee: str('Filter by assignee'),
          location: str('A place name (town/area) to match reports whose location contains it'),
          near: {
            type: 'object',
            description: 'Your own best-estimate latitude/longitude for the place the worker said they are at (a named town/farm/landmark you can place). Returns cases nearest that point, sorted by distance, each with distance_km. Coordinates are model-estimated, so this is a best-effort "nearest we have on record", not a surveyed exact distance. Leave cases with no recorded coordinate out of the ranking.',
            properties: {
              lat: { type: 'number', description: 'Latitude of the place the worker described' },
              lon: { type: 'number', description: 'Longitude of the place the worker described' },
              radius_km: { type: 'number', description: 'Optional cap: only return cases within this many km (e.g. 100). Omit to rank all coordinate-bearing cases by distance.' },
            },
          },
          limit: { type: 'number', default: 25 },
        },
      },
      async ({ status, channel, assignee, location, near, limit = 25 }) => {
        const where = {}
        if (status) where.status = status
        if (channel) where.channel = channel
        if (assignee) where.assignee = assignee
        // A place enquiry: location lives in the free-text report JSON, not a queryable
        // column, so pull a wider window and JS-filter on the report location substring.
        const pull = location ? Math.max(limit * 20, 500) : limit
        let rows = await store().listCases(where, { limit: pull })
        if (location) {
          // Shared normalization (case-fold, trim, collapse whitespace/punctuation
          // noise) so "eMalahleni," "eMalahleni.", and "emalahleni  " all match the
          // same needle -- consistent with the normalized_location derived field
          // (case-store.js), never a gazetteer/alias table.
          const needle = normalizeLocation(location)
          rows = rows.filter(c => {
            let loc = ''
            try { loc = (c.report ? JSON.parse(c.report) : {}).location || '' } catch { loc = '' }
            return normalizeLocation(loc).includes(needle)
          }).slice(0, limit)
        }
        // A proximity enquiry ("closest case" / "cases near me"): rank by great-circle
        // distance from the worker's stated place (the model's own best estimate). Only
        // cases that carry an agent-estimated lat/lon can be ranked; cases without a
        // coordinate are excluded from the near result (they cannot be placed). This is
        // best-effort because coordinates are model-estimated, not surveyed -- the
        // prompt frames the answer as "nearest we have on record".
        if (near && typeof near.lat === 'number' && typeof near.lon === 'number') {
          const origLat = near.lat, origLon = near.lon
          const radius = typeof near.radius_km === 'number' && Number.isFinite(near.radius_km) ? near.radius_km : null
          const withDist = []
          for (const c of rows) {
            const clat = Number(c.lat), clon = Number(c.lon)
            if (!Number.isFinite(clat) || !Number.isFinite(clon)) continue
            const d = haversineKm(origLat, origLon, clat, clon)
            if (radius != null && d > radius) continue
            withDist.push({ c, distance_km: Math.round(d * 10) / 10 })
          }
          withDist.sort((a, b) => a.distance_km - b.distance_km)
          const top = withDist.slice(0, limit)
          return { count: top.length, cases: top.map(({ c, distance_km }) => enquiryRow(c, distance_km)) }
        }
        // A LIST spans cases the asker may not own, so project each row PII-FREE
        // (enquiryRow: ref/status/species/location only) -- NEVER the full slimCase
        // report, which carries owner_name/contact_fallback/other-worker contact text.
        return { count: rows.length, cases: rows.map(enquiryRow) }
      }),
    defTool('case_update', 'cases',
      'Update editable case fields (subject, summary, priority, tags, assignee, autonomy, case_type). Keep `summary` current -- it is your working memory of the case. Set `case_type` as soon as the report makes the category clear -- this drives the organisers\' map, SLA targets, and workload views, so it must not sit unset waiting for a human to classify it by hand: outbreak (multiple animals, fast onset, or a suspected notifiable disease), follow_up (a routine check-in on an already-known situation), lab_sample (mainly about a sample/test result), import_alert (tied to recently moved/imported animals). Leave it unset only when nothing yet points to a category.',
      {
        type: 'object',
        properties: {
          id: str('Case id'),
          subject: str('Short human title'),
          summary: str('One-paragraph rolling summary of the case state'),
          priority: str('Priority', { enum: DEFAULT_PRIORITY_VALUES }),
          tags: str('Comma-separated tags'),
          assignee: str('Operator handle, or "agent"'),
          case_type: str('Category, set as soon as the report makes it clear', { enum: DEFAULT_CASE_TYPE_VALUES }),
        },
        required: ['id'],
      },
      async ({ id, ...patch }) => {
        // Validate case_type/priority BEFORE pick()'s empty-string filtering: an
        // explicit case_type:"" must be rejected the same way a bogus value is,
        // not silently dropped as if the field were never supplied -- pick()
        // would otherwise treat an empty-string write as a no-op, which looks
        // like the update succeeded to a caller who doesn't check fieldsRecorded.
        // Live config-declared enum (falls back to the shipped default when the
        // config leaves case_type/priority undeclared), so a deployment's own
        // thatcher.config.yml options are the ones actually enforced, not a
        // second hardcoded copy of the list.
        const caseTypeValues = new Set(store().getFieldEnum('case.case_type', DEFAULT_CASE_TYPE_VALUES))
        const priorityValues = new Set(store().getFieldEnum('case.priority', DEFAULT_PRIORITY_VALUES))
        if ('case_type' in patch && !caseTypeValues.has(patch.case_type)) {
          return { error: `invalid case_type: ${patch.case_type}`, allowed: [...caseTypeValues] }
        }
        if ('priority' in patch && !priorityValues.has(patch.priority)) {
          return { error: `invalid priority: ${patch.priority}`, allowed: [...priorityValues] }
        }
        const clean = pick(patch, ['subject', 'summary', 'priority', 'tags', 'assignee', 'case_type'])
        if (!Object.keys(clean).length) return { error: 'no editable fields supplied' }
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        // Autonomy is operator control: it is set only from the dashboard, never by
        // the agent -- otherwise the agent could flip observe back to auto and
        // escape the very mode an operator used to stop it acting. So in observe
        // mode the agent may only observe; all content edits are blocked.
        if (c.autonomy === 'observe') {
          return { error: 'case autonomy is "observe"; agent edits are disabled. Use case_observe to record notes.' }
        }
        const caseTypeChanged = 'case_type' in clean && (c.case_type || 'unset') !== clean.case_type
        const updated = await store().updateCase(id, clean, AGENT_USER)
        // Audited as its own from/to action, matching the dashboard's own
        // reclassification event shape, so /api/report.json's per-type analytics
        // can trace an agent-driven reclassification the same way as an operator one.
        if (caseTypeChanged) {
          await store().appendEvent(id, {
            kind: 'action', actor: 'agent',
            text: `case_type ${c.case_type || 'unset'} -> ${clean.case_type}`,
            data: { from: c.case_type || 'unset', to: clean.case_type, field: 'case_type' },
          })
        }
        const otherKeys = Object.keys(clean).filter(k => k !== 'case_type')
        if (otherKeys.length) {
          await store().appendEvent(id, { kind: 'action', actor: 'agent', text: `updated ${otherKeys.join(', ')}`, data: Object.fromEntries(otherKeys.map(k => [k, clean[k]])) })
        }
        return { ok: true, case: slimCase(updated) }
      }),
    defTool('case_report', 'cases',
      'Record what you have learned about an animal-disease report, one field at a time, as the farmer gives it. Pass ONLY the fields you actually learned this turn -- they merge into the running report, so you never lose earlier facts and never need to repeat a field the farmer already gave. This is how the organisers see a structured, organised report without the farmer being interrogated. Leave a field out if you do not know it yet; do not guess.',
      {
        type: 'object',
        properties: {
          id: str('Case id'),
          species: str('Animal(s): cattle, sheep, goats, pigs, etc.'),
          symptoms: str('What the farmer sees: drooling, blisters, lameness, sudden death, etc.'),
          location: str('Where: farm name, nearest town, district, GPS, or the farmer\'s own description'),
          how_to_find: str('Directions / landmarks to reach the place in the bush'),
          affected_count: str('How many animals are affected (number or "a few"/"many")'),
          dead_count: str('How many have died, if any'),
          onset: str('When it started and how fast it is spreading'),
          suspected_disease: str('A disease the farmer names or you reasonably infer (record, do not diagnose or alarm)'),
          recent_movement: str('Recent animal movement/contact: auctions, new stock, shared grazing'),
          identifying_traits: str('Markings, ear tags, breed -- anything to identify the animals'),
          access_notes: str('Access/travel notes: gate, road condition, 4x4 needed, permission'),
          farmer_available: str('Will the farmer be there on arrival? When are they reachable?'),
          contact_fallback: str('Who else to contact / another number if the farmer is unreachable'),
          photos: str('Note that the farmer sent a photo (set to a short description). Each call ADDS a new photo note -- if more than one photo arrives, call again with a description of the new one; earlier descriptions are kept, never overwritten.'),
          audio: str('Note that the farmer sent a voice note (set to a short description or transcription). Each call ADDS a new note -- if more than one voice note arrives, call again; earlier notes are kept, never overwritten.'),
          notes: str('Anything else worth recording for the organisers'),
          present_person: str('Who is with the animals right now, if not the owner (e.g. a relative, herder, neighbour)'),
          present_person_relation: str('How the present person is linked to the owner: owner, relative, herder, or neighbour'),
          owner_name: str("The animals' owner's name, if the worker learns it and the owner is not present"),
          owner_contact: str("A number to reach the owner, if the worker learns it and the owner is not present"),
          lat: { type: 'number', description: 'Latitude for the organisers\' map. If the worker reads out real GPS coordinates, use those exactly. Otherwise, use your OWN knowledge to give your best estimate for the place described (a named town, farm, or landmark you can place) -- this is how the case gets a map point at all, so estimate confidently when the description is identifiable; leave both lat and lon out only when the place genuinely cannot be placed from what was said.' },
          lon: { type: 'number', description: 'Longitude, alongside lat -- your own best-effort estimate when no exact GPS was given, using your own knowledge of the place described.' },
          sites: str('ONLY when the worker describes a SECOND distinct place/herd within the SAME visit (not a separate outbreak elsewhere -- use case_new for that): a short plain-text note of the second site, e.g. "5 goats down the road at the old kraal, also drooling". The main species/location fields above stay the first/primary site; this adds the second one alongside it without losing it. Each call with this set ADDS one more site note.'),
        },
        required: ['id'],
      },
      async ({ id, lat, lon, ...fields }, ctx) => {
        // Bind server-side to the turn's active case -- same discipline case_stage
        // already applies. A model error or prompt-injected inbound text naming
        // another case's ref must never be able to write into a stranger's case.
        // Fail CLOSED: a turn with no bound active case has nothing legitimate to
        // check the argument against, so it is rejected too, not let through --
        // otherwise any caller path that fails to populate ctx.activeCaseId (a
        // race before binding, a malformed ctx, a degraded turn) would silently
        // regain the pre-fix trust-the-argument-blindly behaviour this exists to close.
        if (!ctx?.activeCaseId || id !== ctx.activeCaseId) {
          try {
            const logTarget = ctx?.activeCaseId || id
            await store().appendEvent(logTarget, {
              kind: 'observation', actor: 'system',
              text: `SECURITY: case_report called with id=${id} but this turn's active case is ${ctx?.activeCaseId || '(none)'}; write rejected.`,
              data: { attemptedId: id, activeCaseId: ctx?.activeCaseId || null, tool: 'case_report' },
            })
          } catch { /* best effort -- never let the audit write block the rejection */ }
          return { error: ctx?.activeCaseId
            ? `case_report must target this conversation's active case (${ctx.activeCaseId}), not ${id}`
            : 'case_report has no bound active case on this turn -- cannot target an arbitrary case id' }
        }
        const incoming = pick(fields, [...REPORT_KEYS])
        const latLonSupplied = typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon)
        const hasLatLon = latLonSupplied && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
        // A supplied-but-out-of-range coordinate (e.g. swapped lat/lon) must not
        // be silently dropped indistinguishably from "never supplied" -- surface
        // it so the caller/agent can correct it instead of the map pin quietly
        // never appearing with no explanation.
        if (latLonSupplied && !hasLatLon) {
          return { error: `lat/lon out of range: lat=${lat}, lon=${lon} (expected |lat|<=90, |lon|<=180)` }
        }
        if (!Object.keys(incoming).length && !hasLatLon) return { error: 'no report fields supplied' }
        // Snapshot the PRIOR value of every field this call touches, before the
        // merge, so a correction (a field already non-null being overwritten) is
        // distinguishable in the timeline from a first-time fill -- mirrors
        // case_update's existing case_type a->b change-tracking pattern. Read
        // once, best-effort: a read failure here must never block the actual
        // write below (audit-trail richness, not the write itself, is at stake).
        let priorReport = {}
        if (Object.keys(incoming).length) {
          try { const c0 = await store().getCase(id); priorReport = c0?.report ? JSON.parse(c0.report) : {} } catch { priorReport = {} }
        }
        let res = { report: null }
        if (Object.keys(incoming).length) {
          // Atomic read-merge-write in the store, under the per-conversation lock, so
          // two concurrent agent turns for the same case cannot read the same stale
          // report and clobber each other's fields. Later messages refine earlier
          // ones; a field already given is never lost.
          res = await store().mergeReport(id, incoming, AGENT_USER)
          if (res.error === 'observe') return { error: 'case autonomy is "observe"; agent edits are disabled. Use case_observe to record notes.' }
          if (res.error) return { error: res.error }
        }
        // lat/lon are real case columns, not report JSON, and the model's own
        // estimate (or the worker's exact GPS) is the ONLY source -- casey does
        // no server-side lookup. A later, more specific case_report call simply
        // overwrites the coordinate with the model's improved estimate.
        if (hasLatLon) {
          const c = await store().getCase(id)
          if (c?.autonomy === 'observe') return { error: 'case autonomy is "observe"; agent edits are disabled. Use case_observe to record notes.' }
          await store().updateCase(id, { lat, lon }, AGENT_USER)
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
        const fieldsRecorded = [...Object.keys(incoming), ...(hasLatLon ? ['lat', 'lon'] : [])]
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
        return { ok: true, report: res.report, fieldsRecorded }
      }),
    defTool('case_observe', 'cases',
      'Record an observation or internal note on the case timeline WITHOUT replying to the contact. Use for triage reasoning, flags, or anything an operator should see.',
      {
        type: 'object',
        properties: { id: str('Case id'), text: str('The observation') },
        required: ['id', 'text'],
      },
      async ({ id, text }) => {
        await store().appendEvent(id, { kind: 'observation', actor: 'agent', text })
        return { ok: true }
      }),
    // (case_intent was deleted: it was a record-only stub whose INTENT-DECLARED
    // marker nothing read after the pure-LLM strip -- an enquiry declared through it
    // produced NOTHING. The prompt now directs the model straight to the real data
    // tools: case_today / case_mine / case_list / case_get. case_stage stays -- the
    // dstate loop DOES read its STAGE-DECLARED marker.)
    defTool('case_transition', 'cases',
      'Move the case to a new workflow stage. Valid targets depend on current stage (new->triaging->in_progress->waiting->resolved->closed, with reopen paths). Call case_get first if unsure. Honour the case autonomy setting.',
      {
        type: 'object',
        properties: {
          id: str('Case id'),
          to: str('Target stage', { enum: DEFAULT_STAGE_VALUES }),
          reason: str('Why you are transitioning (recorded on the timeline)'),
        },
        required: ['id', 'to'],
      },
      async ({ id, to, reason = '' }) => {
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        if (c.autonomy === 'observe') return { error: 'case autonomy is "observe"; transitions are operator-only' }
        try {
          await store().transition(id, to, { user: AGENT_USER, reason })
          return { ok: true, from: c.status, to }
        } catch (e) {
          return { error: e.message }
        }
      }),
    defTool('case_transitions_available', 'cases',
      'List the workflow stages you are allowed to move this case to right now.',
      { type: 'object', properties: { id: str('Case id') }, required: ['id'] },
      async ({ id }) => {
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        const avail = store().availableTransitions(c, AGENT_USER)
        return { current: c.status, available: avail }
      }),
    defTool('case_link_suggestions', 'cases',
      'Find OTHER open cases that look like they may describe the same real-world situation as this one -- same place, same animals, a shared contact or fallback number, reported around the same time. Returns ranked candidates with the reasons for each, strongest first, for a human to review -- this never merges anything itself; only an operator decides whether two reports should become one case.',
      { type: 'object', properties: { id: str('Case id to find matches for'), limit: { type: 'number', default: 5 } }, required: ['id'] },
      async ({ id, limit = 5 }) => {
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        const { suggestLinks } = await import('./correlate.js')
        // Scan a recent window of cases; exclude closed and already-merged ones --
        // suggesting a merge into a closed/merged shell would be noise.
        const pool = (await store().listCases({}, { limit: 200 }))
          .filter(o => o.id !== id && o.status !== 'closed'
            && !((o.tags || '').split(',').map(s => s.trim()).includes('merged')))
        // Score against the raw case rows, not slimCase projections -- slimCase
        // drops external_id and created_at, which correlationScore needs for
        // its same-contact/fallback-number/time-proximity signals. suggestLinks
        // only ever returns {id, ref, score, reasons}, so no extra PII reaches
        // the caller even though the scoring inputs are the full rows.
        const suggestions = suggestLinks(c, pool).slice(0, limit)
        return { count: suggestions.length, suggestions }
      }),
    // case_merge is deliberately NOT exposed here. Folding two reports together
    // is a judgment about whether they describe the same real-world situation --
    // exactly the kind of call this system leaves to a human working from the
    // full picture, never to the agent acting on one conversation alone. The
    // dashboard's own merge endpoint (POST /api/cases/:id/merge) calls
    // store.mergeCases directly as the operator, entirely independent of this
    // toolset; case_link_suggestions below still lets the agent surface a
    // possible match for a human to review, it just never acts on it.
    defTool('case_split', 'cases',
      'Carve a set of timeline events out of a case into a NEW case, when one thread actually holds TWO separate outbreaks (e.g. a contact reported a second, unrelated sick herd). The named events move to the new case; both are linked. Get event ids from case_get.',
      {
        type: 'object',
        properties: {
          id: str('Case id to split FROM'),
          event_ids: { type: 'array', items: { type: 'string' }, description: 'Ids of the events to move into the new case' },
          subject: str('Short title for the new case'),
          reason: str('Why these belong to a separate outbreak (recorded on both timelines)'),
        },
        required: ['id', 'event_ids'],
      },
      async ({ id, event_ids, subject = '', reason = '' }) => {
        const res = await store().splitCase(id, event_ids, { subject, reason }, AGENT_USER)
        if (res.error === 'observe') return { error: 'case autonomy is "observe"; splitting is operator-only' }
        if (res.error) return { error: res.error }
        return { ok: true, movedEvents: res.movedEvents, newCase: slimCase(res.newCase) }
      }),
    defTool('case_health', 'cases',
      'Check whether a case is going wrong over time -- stale (no activity), stuck in a stage too long, an unanswered request for a person, an abandoned intake with on-site facts still missing, or resolved-but-never-closed. Returns the current guardrail breaches with how long each has been true. Use it to decide what needs attention.',
      { type: 'object', properties: { id: str('Case id') }, required: ['id'] },
      async ({ id }) => {
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        const { classifyCaseHealth } = await import('./case-health.js')
        const breaches = classifyCaseHealth(c, Date.now())
        return { id, status: c.status, healthy: breaches.length === 0, breaches }
      }),
    // ---- worker-enquiry surface: answer FOR the asking worker (ctx.author), scoped
    // and PII-free (enquiryRow). ctx carries {author, principal, activeCaseRef} that
    // casey builds per turn in gateway-hooks; scoping is by the assignee owner field.
    defTool('case_mine', 'cases',
      "List the asking worker's OWN open cases (their itinerary). PII-free.",
      { type: 'object', properties: { limit: { type: 'number', default: 25 } } },
      async ({ limit = 25 }, ctx) => {
        // Scope by REPORTER, not assignee: a worker's cases are the ones they reported
        // (the per-contact external_id 'channel:author' or the bare author), never an
        // operator assignee -- an assignee scope returned nothing for the asking worker.
        // enquiryRow strips external_id, so filtering on it never leaks it.
        const rows = await mineRows(store(), ctx, limit)
        if (rows?.error) return rows
        return { count: rows.length, cases: rows.map(enquiryRow) }
      }),
    defTool('case_today', 'cases',
      "List cases active today for the asking worker (today's list). PII-free.",
      { type: 'object', properties: { limit: { type: 'number', default: 25 } } },
      async ({ limit = 25 }, ctx) => {
        // The worker's OWN open cases, most-recently-active first (recency-sorted) --
        // "today" is the practical itinerary of what is live for them. Reporter-scoped.
        const rows = await mineRows(store(), ctx, limit)
        if (rows?.error) return rows
        return { count: rows.length, cases: rows.map(enquiryRow) }
      }),
    // Casual, self-reported location check-in for a field worker -- DISTINCT from
    // a CASE's lat/lon (an animal-report location, see case_report). This is the
    // WORKER's own current position, a live coverage/dispatch signal: it shows
    // them on the operator map (dashboard-worker-location-map-layer) so a team
    // can direct/dispatch them, and lets a later "anything near me" enquiry use
    // it as the near-lookup origin (near-me-lookup-for-field-workers) without
    // re-describing their location every time. field_worker-tier only (gated by
    // gateByTier below like every other non-report tool) -- a casual public
    // reporter has no reason to broadcast standing location.
    defTool('case_checkin', 'cases',
      "Record the FIELD WORKER's own current location (not an animal report's location) -- call this when they say where they are now, e.g. 'I'm at the clinic', 'just arrived at the Bela-Bela farm', or share GPS. Shows them on the team's map and lets a later 'anything near me' question use this as the starting point.",
      {
        type: 'object',
        properties: {
          lat: { type: 'number', description: 'Latitude of where the worker is now (their own best estimate for a described place, or exact if they shared GPS)' },
          lon: { type: 'number', description: 'Longitude of where the worker is now' },
        },
        required: ['lat', 'lon'],
      },
      async ({ lat, lon }, ctx) => {
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
          return { error: 'lat/lon must be finite numbers in range (lat -90..90, lon -180..180)' }
        }
        const author = ctx?.author || ctx?.principal?.id
        if (!author) return { error: 'no author on this turn -- cannot attribute a check-in' }
        const contact = ctx?.store?.findOrCreateContact
          ? await ctx.store.findOrCreateContact({ channel: ctx.channel || 'other', external_id: author })
          : null
        if (!contact?.id) return { error: 'could not resolve the contact record for this check-in' }
        await store().t.update('contact', contact.id, {
          last_location_lat: lat, last_location_lon: lon, last_location_at: new Date().toISOString(),
        }, { id: 'casey-agent', role: 'agent' })
        return { ok: true }
      }),
    // The agent declares its conversation phase; the gateway reads the STAGE-DECLARED
    // observation back and applies the durable dstate transition. Append-only, keeps
    // the state I/O in casey. Mirrors freddie's case_stage.
    defTool('case_stage', 'cases',
      'Declare which phase the conversation is now in: greeting (a warm opener), gathering (collecting the report), enquiring (the worker asked about their work), answering (a general question), complete (the report is on record), handoff (a person is needed), or closed (they asked to stop). Call this when the phase changes so you keep your place and never repeat a question.',
      { type: 'object', properties: { to: str('Conversation phase', { enum: CONVERSATION_PHASES }) }, required: ['to'] },
      async ({ to }, ctx) => {
        const id = ctx?.activeCaseId
        if (!id) return { error: 'no active case' }
        await store().appendEvent(id, { kind: 'observation', actor: 'agent', text: `STAGE-DECLARED ${to}` })
        return { ok: true, stage: to }
      }),
    defTool('case_new', 'cases',
      'Open a NEW case for the worker and bind it active. Use ONLY when the worker is clearly starting a fresh report (a different animal/place/incident), never to auto-open one.',
      { type: 'object', properties: { subject: str('Optional short subject') } },
      async ({ subject }, ctx) => {
        const author = ctx?.author || ctx?.principal?.id
        if (!store().createCase) return { error: 'store does not support explicit case creation' }
        // Reuse THIS turn's own (channel, external_id) -- the real conversation
        // key findOrCreateCase actually binds on -- rather than inventing a
        // synthetic id, so the very next plain inbound message from this
        // worker correctly lands on the freshly-opened case (findOpenCase's
        // newest-open-case-wins rule), not the old one it just moved on from.
        const current = ctx?.activeCaseId ? await store().getCase(ctx.activeCaseId) : null
        const channel = current?.channel || ctx?.channel || 'other'
        const external_id = current?.external_id
        if (!external_id) return { error: 'no conversation identity on this turn -- cannot bind a new case' }
        const c = await store().createCase({ channel, external_id, subject: subject || '', contact_id: current?.contact_id || '' })
        await store().appendEvent(c.id, { kind: 'note', actor: 'system', text: `case explicitly opened for a fresh report by ${author || 'unknown'}` })
        return { ok: true, activeCase: enquiryRow(c) }
      }),
    // Ownership-gated re-bind of the conversation's active case by ref -- lets a
    // worker with multiple open cases explicitly say "go back to CASE-1042" or
    // "switch to the goat case" and have the agent actually target it, instead
    // of every subsequent case_report/case_stage call silently continuing to
    // hit whatever case findOrCreateCase happened to bind this turn. Ownership
    // gated the same way case_get/mineRows already are: a worker may only
    // switch onto a case they themselves reported.
    defTool('case_switch', 'cases',
      'Re-bind the conversation to a DIFFERENT one of the worker\'s own open cases by ref (e.g. "CASE-1042"). Use when the worker names a case they want to continue, other than the one currently active. Confirms the switch back to them.',
      { type: 'object', properties: { ref: str('The case ref to switch to, e.g. CASE-1042') }, required: ['ref'] },
      async ({ ref }, ctx) => {
        const author = ctx?.author || ctx?.principal?.id
        if (!author) return { error: 'no author on this turn -- cannot resolve ownership for a switch' }
        const target = typeof store().getCaseByRef === 'function'
          ? await store().getCaseByRef(ref)
          : (await store().listCases({}, { limit: 500 })).find(c => c.ref === ref)
        if (!target) return { error: `no case found with ref ${ref}` }
        if (!ownsCase(target.external_id, author)) {
          return { error: `case ${ref} does not belong to you -- cannot switch to it` }
        }
        return { ok: true, activeCase: enquiryRow(target), confirm: `Switched to ${target.ref}.` }
      }),
    // No autonomy=observe guard here, unlike case_update/case_transition: opt-out
    // is an irreversible LEGAL control (matching gateway-hooks.js's deterministic
    // STOP short-circuit), not a content edit -- it must register regardless of
    // autonomy, so an observe-mode contact's opt-out is never silently dropped.
    defTool('case_stop', 'cases',
      'The person asked to STOP receiving messages (opt out). Records the opt-out. Use ONLY on a clear opt-out.',
      { type: 'object', properties: { id: str('Case id') }, required: ['id'] },
      async ({ id }, ctx) => {
        // Same server-side active-case binding as case_report: an irreversible
        // control is exactly the kind of write that must never land on the wrong
        // case from a model mistake or injected text naming another case's ref.
        // Fail CLOSED: a missing ctx.activeCaseId is itself a rejection condition,
        // never a bypass -- see case_report's handler for the full reasoning.
        if (!ctx?.activeCaseId || id !== ctx.activeCaseId) {
          try {
            const logTarget = ctx?.activeCaseId || id
            await store().appendEvent(logTarget, {
              kind: 'observation', actor: 'system',
              text: `SECURITY: case_stop called with id=${id} but this turn's active case is ${ctx?.activeCaseId || '(none)'}; write rejected.`,
              data: { attemptedId: id, activeCaseId: ctx?.activeCaseId || null, tool: 'case_stop' },
            })
          } catch { /* best effort */ }
          return { error: ctx?.activeCaseId
            ? `case_stop must target this conversation's active case (${ctx.activeCaseId}), not ${id}`
            : 'case_stop has no bound active case on this turn -- cannot target an arbitrary case id' }
        }
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        const tags = String(c.tags || '').split(',').map(s => s.trim()).filter(Boolean)
        if (!tags.includes('opted-out')) tags.push('opted-out')
        await store().updateCase(id, { tags: tags.join(',') })
        await store().appendEvent(id, { kind: 'observation', actor: 'agent', text: 'OPT-OUT: the person asked to stop; no more automatic replies.' })
        return { ok: true }
      }),
    // Same reasoning as case_stop: a handoff request is an irreversible legal
    // control, not a content edit, so it deliberately bypasses the observe guard.
    defTool('case_handoff', 'cases',
      'The person wants a real person / operator to help. Flags the case for a human. Use on a clear ask for a person.',
      { type: 'object', properties: { id: str('Case id') }, required: ['id'] },
      async ({ id }, ctx) => {
        // Fail CLOSED: a missing ctx.activeCaseId is itself a rejection condition,
        // never a bypass -- see case_report's handler for the full reasoning.
        if (!ctx?.activeCaseId || id !== ctx.activeCaseId) {
          try {
            const logTarget = ctx?.activeCaseId || id
            await store().appendEvent(logTarget, {
              kind: 'observation', actor: 'system',
              text: `SECURITY: case_handoff called with id=${id} but this turn's active case is ${ctx?.activeCaseId || '(none)'}; write rejected.`,
              data: { attemptedId: id, activeCaseId: ctx?.activeCaseId || null, tool: 'case_handoff' },
            })
          } catch { /* best effort */ }
          return { error: ctx?.activeCaseId
            ? `case_handoff must target this conversation's active case (${ctx.activeCaseId}), not ${id}`
            : 'case_handoff has no bound active case on this turn -- cannot target an arbitrary case id' }
        }
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        const tags = String(c.tags || '').split(',').map(s => s.trim()).filter(Boolean)
        if (!tags.includes('needs-human')) tags.push('needs-human')
        await store().updateCase(id, { tags: tags.join(',') })
        await store().appendEvent(id, { kind: 'observation', actor: 'agent', text: 'HANDOFF REQUESTED: the person asked for a real person.' })
        return { ok: true }
      }),
  ]
  return tools.map(gateByTier)
}

// Tier gate: a 'reporter'-tier contact (casual/public, report-only per the
// operator-assignable access-tier design) can report an incident and use the
// two irreversible safety controls, but cannot agentically QUERY the case
// database -- case_list with a location filter, for instance, would let an
// anonymous public contact enumerate other reporters' case locations even
// through the PII-free projection. Only 'field_worker'-tier contacts (and the
// dashboard/CLI, which never go through this per-turn toolCtx path at all)
// reach the query/mutation tools. REPORT_ONLY_TOOLS are available at every
// tier: case_report (the whole point of a reporter existing), case_stage
// (internal dstate bookkeeping, not a data-access concern), case_stop/
// case_handoff (opt-out/human-escalation, service controls not data access),
// case_new (opening a fresh case for a genuinely new situation -- the
// never-a-dead-end design principle applies to every reporter, not only
// field workers; without this, a reporter's second unrelated report has no
// tool to branch and silently overwrites the first via mergeReport's
// fill-if-empty semantics). case_split stays field_worker-only: it edits an
// EXISTING case's already-recorded history, a materially different risk
// than opening a brand new empty one.
const REPORT_ONLY_TOOLS = new Set(['case_report', 'case_stage', 'case_stop', 'case_handoff', 'case_new'])
function gateByTier(tool) {
  if (REPORT_ONLY_TOOLS.has(tool.name)) return tool
  const handler = tool.handler
  return {
    ...tool,
    handler: async (args, ctx) => {
      // FAIL CLOSED: allow-list, not deny-list. A ctx built with no tier at all
      // (a missing/undefined value, not merely a wrong one) must NOT fall through
      // to full access -- only an EXPLICIT 'field_worker' tier proceeds. The prior
      // `if (ctx?.tier && ctx.tier !== 'field_worker')` shape only denied when a
      // tier was present and wrong, silently granting full access to any caller
      // whose ctx carried no tier property whatsoever.
      //
      // The result text is deliberately NOT an explanation of internal
      // permissions/tools/tiers -- a model that sees a tool-shaped "requires
      // field-worker access" string has repeatedly composed a reply that
      // parrots that exact internal language back to the contact (witnessed:
      // "I don't have the necessary permissions to access the case list"),
      // which the outbound jargon scrub then holds as an unsent draft, leaving
      // the contact with silence. This tells the model plainly, in
      // conversational terms, to drop the query and keep going -- nothing here
      // is safe or useful to relay to the person messaging in.
      if (ctx?.tier !== 'field_worker') {
        return { unavailable: true, note: 'This is not something you can look up for this person. Do not mention tools, permissions, or access -- just continue the conversation naturally: report their case, or answer using what you already know from this conversation.' }
      }
      return handler(args, ctx)
    },
  }
}

// Great-circle distance in km between two lat/lon points (haversine). Used by the
// proximity enquiry (case_list `near`) so "closest case" can be answered from the
// real tool result. Coordinates are model-estimated (the agent's own best guess
// for a described place), so the distance is best-effort, not surveyed exact.
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function slimCase(c) {
  if (!c) return null
  const { id, ref, channel, status, priority, subject, summary, report, tags, assignee, autonomy, last_event_at } = c
  // Parse the report so the agent reads it as structured fields (and knows which
  // it already has, so it never re-asks). Tolerate a malformed/empty report.
  let reportObj = null
  try { reportObj = report ? JSON.parse(report) : null } catch { reportObj = null }
  return { id, ref, channel, status, priority, subject, summary, report: reportObj, tags, assignee, autonomy, last_event_at }
}
// PII-FREE projection for a LIST row (an enquiry spanning cases the asker may not
// own). Keeps only ref/status/species/location -- NEVER the full report object, which
// carries owner_name/contact_fallback/present_person and other contact-supplied free
// text that must not reach the model context (and thence a reply) for a case the
// worker does not own. species/location are flattened out of the report so a place/
// species list still reads naturally without exposing the rest.
function enquiryRow(c, distanceKm) {
  if (!c) return null
  let report = {}
  try { report = c.report ? JSON.parse(c.report) : {} } catch { report = {} }
  return {
    id: c.id, ref: c.ref, status: c.status, priority: c.priority,
    species: report.species || null, location: report.location || null,
    assignee: c.assignee || null, last_event_at: c.last_event_at,
    ...(typeof distanceKm === 'number' ? { distance_km: distanceKm } : {}),
  }
}
function slimEvent(e) {
  return { kind: e.kind, actor: e.actor, text: e.text, at: e.created_at }
}
// The asking worker's OWN open cases: reporter-scoped. The per-contact case
// external_id is 'container:author' (a multi-author channel) or the bare author
// (a 1:1 chat), so a worker's own cases are those whose external_id CONTAINS their
// author id. We pull the open set and JS-filter (external_id is not always a clean
// equality key across channels), most-recently-active first, capped.
async function mineRows(store, ctx, limit) {
  const author = ctx?.author || ctx?.principal?.id
  // Read the live config-declared open-stage set (case-sweep.js's own pattern)
  // rather than a hardcoded literal list, so a custom/renamed workflow stage in
  // thatcher.config.yml is picked up with no code edit -- a hardcoded list here
  // silently hides a worker's own claimed case from "my cases" on such a deployment.
  const openStatuses = typeof store.getOpenStatuses === 'function'
    ? store.getOpenStatuses()
    : ['new', 'triaging', 'in_progress', 'waiting']
  const open = await store.listCases({ status: { $in: openStatuses } }, { limit: Math.max(limit * 10, 200) })
  // Fail CLOSED like case_get already does: no author on ctx means we cannot
  // prove which cases are "mine", so return nothing rather than defaulting to
  // everyone's open cases (a prior shape here silently handed back the whole
  // open set -- a cross-contact leak of case existence/species/location -- to
  // any caller whose ctx happened to carry no author).
  if (!author) return { error: 'no author on this turn -- cannot resolve "my cases"' }
  const mine = open.filter(c => ownsCase(c.external_id, author))
  return mine.slice(0, limit)
}
function pick(obj, keys) {
  const out = {}
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== '' && String(obj[k]).trim() !== '') out[k] = obj[k]
  return out
}
