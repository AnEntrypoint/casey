// Core case CRUD + operator actions: list/create/get/patch/transition/bulk/
// snooze/undo/note/intake/events, plus reply/draft-approve/draft-discard and
// merge/split/suggestions/site-history. This is the single largest route
// group (the case is casey's central entity), matching AGENTS.md's case-store
// facade -- everything here is a thin HTTP wrapper over CaseStore methods.
//
// Shape: module-level named handler factories plus the ROUTES table at the
// bottom, mounted through routes/register.js's mountRoutes -- the same shape
// the other five route modules use. It used to be one 854-line registerCases
// closure holding all 21 handlers inline, the largest remaining function in
// the dashboard and the only route module inconsistent with its siblings.
// Note what that change is NOT: the two projections below were ALREADY
// module-level before the split (register.js's own header comment says the
// PII projections sat inside the register closure -- true of the five
// modules it describes, never true of this one), so no security property
// moved. Registration order is preserved exactly as it was: GET
// /api/cases/export.csv still registers before GET /api/cases/:id, or express
// captures 'export.csv' as an id.
//
// deps: store, wrap, esc, str, clampLimit, offsetOf, actingOperator, authed,
//   AUTONOMY, PRIORITY, CASE_TYPE, REPORT_KEY_LIST, REPORT_KEY_SET,
//   computeFillRate, csvCell, parseJsonArraySafe, parseEventData, isOpenCase,
//   getRoster, sendReply, UNCLAIMED_ASSIGNEE, printableReport
import { tagList, parseReport } from '../../timestamp.js'
import { mergeTag, dropTag } from '../../hooks/heuristics.js'
import { fmtPhone27 } from '../../format.js'
import { fieldLabel, REPORT_FIELD_DEFS } from '../../store/report-shape.js'
import { BRAND } from '../brand.js'
import { mountRoutes } from './register.js'

// The two projections below are the ONLY way a raw thatcher case row may reach
// a JSON response. Both are explicit allowlists, never a spread of the row, so
// a column added to the case table is never auto-exposed -- the raw row also
// carries author_key (the contact number a SECOND time), lat/lon, _version,
// created_by and transition_reason, none of which any client asked for.
//
// WHAT THE PII RULE ACTUALLY MEANS. AGENTS.md's "Enquiries and status are
// PII-free -- every WORKER-facing projection excludes external_id/contact_id"
// is a rule about the reporter-facing surface (in casey, "worker" is the field
// worker who reports, see AGENTS.md's own "the reporter is usually a field
// worker"), i.e. the agent's channel replies and the enquiry/aggregate
// rollups; glossary.js says the same thing in the operator's own words --
// external_id is "never shown to a field worker for privacy". It was never a
// rule about the authenticated operator console, and this codebase already
// says so in three places: map.js's dispatch handler records that "case
// timelines are operator-facing, not PII-scrubbed", contacts.js's
// publicContact() hands every authed operator external_id_formatted for every
// contact, and this file's own /api/cases/:id/report.html renders a `tel:`
// "Call contact" link. An operator who cannot ring back the person reporting a
// dying herd cannot do the job, and stripping the case-detail affordance while
// /api/contacts still serves the same number would reduce no exposure at all.
//
// So the line is drawn at SHAPE, not at secrecy: the raw routing key
// (external_id), the same number again (author_key) and the internal join key
// (contact_id) are never emitted by either projection. A single case the
// operator has explicitly opened additionally carries the DISPLAY form of the
// contact number, through the same formatter contacts.js already uses.
export function caseListProjection(c) {
  if (!c) return null
  const { id, ref, channel, status, priority, subject, summary, report, tags, assignee, autonomy, last_event_at, fill_rate, created_at, case_type } = c
  return { id, ref, channel, status, priority, subject, summary, report, tags, assignee, autonomy, last_event_at, fill_rate, created_at, case_type }
}

// Single-case projection: GET /api/cases/:id, PATCH /api/cases/:id and
// POST /api/cases/:id/transition, which MUST agree. They did not: the two
// writes returned the raw row while the read projected it away, so the case
// header's "copy contact" button worked for exactly one render after an edit
// and was empty on every reload -- a broken affordance AND a leak at the same
// time. The list stays PII-free deliberately: case-list-view.js's client
// filter and filters-bar.js's search placeholder both record that /api/cases
// carries no contact number and that the search must not promise one, and a
// 50-row poll is no place to move 50 phone numbers.
export function caseDetailProjection(c) {
  if (!c) return null
  return { ...caseListProjection(c), external_id_formatted: fmtPhone27(c.external_id) }
}

// The latest pending assisted-mode draft for a case, or null. A draft is
// "pending" only while draft-pending is on the case (cleared on
// approve/discard/supersede), so we read the most recent draft event and gate
// on the tag rather than tracking draft state separately.
async function pendingDraft(store, c) {
  const tags = tagList(c)
  if (!tags.includes('draft-pending')) return null
  const events = await store.listEvents(c.id)
  const drafts = events.filter(e => e.kind === 'draft')
  return drafts.length ? drafts[drafts.length - 1] : null
}

export function getCases({ store, authed, clampLimit, offsetOf, computeFillRate, REPORT_KEY_LIST }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const where = {}
    if (req.query.status) {
      // Validate against the workflow's real statuses so an arbitrary
      // ?status=anything 400s here instead of silently reaching thatcher.
      const valid = store.getValidStatuses()
      if (!valid.includes(req.query.status)) {
        return res.status(400).json({ error: `invalid status: ${req.query.status}`, allowed: valid })
      }
      where.status = req.query.status
    }
    if (req.query.channel) {
      if (typeof req.query.channel !== 'string') return res.status(400).json({ error: 'invalid channel' })
      where.channel = req.query.channel
    }
    // ?ref= is a direct-lookup shortcut (used by shareable ref deep-links)
    if (req.query.ref) {
      const ref = String(req.query.ref).slice(0, 50)
      const found = await store.getCaseByRef(ref)
      const casesWithFill = found ? [{ ...found, fill_rate: computeFillRate(found.report) }] : []
      return res.json({ cases: casesWithFill.map(c => caseListProjection({ ...c })), total: casesWithFill.length, limit: casesWithFill.length, offset: 0 })
    }
    const q = req.query.q ? String(req.query.q).slice(0, 200).toLowerCase() : ''
    const limit = clampLimit(req.query.limit, 50)
    const offset = offsetOf(req.query.offset)
    let cases, total
    if (q) {
      // Search across case fields + all report field values. Fetch the full set
      // (capped at 10000) then filter in Node so report JSON is reachable.
      // Search uses external_id for operator convenience (matching on contact id),
      // but external_id is NOT returned in the response (PII gate in caseListProjection).
      const all = await store.listCases(where, { limit: 10000, offset: 0 })
      const filtered = all.filter(c => {
        const hay = [c.ref, c.subject, c.summary, c.external_id, c.channel].join(' ').toLowerCase()
        if (hay.includes(q)) return true
        const r = parseReport(c)
        return REPORT_KEY_LIST.some(k => r[k] != null && String(r[k]).toLowerCase().includes(q))
      })
      total = filtered.length
      cases = filtered.slice(offset, offset + limit)
    } else {
      cases = await store.listCases(where, { limit, offset })
      total = await store.countCases(where)
    }
    const casesWithFill = cases.map(c => ({ ...c, fill_rate: computeFillRate(c.report) }))
    res.json({ cases: casesWithFill.map(c => caseListProjection(c)), total, limit, offset })
  }
}

// Create a case manually from the dashboard (non-AI intake flow).
// channel is forced to 'web'; external_id is synthesised from the contact phone
// (or a timestamp if none given) so it does not collide with channel messages.
export function postCase({ store, authed, str, actingOperator, computeFillRate }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const subject = str(res, req.body, 'subject', { required: false }); if (subject === undefined) return
    const name = str(res, req.body, 'name', { required: false }); if (name === undefined) return
    const phone = str(res, req.body, 'phone', { required: false }); if (phone === undefined) return
    // SA phone validation: 0XXXXXXXXX (10 digits) or +27XXXXXXXXX (11 digits after +)
    if (phone) {
      const digits = phone.replace(/[\s\-()]/g, '')
      const valid = /^0[0-9]{9}$/.test(digits) || /^\+27[0-9]{9}$/.test(digits)
      if (!valid) return res.status(400).json({ error: 'Phone must be a South African number: 0821234567 or +27821234567' })
    }
    // external_id must be stable for dedup; normalise phone digits (keep leading +)
    // then fall back to web-<ms> if normalisation yields empty (e.g. '+' only).
    const normPhone = phone ? phone.replace(/[\s\-()]/g, '') : ''
    const external_id = normPhone && /^[+0-9]/.test(normPhone) ? normPhone : `web-${Date.now()}`
    const contact = { name: name || 'operator', phone: phone || '' }
    const { case: c, created } = await store.findOrCreateCase({ channel: 'web', external_id, contact, subject: subject || 'Field report' })
    // If a case already exists for this phone, return 409 so the client can offer to open it
    if (!created) {
      return res.status(409).json({ error: 'A case already exists for this contact', existing_id: c.id, existing_ref: c.ref })
    }
    // Tag it as operator-initiated manual intake
    const op = actingOperator(req)
    const tags = tagList(c)
    if (!tags.includes('intake_mode:manual')) {
      const newTags = [...tags, 'intake_mode:manual'].join(',')
      await store.updateCase(c.id, { tags: newTags }, op)
    }
    await store.appendEvent(c.id, { kind: 'action', actor: 'operator', text: 'case created via dashboard manual intake', data: { by: op.id } })
    const createdCase = await store.getCase(c.id)
    res.status(201).json(caseListProjection({ ...createdCase, fill_rate: computeFillRate(createdCase.report) }))
  }
}

// CSV export. Registered BEFORE /api/cases/:id in the table below so express
// does not capture 'export.csv' as an id.
export function getCasesCsv({ store, authed, csvCell, REPORT_KEY_LIST }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const where = {}
    if (req.query.status) {
      const valid = store.getValidStatuses()
      if (!valid.includes(req.query.status)) return res.status(400).json({ error: `invalid status: ${req.query.status}` })
      where.status = req.query.status
    }
    if (req.query.channel) {
      if (typeof req.query.channel !== 'string') return res.status(400).json({ error: 'invalid channel' })
      where.channel = req.query.channel
    }
    const cases = await store.listCases(where, { limit: 10000, offset: 0 })
    const META = ['ref', 'subject', 'status', 'priority', 'channel', 'created_at']
    const headers = [...META, 'intake_source', ...REPORT_KEY_LIST]
    const rows = cases.map(c => {
      let r = parseReport(c)
      const tagArr = tagList(c)
      const intakeSrc = tagArr.includes('intake_mode:manual') ? 'manual' : tagArr.includes('intake_mode:public_form') ? 'public_form' : tagArr.includes('intake_mode:channel') ? 'channel' : 'unknown'
      return [...META.map(k => csvCell(c[k])), csvCell(intakeSrc), ...REPORT_KEY_LIST.map(k => csvCell(r[k]))].join(',')
    })
    const csv = [headers.join(','), ...rows].join('\n')
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', 'attachment; filename="casey-cases.csv"')
    res.send(csv)
  }
}

export function getCaseDetail({ store, authed, clampLimit, parseEventData, actingOperator, computeFillRate, parseJsonArraySafe, getRoster, UNCLAIMED_ASSIGNEE }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const c = await store.getCase(req.params.id)
    if (!c) return res.status(404).json({ error: 'not found' })
    const events_total = await store.countEvents(c.id)
    // newest window first by default; UI loads older via /events?offset=
    const limit = clampLimit(req.query.events_limit, 50)
    const events = parseEventData(await store.listEventsPage(c.id, { limit, offset: 0 }))
    const transitions = store.availableTransitions(c, actingOperator(req))
    const report_fill_rate = computeFillRate(c.report)
    // A suggested (never forced) assignee for an unclaimed case: the learned
    // operator whose working-area history most overlaps this case's report
    // location. Purely advisory -- the operator still clicks Claim; casey never
    // auto-assigns. null when the case is already claimed or no operator's
    // learned areas overlap.
    let suggested_assignee = null
    const unclaimed = !c.assignee || c.assignee === UNCLAIMED_ASSIGNEE
    if (unclaimed) {
      let report = parseReport(c)
      if (report.location) {
        const loc = String(report.location).toLowerCase()
        const identities = await store.listOperatorIdentities()
        let best = null
        for (const row of identities) {
          const areas = parseJsonArraySafe(row.areas)
          const hit = areas.find(a => loc.includes(a.token))
          if (hit && (!best || hit.count > best.count)) best = { operator_id: row.operator_id, token: hit.token, count: hit.count }
        }
        if (best) {
          const op = (await getRoster()).find(o => o.id === best.operator_id)
          suggested_assignee = { id: best.operator_id, name: op?.name || best.operator_id, matched_area: best.token }
        }
      }
    }
    // Agent-suggested vs operator-confirmed marker for case_type (the field
    // casey may only fill from a directly-stated fact, never its own inference
    // -- see case-tools.js's report-not-assert paradigm). suspected_disease
    // needs no separate marker here: it is a normal report field, and
    // report-sections.js's existing fieldSources()/ReportField AI-Manual-Both
    // chip already derives the identical agent-vs-operator provenance from
    // this same audit trail for every report field generically -- duplicating
    // that logic server-side for one field would be two sources of truth for
    // the same fact. case_type has no such marker today because it is a case
    // column, not a report field, so ReportField never touches it. Both agent
    // and operator writes are audited as a from/to action with
    // field:'case_type' (case-tools.js case_update / this file's own PATCH
    // handler below); the LAST such action's actor decides the source, since a
    // later operator correction supersedes an earlier agent guess.
    const caseTypeAction = events.find(e => e.kind === 'action' && e.data?.field === 'case_type')
    const case_type_source = c.case_type && c.case_type !== 'unset'
      ? (caseTypeAction ? caseTypeAction.actor : 'agent')
      : null
    res.json({ case: caseDetailProjection(c), events, events_total, transitions, report_fill_rate, suggested_assignee, case_type_source })
  }
}

// Submit structured report fields for a case (non-AI intake or operator correction).
// Merges into the existing report; blank incoming values never clobber filled ones.
export function postIntake({ store, authed, str, REPORT_KEY_LIST, REPORT_KEY_SET, actingOperator, computeFillRate }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const c = await store.getCase(req.params.id)
    if (!c) return res.status(404).json({ error: 'not found' })
    const incoming = {}
    for (const k of REPORT_KEY_LIST) {
      if (!(k in req.body)) continue
      const v = str(res, req.body, k, { required: false }); if (v === undefined) return
      incoming[k] = v
    }
    // Reject unrecognised keys to avoid silent data loss
    const unknown = Object.keys(req.body).filter(k => !REPORT_KEY_SET.has(k))
    if (unknown.length) return res.status(400).json({ error: `unknown report fields: ${unknown.join(', ')}` })
    if (!Object.keys(incoming).length) return res.status(400).json({ error: 'no report fields provided' })
    const op = actingOperator(req)
    const priorReport = parseReport(c)
    const result = await store.mergeReport(c.id, incoming, op)
    if (result.error) return res.status(400).json({ error: result.error })
    // Distinguish a correction (prior value non-blank) from a first-time fill
    // per AGENTS.md's audit-trail invariant -- record the old-to-new diff for
    // any field that already had a value, not just the new value.
    const corrections = {}
    const firstFills = {}
    for (const [k, v] of Object.entries(incoming)) {
      const prior = priorReport[k]
      if (prior != null && String(prior).trim() !== '') corrections[k] = { from: prior, to: v }
      else firstFills[k] = v
    }
    const data = { by: op.id, ...firstFills }
    if (Object.keys(corrections).length) data.corrections = corrections
    await store.appendEvent(c.id, { kind: 'action', actor: 'operator', text: `recorded report fields via dashboard: ${Object.keys(incoming).join(', ')}`, data })
    res.json({ report: result.report, report_fill_rate: computeFillRate(JSON.stringify(result.report)) })
  }
}

export function getCaseEvents({ store, authed, clampLimit, offsetOf, parseEventData }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const limit = clampLimit(req.query.limit, 50)
    const offset = offsetOf(req.query.offset)
    const events = parseEventData(await store.listEventsPage(req.params.id, { limit, offset }))
    res.json({ events, offset, limit })
  }
}

export function patchCase({ store, authed, str, AUTONOMY, PRIORITY, CASE_TYPE, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const allowed = ['subject', 'summary', 'priority', 'tags', 'assignee', 'autonomy', 'case_type']
    const patch = {}
    for (const k of allowed) {
      if (!(k in req.body)) continue
      const v = str(res, req.body, k); if (v === undefined) return
      if (k === 'autonomy' && !AUTONOMY.has(v)) return res.status(400).json({ error: `invalid autonomy: ${v}` })
      if (k === 'priority' && !PRIORITY.has(v)) return res.status(400).json({ error: `invalid priority: ${v}` })
      if (k === 'case_type' && !CASE_TYPE.has(v)) return res.status(400).json({ error: `invalid case_type: ${v}` })
      patch[k] = v
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'no editable fields' })
    // Optional one-line reason carried alongside the patch (notably for autonomy
    // changes); not a stored field, so it is read off the body directly.
    const patchReason = str(res, req.body, 'reason', { required: false }); if (patchReason === undefined) return
    const prior = await store.getCase(req.params.id)
    if (Object.keys(patch).some(k => k !== 'autonomy')) {
      if (prior?.autonomy === 'observe') return res.status(400).json({ error: 'case autonomy is observe; only autonomy setting can be changed' })
    }
    const op = actingOperator(req)
    // Forward the version this operator's edit was actually based on (prior,
    // already read above for the audit-diff below) as an optimistic-concurrency
    // guard -- without this, two operators editing DIFFERENT fields on the same
    // case at the same time could still silently clobber each other (thatcher's
    // last-write-wins with no version check at all). A genuine conflict 409s
    // cleanly with a plain "someone else changed this case" message rather than
    // either an uncaught throw or a silent lost update; the operator re-fetches
    // and retries with the fresh state, same recovery shape as any other 409 in
    // this file.
    let updated
    try {
      updated = await store.updateCase(req.params.id, patch, op, prior?._version != null ? { expectedVersion: prior._version } : {})
    } catch (e) {
      if (e.code === 'conflict') return res.status(409).json({ error: 'this case was changed by someone else -- reload and try again' })
      throw e
    }
    if (!updated) return res.status(404).json({ error: 'not found' })
    // Best-effort operator-identity learning: an edit is a real working-area
    // signal. Not awaited on the response path -- learning must never slow or
    // fail an operator's actual edit.
    store.learnOperatorActivity(op.id, updated).catch(() => {})
    // An autonomy change is a first-class audited event carrying {from,to,by,reason}
    // so the timeline can render it as a distinct chip (like a transition), not a
    // generic edit that drops the prior value. Other field edits keep the action row.
    const autonomyChanged = 'autonomy' in patch && prior && prior.autonomy !== patch.autonomy
    if (autonomyChanged) {
      await store.appendEvent(req.params.id, {
        kind: 'autonomy_change', actor: 'operator',
        text: `autonomy ${prior.autonomy} -> ${patch.autonomy}`,
        data: { from: prior.autonomy, to: patch.autonomy, by: op.id, reason: patchReason || '' },
      })
    }
    // A case_type reclassification is audited as its own from/to action so every
    // per-type analytic can trace when (and by whom) a case changed category,
    // rather than a generic edit row that drops the prior value.
    const caseTypeChanged = 'case_type' in patch && prior && (prior.case_type || 'unset') !== patch.case_type
    if (caseTypeChanged) {
      await store.appendEvent(req.params.id, {
        kind: 'action', actor: 'operator',
        text: `case_type ${prior.case_type || 'unset'} -> ${patch.case_type}`,
        data: { from: prior.case_type || 'unset', to: patch.case_type, by: op.id, field: 'case_type' },
      })
    }
    const otherKeys = Object.keys(patch).filter(k => k !== 'autonomy' && k !== 'case_type')
    if (otherKeys.length) {
      const otherPatch = Object.fromEntries(otherKeys.map(k => [k, patch[k]]))
      await store.appendEvent(req.params.id, { kind: 'action', actor: 'operator', text: `edited ${otherKeys.join(', ')}`, data: { ...otherPatch, by: op.id } })
    }
    res.json(caseDetailProjection(updated))
  }
}

export function postTransition({ store, authed, str, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const to = str(res, req.body, 'to'); if (to === undefined) return
    const reason = str(res, req.body, 'reason', { required: false }); if (reason === undefined) return
    const c = await store.getCase(req.params.id)
    if (!c) return res.status(404).json({ error: 'not found' })
    const op = actingOperator(req)
    // availableTransitions excludes the current stage; transition() itself
    // no-ops a same-stage move, so let it through rather than 400 a no-op.
    // Checked against the real acting operator's role, not a fixed stand-in,
    // so the pre-check never diverges from what transition() will accept.
    const legal = store.availableTransitions(c, op)
    if (to !== c.status && !legal.includes(to)) {
      return res.status(400).json({ error: `cannot transition to '${to}'`, allowed: legal })
    }
    await store.transition(req.params.id, to, { user: op, reason: reason || 'operator override' })
    const after = await store.getCase(req.params.id)
    store.learnOperatorActivity(op.id, after).catch(() => {})
    res.json(caseDetailProjection(after))
  }
}

// Bulk operator actions over many cases in one request: claim, transition, tag,
// untag, or note a whole selection. Each case is processed INDEPENDENTLY through
// the same single-case store ops the per-case endpoints use -- so one case's
// failure (an illegal transition, a vanished id) is reported in its own result and
// never aborts the batch. Returns a per-id outcome list plus ok/failed counts so
// the SPA can show "claimed 7, 1 could not transition". Body:
//   { ids: string[], action: 'claim'|'transition'|'tag'|'untag'|'note',
//     to?, tag?, text? }
// No new store privilege: it is a loop over audited single-case mutations, each
// attributed to the acting operator exactly as the individual endpoints are.
export function postBulk({ store, authed, actingOperator, sendReply }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : null
    if (!ids || !ids.length) return res.status(400).json({ error: 'ids must be a non-empty array' })
    if (ids.length > 500) return res.status(413).json({ error: 'too many ids (max 500 per bulk request)' })
    const action = String(req.body?.action || '')
    const ACTIONS = new Set(['claim', 'transition', 'tag', 'untag', 'note', 'draft_approve', 'draft_discard'])
    if (!ACTIONS.has(action)) return res.status(400).json({ error: `unknown action '${action}'`, allowed: [...ACTIONS] })
    const op = actingOperator(req)
    // Validate action-specific args ONCE up front so a malformed request fails fast
    // rather than half-applying across the selection.
    const to = action === 'transition' ? String(req.body?.to || '') : null
    if (action === 'transition' && !to) return res.status(400).json({ error: 'transition requires a "to" stage' })
    // Same cap the single-case note route enforces (server.js MAX_LEN, not
    // exported -- kept in sync by value since it's a product-level cap, not a
    // storage limit).
    const NOTE_MAX_LEN = 4000
    const tag = (action === 'tag' || action === 'untag') ? String(req.body?.tag || '').trim() : null
    if ((action === 'tag' || action === 'untag') && !tag) return res.status(400).json({ error: `${action} requires a "tag"` })
    if ((action === 'tag' || action === 'untag') && /[,]/.test(tag)) return res.status(400).json({ error: 'tag must not contain a comma' })
    // Unlike the bulk note action three lines below (which already caps at
    // NOTE_MAX_LEN for the identical reason), the tag/untag value had no
    // length bound at all -- an operator (or hijacked session) could push a
    // body-limit-sized string into the tags CSV column of up to 500 cases in
    // one request.
    if ((action === 'tag' || action === 'untag') && tag.length > NOTE_MAX_LEN) {
      return res.status(413).json({ error: `tag too long (max ${NOTE_MAX_LEN})` })
    }
    const noteText = action === 'note' ? String(req.body?.text || '').trim() : null
    if (action === 'note' && !noteText) return res.status(400).json({ error: 'note requires non-empty "text"' })
    // Without this, a bulk note wrote arbitrary-length text verbatim into up
    // to 500 case timelines with no bound at all, unlike every other
    // text-writing route in this file.
    if (action === 'note' && noteText.length > NOTE_MAX_LEN) {
      return res.status(413).json({ error: `text too long (max ${NOTE_MAX_LEN})` })
    }

    const results = []
    for (const id of ids) {
      try {
        const c = await store.getCase(id)
        if (!c) { results.push({ id, ok: false, error: 'not found' }); continue }
        const withVersion = c._version != null ? { expectedVersion: c._version } : {}
        if (action === 'claim') {
          const claimed = await store.updateCase(id, { assignee: op.id }, op, withVersion)
          await store.appendEvent(id, { kind: 'action', actor: 'operator', text: `Claimed by ${op.name || op.id}`, data: { claimed_by: op.id, bulk: true } })
          store.learnOperatorActivity(op.id, claimed || c).catch(() => {})
        } else if (action === 'transition') {
          const legal = store.availableTransitions(c, op)
          if (to !== c.status && !legal.includes(to)) { results.push({ id, ok: false, error: `cannot transition to '${to}'` }); continue }
          await store.transition(id, to, { user: op, reason: 'operator bulk action' })
          store.learnOperatorActivity(op.id, c).catch(() => {})
        } else if (action === 'tag') {
          if (!tagList(c).includes(tag)) await store.updateCase(id, { tags: mergeTag(c.tags, tag) }, op, withVersion)
        } else if (action === 'untag') {
          if (tagList(c).includes(tag)) await store.updateCase(id, { tags: dropTag(c.tags, tag) }, op, withVersion)
        } else if (action === 'note') {
          await store.appendEvent(id, { kind: 'note', actor: 'operator', text: noteText, data: { by: op.id, bulk: true } })
        } else if (action === 'draft_approve') {
          // Bulk release sends each draft's ORIGINAL text verbatim -- per-case
          // editing before send is a single-case-only affordance (the operator
          // opened that one case to read and adjust it); a bulk release is for
          // drafts an operator has already judged fine to go out as composed.
          const draft = await pendingDraft(store, c)
          if (!draft) { results.push({ id, ok: false, error: 'no pending draft' }); continue }
          const text = draft.text || ''
          if (!text) { results.push({ id, ok: false, error: 'empty draft' }); continue }
          let delivered = false
          if (sendReply) {
            try { await sendReply(c, text); delivered = true }
            catch (e) { await store.appendEvent(id, { kind: 'observation', actor: 'system', text: `Failed to send approved draft on channel: ${e.message || 'unknown error'}` }) }
          }
          await store.appendEvent(id, { kind: 'outbound', actor: 'operator', channel: c.channel, text, data: { to: c.external_id, from_draft: true, by: op.id, bulk: true } })
          if (delivered) {
            await store.updateCase(id, { tags: dropTag(c.tags, 'draft-pending', 'needs-human') }, op)
          } else {
            results.push({ id, ok: false, error: 'send failed' }); continue
          }
        } else if (action === 'draft_discard') {
          const draft = await pendingDraft(store, c)
          if (!draft) { results.push({ id, ok: false, error: 'no pending draft' }); continue }
          await store.updateCase(id, { tags: dropTag(c.tags, 'draft-pending') }, op)
          await store.appendEvent(id, { kind: 'observation', actor: 'operator', text: 'DRAFT DISCARDED: operator bulk discard.', data: { by: op.id, bulk: true } })
        }
        results.push({ id, ok: true })
      } catch (e) { results.push({ id, ok: false, error: String(e.message || e).slice(0, 200) }) }
    }
    const okCount = results.filter(r => r.ok).length
    res.json({ action, total: ids.length, ok: okCount, failed: ids.length - okCount, results })
  }
}

// Snooze a case: an operator who has SEEN a case but cannot finish it now drops
// it out of the attention inbox until a time, without losing it. The scorer in
// attn.js already honours a 'snoozed-until:<epoch-ms>' tag (and never hides a
// needs-human case, and un-snoozes on a newer inbound) -- this endpoint is the
// write side: it sets/replaces that tag and records an audited action so the
// snooze is observable, never a silent disappearance. Body: { minutes } (from now)
// or { until } (epoch ms); minutes<=0 or until<=now CLEARS any snooze. The acting
// operator is attributed. Snoozing is a soft inbox preference, not a workflow
// transition -- the case status is untouched.
export function postSnooze({ store, authed, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const c = await store.getCase(req.params.id)
    if (!c) return res.status(404).json({ error: 'not found' })
    const op = actingOperator(req)
    const now = Date.now()
    let until = null
    if (req.body && req.body.until != null) {
      const u = Number(req.body.until)
      if (!Number.isFinite(u)) return res.status(400).json({ error: '"until" must be an epoch-ms number' })
      until = u
    } else if (req.body && req.body.minutes != null) {
      const m = Number(req.body.minutes)
      if (!Number.isFinite(m)) return res.status(400).json({ error: '"minutes" must be a number' })
      // Bound so a fat-fingered value cannot snooze a case effectively forever.
      until = now + Math.min(Math.max(m, 0), 60 * 24 * 14) * 60000
    } else {
      return res.status(400).json({ error: 'snooze requires "minutes" or "until"' })
    }
    // Strip any existing snooze tag, then add the new one only if it is in the
    // future -- a past/zero target is a CLEAR.
    const tags = tagList(c).filter(t => !t.startsWith('snoozed-until:'))
    const cleared = !(until > now)
    if (!cleared) tags.push(`snoozed-until:${Math.floor(until)}`)
    await store.updateCase(c.id, { tags: tags.join(',') }, op)
    await store.appendEvent(c.id, {
      kind: 'action', actor: 'operator',
      text: cleared ? `Snooze cleared by ${op.name || op.id}` : `Snoozed by ${op.name || op.id} until ${new Date(Math.floor(until)).toISOString()}`,
      data: { by: op.id, snoozed_until: cleared ? null : Math.floor(until) },
    })
    res.json({ ok: true, snoozed_until: cleared ? null : Math.floor(until), cleared })
  }
}

// Undo the last reversible operator action on a case, within a recency window, by
// appending a COMPENSATING event -- history is append-only and never mutated. The
// 15s window is a client UX affordance; the server bounds undo at 120s so a late
// request cannot silently rewrite an old decision. Iteration 1 covers the clean,
// self-describing reversible actions whose reverse is fully recorded in the
// original event's data:
//   transition  -> reverse transition (to = data.from), reason 'undo'
//   snooze      -> clear the snooze tag (compensating action event)
//   claim       -> restore the prior assignee (data.was)
// A sent reply is NOT reversible (the contact already saw it) -- undo of a reply
// is the client-side 'disregard my last message' helper, out of scope here. The
// acting operator is attributed; the compensating event carries undo_of so the
// pair is observable on the timeline.
export function postUndo({ store, authed, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const c = await store.getCase(req.params.id)
    if (!c) return res.status(404).json({ error: 'not found' })
    const op = actingOperator(req)
    // Shared event.data parser (the same one /audit.csv and overview use) --
    // one chokepoint for the "data is a JSON string at the read edge" rule,
    // never a re-inlined copy that can drift.
    const { evData } = await import('../../overview.js')
    const { toDate } = await import('../../format.js')
    const WINDOW_MS = 120000
    const now = Date.now()
    const events = await store.listEvents(c.id)
    // Find the most recent UNDOABLE operator action that has not already been
    // undone, newest-first and within the window.
    const undoneIds = new Set()
    for (const e of events) { const d = evData(e); if (d.undo_of) undoneIds.add(String(d.undo_of)) }
    const isRecent = (e) => {
      // event.created_at is unix-SECONDS, often a numeric string -- bare
      // Date.parse yields NaN, which made every real event pass the window
      // (unparseable -> allow), so the 120s undo window was never enforced.
      // toDate is digit-string-aware (seconds -> ms) and returns null on junk.
      const d = e.created_at ? toDate(e.created_at) : null
      return d ? (now - d.getTime()) <= WINDOW_MS : true   // truly-unparseable -> allow (tests)
    }
    let target = null, kind = null
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (undoneIds.has(String(e.id))) continue
      if (!isRecent(e)) break   // older than the window: nothing undoable remains
      if (e.kind === 'transition' && e.actor === 'operator') {
        // A compensating reverse transition is itself reason 'undo' -- it is not a
        // fresh operator decision, so undoing it (which would re-apply the original
        // move) is wrong. Skip it and keep scanning for a real action to reverse.
        if (evData(e).reason === 'undo') continue
        target = e; kind = 'transition'; break
      }
      if (e.kind === 'action' && e.actor === 'operator') {
        const txt = String(e.text || '')
        if (/^Undo by/.test(txt)) continue   // the compensating action itself is not undoable
        if (/^Claimed by/.test(txt)) { target = e; kind = 'claim'; break }
        if (/^Snoozed by/.test(txt)) { target = e; kind = 'snooze'; break }
      }
    }
    if (!target) return res.status(409).json({ error: 'nothing to undo in the last 120s' })
    const d = evData(target)
    let summary = ''
    if (kind === 'transition') {
      const to = d.from
      if (!to) return res.status(409).json({ error: 'transition has no recorded prior stage' })
      // Not every forward move has a symmetric backward edge in
      // thatcher.config.yml (e.g. waiting->resolved exists but resolved's own
      // backward list is only [in_progress]) -- pre-validate the reverse move
      // the same way the plain transition route above does, rather than
      // letting an illegal reverse throw an uncaught 500 out of store.transition.
      const legal = store.availableTransitions(c, op)
      if (to !== c.status && !legal.includes(to)) {
        return res.status(409).json({ error: `cannot undo: '${to}' is not a legal transition from '${c.status}'`, allowed: legal })
      }
      await store.transition(c.id, to, { user: op, reason: 'undo' })
      summary = `undid transition: back to ${to}`
    } else if (kind === 'claim') {
      const prior = d.was || ''
      await store.updateCase(c.id, { assignee: prior }, op)
      summary = prior ? `undid claim: assignee back to ${prior}` : 'undid claim: assignee cleared'
    } else if (kind === 'snooze') {
      const tags = tagList(await store.getCase(c.id)).filter(t => !t.startsWith('snoozed-until:'))
      await store.updateCase(c.id, { tags: tags.join(',') }, op)
      summary = 'undid snooze'
    }
    await store.appendEvent(c.id, {
      kind: 'action', actor: 'operator',
      text: `Undo by ${op.name || op.id}: ${summary}`,
      data: { by: op.id, undo_of: target.id, undo_kind: kind },
    })
    res.json({ ok: true, undone: kind, summary })
  }
}

export function postNote({ store, authed, str, REPORT_KEY_SET, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const text = str(res, req.body, 'text'); if (text === undefined) return
    if (!text.trim()) return res.status(400).json({ error: 'empty note' })
    const c = await store.getCase(req.params.id)
    if (!c) return res.status(404).json({ error: 'not found' })
    const field = req.body.field && REPORT_KEY_SET.has(req.body.field) ? req.body.field : null
    const op = actingOperator(req)
    await store.appendEvent(req.params.id, { kind: 'note', actor: 'operator', text, data: { ...(field ? { field } : {}), by: op.id } })
    res.json({ ok: true })
  }
}

// Structured "this reply was bad/off-target" feedback -- pillar 8's live
// feedback loop for prompt tuning. Same pattern as /note above (an audited
// event, not a new subsystem): tags the flagged event id and an optional
// reason so /api/flagged-replies (below) can roll up every flag for an
// operator/prompt-writer to review, without needing to re-read the whole
// timeline of every case.
export function postFlagReply({ store, authed, str, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const eventId = str(res, req.body, 'event_id'); if (eventId === undefined) return
    const reason = typeof req.body.reason === 'string' ? req.body.reason.slice(0, 500) : ''
    const c = await store.getCase(req.params.id)
    if (!c) return res.status(404).json({ error: 'not found' })
    const events = await store.listEvents(req.params.id, { limit: 500 })
    const target = events.find(e => e.id === eventId)
    if (!target) return res.status(404).json({ error: 'event not found on this case' })
    if (target.kind !== 'outbound') return res.status(400).json({ error: 'only an outbound reply can be flagged' })
    const op = actingOperator(req)
    await store.appendEvent(req.params.id, {
      kind: 'observation', actor: 'operator',
      text: `FLAGGED REPLY${reason ? `: ${reason}` : ' (no reason given)'}`,
      data: { flagged_reply: true, flagged_event_id: eventId, flagged_text: (target.text || '').slice(0, 500), reason, by: op.id },
    })
    // Also tag the CASE (not just the event) so /api/flagged-replies (reports.js)
    // can find it via the same listCases-plus-tag-filter pattern /api/unreplied
    // already uses -- there is no cross-case event-search route in this codebase,
    // and adding a case-level tag is far cheaper than scanning every case's full
    // event history to find flagged ones.
    if (!tagList(c).includes('flagged-reply')) {
      await store.updateCase(req.params.id, { tags: mergeTag(c.tags, 'flagged-reply') })
    }
    res.json({ ok: true })
  }
}

// Cases that look like the SAME real-world outbreak as this one -- the
// operator's view of casey's grouping intelligence, with the reasons shown so
// the suggestion is explainable, never an opaque score.
export function getSuggestions({ store, authed, isOpenCase }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const c = await store.getCase(req.params.id)
    if (!c) return res.status(404).json({ error: 'not found' })
    const { suggestLinks } = await import('../../correlate.js')
    const pool = (await store.listCases({}, { limit: 200 }))
      .filter(o => o.id !== c.id && isOpenCase(o) && !tagList(o).includes('merged'))
    const byId = new Map(pool.map(o => [o.id, o]))
    const suggestions = suggestLinks(c, pool).slice(0, 5)
      .map(s => ({ ...s, subject: byId.get(s.id)?.subject || '', status: byId.get(s.id)?.status || '' }))
    res.json({ count: suggestions.length, suggestions })
  }
}

// site-durable-entity-visit-history PRD row: a field worker does not OWN a
// case (a different person may follow up from whoever reported it) -- what
// an operator actually needs is "who has been to this SITE and when", across
// every conversation (case) that turns out to be the same real place, not
// just this one contact's own thread. Rather than a new site/place entity
// (a schema migration + a second grouping mechanism competing with the
// existing one), this reuses correlate.js's own location/species/symptom
// scoring UNCHANGED -- the same signal that already powers "possibly the
// same case" merge suggestions above -- but over the FULL case pool
// (open AND closed/resolved: a visit history must include past visits, not
// only currently-open threads) and returns each match's reporting contact
// identity + timestamp rather than a merge action. PII discipline: no
// external_id/contact_id -- "who" is the case ref + reported-by-channel only
// (the same PII-free shape enquiryRow already uses elsewhere), an operator
// can open the linked case itself for the real contact detail if needed.
export function getSiteHistory({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const c = await store.getCase(req.params.id)
    if (!c) return res.status(404).json({ error: 'not found' })
    const { suggestLinks } = await import('../../correlate.js')
    const pool = (await store.listCases({}, { limit: 500 }))
      .filter(o => o.id !== c.id && !tagList(o).includes('merged'))
    const byId = new Map(pool.map(o => [o.id, o]))
    const visits = suggestLinks(c, pool, 0.2).slice(0, 20)
      .map(s => {
        const row = byId.get(s.id)
        return {
          id: s.id, ref: s.ref, score: s.score, reasons: s.reasons,
          channel: row?.channel || null,
          status: row?.status || null,
          reported_at: row?.created_at || null,
          last_activity_at: row?.last_event_at || null,
        }
      })
      .sort((a, b) => (Number(b.reported_at) || 0) - (Number(a.reported_at) || 0))
    res.json({ site_ref: c.ref, count: visits.length, visits })
  }
}

// Fold another case (source = req.body.into) INTO this one (target = :id). The
// target stays canonical; lossless and idempotent in the store.
export function postMerge({ store, authed, str, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const into = str(res, req.body, 'into'); if (into === undefined) return
    if (!into.trim()) return res.status(400).json({ error: 'no source case to merge' })
    const reason = str(res, req.body, 'reason', { required: false }); if (reason === undefined) return
    const res2 = await store.mergeCases(into, req.params.id, actingOperator(req), { reason: reason || 'operator merge' })
    if (res2.error) return res.status(400).json({ error: res2.error })
    res.json({ ok: true, movedEvents: res2.movedEvents, alreadyMerged: !!res2.alreadyMerged, ...(res2.reportWasCorrupted ? { reportWasCorrupted: true } : {}) })
  }
}

// Split selected events out of this case into a NEW linked case.
// Body: { event_ids: string[], subject?: string, reason?: string }
export function postSplit({ store, authed, str, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const { event_ids } = req.body
    if (!Array.isArray(event_ids) || !event_ids.length) return res.status(400).json({ error: 'event_ids must be a non-empty array' })
    // Same MAX_LEN guardrail every sibling route enforces (str() below); split's
    // subject/reason used to bypass it entirely via a raw req.body destructure.
    const subject = str(res, req.body, 'subject', { required: false }); if (subject === undefined) return
    const reason = str(res, req.body, 'reason', { required: false }); if (reason === undefined) return
    const result = await store.splitCase(req.params.id, event_ids, { subject: subject || '', reason: reason || 'operator split' }, actingOperator(req))
    if (result.error) return res.status(400).json({ error: result.error })
    res.json({ ok: true, new_case_id: result.newCase?.id, new_case_ref: result.newCase?.ref, moved_events: result.movedEvents })
  }
}

// Operator takes over the conversation: send a message to the contact on
// their channel and record it as an outbound event.
export function postReply({ store, authed, str, actingOperator, sendReply, UNCLAIMED_ASSIGNEE }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const raw = str(res, req.body, 'text'); if (raw === undefined) return
    const text = raw.trim()
    if (!text) return res.status(400).json({ error: 'empty reply' })
    const c = await store.getCase(req.params.id)
    if (!c) return res.status(404).json({ error: 'not found' })
    // Try to deliver before claiming success: if the channel send throws, we
    // record the failure and do NOT clear needs-human, so a contact who never
    // got the reply stays pinned in triage rather than silently dropped (P10).
    const op = actingOperator(req)
    let delivered = false
    if (sendReply) {
      try { await sendReply(c, text); delivered = true }
      catch (e) {
        await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `Failed to send operator reply on channel: ${e.message || 'unknown error'}` })
      }
    }
    // Claim-on-reply: the operator who personally answered owns the case. Only
    // auto-claim an unowned case (unset or the default 'agent'); never silently
    // take a case another human already holds -- that stays a soft nudge, not a
    // hard steal. The claim is recorded BEFORE the outbound event so the reply
    // stays the latest event on the timeline, and is its own audited action so
    // the handover is observable.
    let claimed = false
    if (delivered) {
      const current = String(c.assignee || '').trim()
      if (!current || current === UNCLAIMED_ASSIGNEE) {
        await store.updateCase(c.id, { assignee: op.id }, op)
        await store.appendEvent(c.id, { kind: 'action', actor: 'operator', text: `Claimed by ${op.name || op.id}`, data: { claimed_by: op.id, was: current || null } })
        claimed = true
      }
    }
    await store.appendEvent(c.id, { kind: 'outbound', actor: 'operator', channel: c.channel, text, data: { to: c.external_id, by: op.id } })
    // A personal reply is the strongest working-area signal casey has.
    store.learnOperatorActivity(op.id, c).catch(() => {})
    // The operator personally answered, so the "wants a human" flag is satisfied
    // -- but only once the message actually reached the contact. Clear it then,
    // or the triage inbox keeps this case pinned at the top forever.
    // Clearing needs-human (a person was asked for) and ai-offline (the agent turn
    // had failed and a human needed to verify the reply): a delivered operator
    // answer satisfies both, so drop them together rather than leaving the case
    // pinned in the triage inbox or the offline queue forever.
    if (delivered) {
      const tags = tagList(c)
      const keep = tags.filter(t => t !== 'needs-human' && t !== 'ai-offline')
      if (keep.length !== tags.length) {
        await store.updateCase(c.id, { tags: keep.join(',') }, op)
      }
    }
    res.json({ ok: delivered, sent: !!sendReply, delivered, claimed })
  }
}

// Approve a held assisted draft: send the (possibly operator-edited) text to the
// contact, record it as an operator outbound, and clear draft-pending +
// needs-human only once it actually delivered -- mirroring the reply path so a
// failed send leaves the case pinned rather than silently dropped.
export function postDraftApprove({ store, authed, str, actingOperator, sendReply }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const c = await store.getCase(req.params.id)
    if (!c) return res.status(404).json({ error: 'not found' })
    const draft = await pendingDraft(store, c)
    if (!draft) return res.status(409).json({ error: 'no pending draft' })
    // Operator may edit before approving; fall back to the drafted text. Same
    // MAX_LEN guardrail every sibling route enforces (str() below) -- an
    // operator-edited draft used to bypass it via a raw req.body read.
    let text = draft.text || ''
    if (req.body && typeof req.body.text === 'string' && req.body.text.trim()) {
      const edited = str(res, req.body, 'text', { required: false }); if (edited === undefined) return
      if (edited.trim()) text = edited.trim()
    }
    if (!text) return res.status(400).json({ error: 'empty draft' })
    let delivered = false
    if (sendReply) {
      try { await sendReply(c, text); delivered = true }
      catch (e) { await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `Failed to send approved draft on channel: ${e.message || 'unknown error'}` }) }
    }
    const op = actingOperator(req)
    await store.appendEvent(c.id, { kind: 'outbound', actor: 'operator', channel: c.channel, text, data: { to: c.external_id, from_draft: true, by: op.id } })
    if (delivered) {
      await store.updateCase(c.id, { tags: dropTag(c.tags, 'draft-pending', 'needs-human') }, op)
    }
    res.json({ ok: delivered, sent: !!sendReply, delivered })
  }
}

// Discard a held assisted draft without sending: clear draft-pending and record
// the decision. needs-human stays -- a discarded draft still wants a human to
// decide what (if anything) to say next.
export function postDraftDiscard({ store, authed, str, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const c = await store.getCase(req.params.id)
    if (!c) return res.status(404).json({ error: 'not found' })
    const draft = await pendingDraft(store, c)
    if (!draft) return res.status(409).json({ error: 'no pending draft' })
    // Same MAX_LEN guardrail every sibling route enforces (str() below).
    const rawReason = str(res, req.body, 'reason', { required: false }); if (rawReason === undefined) return
    const reason = rawReason.trim() || 'operator discarded'
    const op = actingOperator(req)
    await store.updateCase(c.id, { tags: dropTag(c.tags, 'draft-pending') }, op)
    await store.appendEvent(c.id, { kind: 'observation', actor: 'operator', text: `DRAFT DISCARDED: ${reason}.`, data: { by: op.id } })
    res.json({ ok: true })
  }
}

// How many ruled writing lines an empty field gets on the printed briefing.
//
// The count is DERIVED from the deployment's own field declarations, never a
// per-key table in here: report-fields.yml already says which answers are
// paragraphs. `multiline` is the direct statement of it (uhh declares it on
// six fields -- symptoms, how_to_find, treatment_history, access_notes and
// friends), and `append` fields carry the same shape for a different reason,
// since they accumulate several entries rather than holding one value. Every
// other field is a species, a count or a date: one line is the honest amount
// of space, and more would just push the next question off the page.
//
// WHAT THIS CANNOT DERIVE, stated rather than guessed: casey's own bundled
// default config declares `multiline` on nothing at all, so under that config
// every field falls to a single line. That is the correct behaviour for a
// config that has not said otherwise -- it is not a silent wrong guess, it is
// the deployment declining to say -- but a deployer whose form has free-text
// answers should add `multiline: true` to those fields rather than expect this
// to infer it from the label.
const FIELD_DEF_BY_KEY = new Map((REPORT_FIELD_DEFS || []).filter(f => f && f.key).map(f => [f.key, f]))
const MULTILINE_FILL_LINES = 3
function fillLinesHtml(key) {
  const d = FIELD_DEF_BY_KEY.get(key)
  const n = (d && (d.multiline === true || d.append === true)) ? MULTILINE_FILL_LINES : 1
  return `<span class="ds-fill-lines" aria-hidden="true">${'<span class="ds-fill-line"></span>'.repeat(n)}</span>`
}

// Printable case briefing for field teams. Plain HTML, no JS, print-friendly.
// Mounted { raw: true }: it owns its own try/catch and answers an HTML error
// page, so deps.wrap's JSON 500 envelope would change what a failure looks
// like, and its 401/404 are HTML too.
export function getReportHtml({ store, authed, esc, REPORT_KEY_LIST, printableReport }) {
  return async (req, res) => {
    try {
      if (!authed(req)) return res.status(401).send('<p>Unauthorized.</p>')
      const c = await store.getCase(req.params.id)
      if (!c) return res.status(404).send('<p>Case not found.</p>')
      let r = parseReport(c)
      // Row labels come from report-shape.js's fieldLabel, the same
      // config-driven resolver every other consumer uses. A 16-entry
      // animal-health LABELS map used to sit here while the loop below already
      // iterated the config-driven REPORT_KEY_LIST, so under any other
      // deployment's report-fields.yml every row fell through to the raw
      // snake_case key -- a briefing headed "device_or_asset".
      // A saved media path looks like "...(saved: media/<caseId>/<file>)" (see
      // case-store.js saveMedia / gateway-hooks.js) -- surface it as a real link
      // to /media/<path> so a field-team briefing can actually open the photo/
      // voice note, not just read that one arrived.
      const mediaLinkRe = /\(saved: (media\/[^)]+)\)/g
      const rows = REPORT_KEY_LIST.map(k => {
        // Unrecorded: the words on screen, the writing space on paper. The
        // shared print stylesheet hides .ds-print-blank and reveals
        // .ds-fill-lines, so neither is a decision this route has to make
        // twice. Overwritten wholesale below when there is a real value, so a
        // recorded field never carries stray lines.
        let val = `<span class="ds-print-blank"><em>not recorded</em></span>${fillLinesHtml(k)}`
        if (r[k] != null && String(r[k]).trim()) {
          const raw = String(r[k])
          if (k === 'location') {
            const mapHref = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(raw)}`
            val = `${esc(raw)} <a class="maplink" href="${esc(mapHref)}" target="_blank" rel="noopener">[map]</a>`
          } else if (k === 'photos' || k === 'audio') {
            val = esc(raw).replace(mediaLinkRe, (_m, p) => `(<a href="/${esc(p)}" target="_blank" rel="noopener">open</a>)`)
          } else {
            val = esc(raw)
          }
        }
        return `<tr><th>${esc(fieldLabel(k))}</th><td>${val}</td></tr>`
      }).join('')
      // Maps link when location field is available
      const mapsUrl = r.location ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(String(r.location))}` : null
      // tel: link for the external_id if it looks like a phone
      const phone = c.external_id || ''
      const telLink = /^[+0-9]{7,}$/.test(phone.replace(/[\s\-()]/g, '')) ? `tel:${phone.replace(/[\s\-()]/g, '')}` : null
      // Composed by server.js's printableReport (already handed to this module
      // through deps) rather than a fourth hand-rolled <head>/<style> block --
      // the shared helper exists precisely because three print generators each
      // carried a near-duplicate stylesheet, and this one had quietly become
      // the fourth, on its own off-brand blue. Only what is genuinely specific
      // to a briefing goes through extraCss: the on-screen action bar (hidden
      // when printed) and the fixed label column. Its buttons take the
      // deployment's own brand ground with the ink readableInkOn computes for
      // it, so they stay legible on a light or a dark brand.
      //
      // The h1 override that used to sit here is GONE on purpose. It said
      // 1.2em, which resolved to 16.8px, while the management report and the
      // shift handover -- built by the same printableReport helper, carrying
      // the same page-title role -- resolved 20.8px. One heading, two sizes,
      // measured live in a browser. Dropping the override lets the shared
      // title size (--fs-xl) apply, so all three printables now agree.
      const extraCss = `body{max-width:700px;margin:var(--space-5) auto}`
        + `table{width:100%}th{width:40%;font-weight:600;vertical-align:top}td{vertical-align:top}`
        + `.maplink{font-size:var(--fs-micro)}`
        + `.act{display:flex;gap:var(--space-2-75);flex-wrap:wrap;margin:var(--space-2-5) 0 var(--space-4)}`
        + `.act a{background:${BRAND.ground};color:${BRAND.ink};padding:var(--space-2) var(--space-3);border-radius:6px;text-decoration:none;font-size:var(--fs-xs);font-weight:600}`
        + `.act a:hover{background:${BRAND.hover}}`
        + `@media print{.act{display:none}}`
      const body = `<h1>Field briefing: ${esc(c.ref||c.id)}</h1>
<p><strong>Subject:</strong> ${esc(c.subject||'')}</p>
<p><strong>Status:</strong> ${esc(c.status||'')} &nbsp; <strong>Channel:</strong> ${esc(c.channel||'')}</p>
<div class="act">
  <a href="javascript:window.print()">Print this page</a>
  ${mapsUrl ? `<a href="${esc(mapsUrl)}" target="_blank" rel="noopener">Open in Maps</a>` : ''}
  ${telLink ? `<a href="${esc(telLink)}">Call contact</a>` : ''}
</div>
<table>${rows}</table>`
      res.type('html').send(printableReport(`Case ${c.ref||c.id} briefing`, body, extraCss))
    } catch (e) { res.status(500).send('<p>Error: ' + esc(String(e.message || 'unknown error')) + '</p>') }
  }
}

// Order is load-bearing and matches the pre-split registration order exactly:
// GET /api/cases/export.csv must precede GET /api/cases/:id, or express
// captures 'export.csv' as an id.
const ROUTES = [
  ['get', '/api/cases', getCases],
  ['post', '/api/cases', postCase],
  ['get', '/api/cases/export.csv', getCasesCsv],
  ['get', '/api/cases/:id', getCaseDetail],
  ['post', '/api/cases/:id/intake', postIntake],
  ['get', '/api/cases/:id/events', getCaseEvents],
  ['patch', '/api/cases/:id', patchCase],
  ['post', '/api/cases/:id/transition', postTransition],
  ['post', '/api/cases/bulk', postBulk],
  ['post', '/api/cases/:id/snooze', postSnooze],
  ['post', '/api/cases/:id/undo', postUndo],
  ['post', '/api/cases/:id/note', postNote],
  ['post', '/api/cases/:id/flag-reply', postFlagReply],
  ['get', '/api/cases/:id/suggestions', getSuggestions],
  ['get', '/api/cases/:id/site-history', getSiteHistory],
  ['post', '/api/cases/:id/merge', postMerge],
  ['post', '/api/cases/:id/split', postSplit],
  ['post', '/api/cases/:id/reply', postReply],
  ['post', '/api/cases/:id/draft/approve', postDraftApprove],
  ['post', '/api/cases/:id/draft/discard', postDraftDiscard],
  ['get', '/api/cases/:id/report.html', getReportHtml, { raw: true }],
]

export function registerCases(app, deps) {
  mountRoutes(app, deps, ROUTES)
}
