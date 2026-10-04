import { normalizeMsisdn } from '../../role-invites.js'
import { tagList, parseReport } from '../../timestamp.js'
import { mergeTag, dropTag } from '../../hooks/heuristics.js'
import { fmtPhone27, markInvisibles } from '../../format.js'
import { fieldLabel, REPORT_FIELD_DEFS, REPORT_ENTITY_LABEL, SIGNOFF_DIAGNOSIS_FIELDS, MANDATORY_MINIMUM_BLOCKED_STATUSES, hiddenFieldsFor } from '../../store/report-shape.js'
import { sendBackToRanger } from '../../signoff-desk.js'
import { areaInfoFor } from '../../areas.js'
import { isKnownValueField, invalidateKnownValues } from '../../field-values.js'
import { BRAND } from '../brand.js'
import { mountRoutes } from './register.js'
import { assigneeNamer, nameEventAssignees } from '../assignee-names.js'
import { appendReplyEvent, pendingDraft, releaseCase } from '../../hooks/staff-outbound.js'
import { clearFocusForCase } from '../../team-focus.js'
import { assigneeKeyFor, isContactAssignee, contactIdOfAssignee, isOwnConversation } from '../../case-assignment.js'
import { atLeast, TIER_FIELD_WORKER } from '../../contact-tiers.js'
import { findAccountByUsername } from '../auth.js'
import { isFieldAccount, caseAccess, isAssignedTo, inSignOffQueue, detailForAccess, missingFor } from '../roles.js'
import { waLink } from '../wa-link.js'
import { reporterFirstName, reporterSummary } from '../../phone-persons.js'
import { prepareReminder, OPERATOR_REMINDER_FLAG } from '../../hooks/operator-reminder.js'

const INTAKE_META_KEYS = new Set(['canonicalized', 'expected_ref'])

function canonicalizedNote(raw, incoming) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in incoming)) continue
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue
    const typed = v.typed == null ? '' : String(v.typed).slice(0, 500)
    if (!typed || typed === incoming[k]) continue
    out[k] = { typed, stored: incoming[k], how: v.how == null ? '' : String(v.how).slice(0, 40) }
  }
  return Object.keys(out).length ? out : null
}

export function caseListProjection(c, name = (v) => v) {
  if (!c) return null
  const { id, ref, channel, status, priority, subject, summary, report, tags, assignee, autonomy, last_event_at, fill_rate, created_at, case_type } = c
  return {
    id, ref, channel, status, priority,
    subject: markInvisibles(subject), summary: markInvisibles(summary), report: markInvisibles(report),
    tags, assignee: name(assignee), autonomy, last_event_at, fill_rate, created_at, case_type,
  }
}

const SYSTEM_NOISE_RE = /^\s*(REPLY-JUDGE-FLAGGED|REPEAT-ASK|NOTICE-NOT-COMPOSED|TURN-START|TURN-HANDED-OFF|resume-attempted|RUNTIME)/i
export const isSystemNoiseEvent = (e) => !!e && e.kind === 'observation' && typeof e.text === 'string' && SYSTEM_NOISE_RE.test(e.text)

export async function timelinePageFor(store, caseId, { limit, offset }, account, parseEventData) {
  if (!isFieldAccount(account)) {
    return { events: parseEventData(await store.listEventsPage(caseId, { limit, offset })), total: await store.countEvents(caseId) }
  }
  const all = parseEventData(await store.listEvents(caseId)).filter(e => !isSystemNoiseEvent(e)).reverse()
  return { events: all.slice(offset, offset + limit), total: all.length }
}

export function eventProjection(e) {
  if (!e || typeof e !== 'object') return e
  return { ...e, text: markInvisibles(e.text), data: markInvisibles(e.data) }
}

export function caseDetailProjection(c, name = (v) => v, { keepKey = true } = {}) {
  if (!c) return null
  const out = { ...caseListProjection(c, name), external_id_formatted: fmtPhone27(c.external_id), assignee_name: name(c.assignee || '') }
  if (keepKey) out.assignee = c.assignee
  return out
}

export function getCases({ store, authed, clampLimit, offsetOf, computeFillRate, REPORT_KEY_LIST, UNCLAIMED_ASSIGNEE }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const field = isFieldAccount(req.caseyAccount)
    const fieldView = field ? String(req.query.view || '') : ''
    const where = {}
    if (req.query.status) {
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
    if (req.query.ref) {
      const ref = String(req.query.ref).slice(0, 50)
      const found = await store.getCaseByRef(ref)
      const seen = found && (!field || caseAccess(found, req.caseyAccount, { unclaimedKey: UNCLAIMED_ASSIGNEE }) !== 'none') ? found : null
      const casesWithFill = seen ? [{ ...seen, fill_rate: computeFillRate(seen.report) }] : []
      const named = await assigneeNamer(store, casesWithFill, undefined, { logins: field })
      return res.json({ cases: casesWithFill.map(c => caseListProjection({ ...c }, named)), total: casesWithFill.length, limit: casesWithFill.length, offset: 0 })
    }
    const q = req.query.q ? String(req.query.q).slice(0, 200).toLowerCase() : ''
    const limit = clampLimit(req.query.limit, 50)
    const offset = offsetOf(req.query.offset)
    let cases, total
    if (field) {
      const all = await store.listCases(where, { limit: 10000, offset: 0 })
      const key = { unclaimedKey: UNCLAIMED_ASSIGNEE }
      const mine = all.filter(c => fieldView === 'mine' ? isAssignedTo(c, req.caseyAccount)
        : fieldView === 'signoff' ? (caseAccess(c, req.caseyAccount, key) !== 'none' && inSignOffQueue(c, UNCLAIMED_ASSIGNEE))
        : caseAccess(c, req.caseyAccount, key) !== 'none')
      const filtered = q ? mine.filter(c => {
        const hay = [c.ref, c.subject, c.summary, c.channel].join(' ').toLowerCase()
        if (hay.includes(q)) return true
        const r = parseReport(c)
        return REPORT_KEY_LIST.some(k => r[k] != null && String(r[k]).toLowerCase().includes(q))
      }) : mine
      total = filtered.length
      cases = filtered.slice(offset, offset + limit)
    } else if (q) {
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
      total = await store.countCases(where.channel === undefined ? { ...where, channel: { $ne: 'system' } } : where)
    }
    const casesWithFill = cases.map(c => ({ ...c, fill_rate: computeFillRate(c.report) }))
    const named = await assigneeNamer(store, casesWithFill, undefined, { logins: field })
    res.json({ cases: casesWithFill.map(c => caseListProjection(c, named)), total, limit, offset })
  }
}

async function writeProjection(store, c, req) {
  const field = isFieldAccount(req.caseyAccount)
  const out = caseDetailProjection(c, await assigneeNamer(store, [c], undefined, { logins: field }), { keepKey: !field })
  return field ? detailForAccess(out, 'read') : out
}

export function postCase({ store, authed, str, actingOperator, computeFillRate }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const subject = str(res, req.body, 'subject', { required: false }); if (subject === undefined) return
    const name = str(res, req.body, 'name', { required: false }); if (name === undefined) return
    const phone = str(res, req.body, 'phone', { required: false }); if (phone === undefined) return
    if (phone) {
      const digits = phone.replace(/[\s\-()]/g, '')
      const valid = /^0[0-9]{9}$/.test(digits) || /^\+27[0-9]{9}$/.test(digits)
      if (!valid) return res.status(400).json({ error: 'Phone must be a South African number: 0821234567 or +27821234567' })
    }
    const normPhone = phone ? normalizeMsisdn(phone) : ''
    const external_id = normPhone || `web-${Date.now()}`
    const contact = { display_name: name || 'operator', name: name || 'operator', phone: phone || '' }
    const { case: c, created } = await store.findOrCreateCase({ channel: 'web', external_id, contact, subject: subject || 'Field report' })
    if (!created) {
      if (isFieldAccount(req.caseyAccount) && caseAccess(c, req.caseyAccount) === 'none') {
        return res.status(409).json({ error: 'A report already exists for this contact. Ask an operator to assign it to you.' })
      }
      return res.status(409).json({ error: 'A case already exists for this contact', existing_id: c.id, existing_ref: c.ref })
    }
    const op = actingOperator(req)
    const tags = tagList(c)
    if (!tags.includes('intake_mode:manual')) {
      const newTags = [...tags, 'intake_mode:manual'].join(',')
      await store.updateCase(c.id, { tags: newTags }, op)
    }
    if (isFieldAccount(req.caseyAccount)) await store.updateCase(c.id, { assignee: op.id }, op)
    await store.appendEvent(c.id, { kind: 'action', actor: 'operator', text: 'case created via dashboard manual intake', data: { by: op.id } })
    const createdCase = await store.getCase(c.id)
    res.status(201).json(caseListProjection({ ...createdCase, fill_rate: computeFillRate(createdCase.report) }))
  }
}

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

const REVEAL_SEEN = new Map()
const REVEAL_WINDOW_MS = 10 * 60e3
async function noteNumberReveal(store, c, op) {
  const k = c.id + '|' + op.id
  const last = REVEAL_SEEN.get(k)
  if (last && Date.now() - last < REVEAL_WINDOW_MS) return
  REVEAL_SEEN.set(k, Date.now())
  await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `The reporter's phone number was shown to ${op.name || op.id}, who is working this ${REPORT_ENTITY_LABEL}.`, data: { number_shown_to: op.id } })
}

export function getCaseDetail({ store, authed, clampLimit, parseEventData, actingOperator, computeFillRate, parseJsonArraySafe, getRoster, UNCLAIMED_ASSIGNEE }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const c = await store.getCase(req.params.id)
    if (!c) return res.status(404).json({ error: 'not found' })
    const limit = clampLimit(req.query.events_limit, 50)
    const { events, total: events_total } = await timelinePageFor(store, c.id, { limit, offset: 0 }, req.caseyAccount, parseEventData)
    const transitions = store.availableTransitions(c, actingOperator(req))
    const report_fill_rate = computeFillRate(c.report)
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
    const caseTypeAction = events.find(e => e.kind === 'action' && e.data?.field === 'case_type')
    const case_type_source = c.case_type && c.case_type !== 'unset'
      ? (caseTypeAction ? caseTypeAction.actor : 'agent')
      : null
    let fieldExtras = isFieldAccount(req.caseyAccount) ? { access: req.caseyAccess } : {}
    if (isFieldAccount(req.caseyAccount) && req.caseyAccess === 'write') {
      const op = actingOperator(req)
      const missing = missingFor(c)
      const digits = (c.channel === 'whatsapp' || /^\+?\d{9,15}$/.test(String(c.external_id || ''))) ? String(c.external_id || '').replace(/\D/g, '') : ''
      const personFirst = await reporterFirstName(store, c)
      const text = `Hello${personFirst ? ` ${personFirst}` : ''}, ${op.name} here, following up on your ${REPORT_ENTITY_LABEL} ${c.ref}. Please send a message to our WhatsApp assistant again`
        + (missing.length ? ` and tell it: ${missing.map(fieldLabel).join(', ')}.` : ' so we can finish it.') + ' Thank you.'
      const contact = c.contact_id ? await store.getContact(c.contact_id).catch(() => null) : null
      const given = String(contact?.display_name || '').trim()
      const first = personFirst || (given && given !== contact?.external_id && !/^[\d+\s()-]+$/.test(given) && !/^web-/.test(given) ? given.split(/\s+/)[0].slice(0, 30) : null)
      fieldExtras = { ...fieldExtras, reporter_message_link: waLink(digits, text), missing_facts: missing.map(k => ({ key: k, label: fieldLabel(k) })), reporter_first_name: first }
      await noteNumberReveal(store, c, op)
    }
    const named = await assigneeNamer(store, [c], undefined, { logins: isFieldAccount(req.caseyAccount) })
    const area = isFieldAccount(req.caseyAccount) ? null : await areaInfoFor(store, c).catch(() => null)
    const reporterInfo = (!isFieldAccount(req.caseyAccount) || req.caseyAccess === 'write') ? await reporterSummary(store, c.contact_id, c.id).catch(() => null) : null
    const reporter = reporterInfo ? {
      people_on_phone: reporterInfo.people, shared_phone: reporterInfo.people > 1,
      reported_by: reporterInfo.reported_by ? { name: reporterInfo.reported_by.name, relation: reporterInfo.reported_by.relation, ...(isFieldAccount(req.caseyAccount) ? {} : { id: reporterInfo.reported_by.id }) } : null,
    } : null
    res.json({ ...fieldExtras, ...(area ? { area } : {}), ...(reporter ? { reporter } : {}), case: detailForAccess(caseDetailProjection(c, named, { keepKey: !isFieldAccount(req.caseyAccount) }), req.caseyAccess), events: (await nameEventAssignees(store, events, { field: isFieldAccount(req.caseyAccount) })).map(eventProjection), events_total, transitions, report_fill_rate, suggested_assignee, case_type_source })
  }
}

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
    const unknown = Object.keys(req.body).filter(k => !REPORT_KEY_SET.has(k) && !INTAKE_META_KEYS.has(k))
    if (unknown.length) return res.status(400).json({ error: `unknown report fields: ${unknown.join(', ')}` })
    if (!Object.keys(incoming).length) return res.status(400).json({ error: 'no report fields provided' })
    const op = actingOperator(req)
    const priorReport = parseReport(c)
    const result = await store.mergeReport(c.id, incoming, op)
    if (result.error) return res.status(400).json({ error: result.error })
    if (isFieldAccount(req.caseyAccount) && tagList(c).includes('sent-back')) await store.updateCase(c.id, { tags: tagList(c).filter(t => t !== 'sent-back').join(',') }, op)
    const corrections = {}
    const firstFills = {}
    for (const [k, v] of Object.entries(incoming)) {
      const prior = priorReport[k]
      if (prior != null && String(prior).trim() !== '') corrections[k] = { from: prior, to: v }
      else firstFills[k] = v
    }
    const data = { by: op.id, ...firstFills }
    if (Object.keys(corrections).length) data.corrections = corrections
    const canon = canonicalizedNote(req.body.canonicalized, incoming)
    if (canon) data.canonicalized = canon
    await store.appendEvent(c.id, { kind: 'action', actor: 'operator', text: isFieldAccount(req.caseyAccount) ? `recorded report fields on the reporter's behalf (relayed by ${op.name || op.id}): ${Object.keys(incoming).join(', ')}` : `recorded report fields via dashboard: ${Object.keys(incoming).join(', ')}`, data: isFieldAccount(req.caseyAccount) ? { ...data, relayed_by: op.id } : data })
    for (const k of Object.keys(incoming)) if (isKnownValueField(k)) invalidateKnownValues(k)
    res.json({ report: result.report, report_fill_rate: computeFillRate(JSON.stringify(result.report)) })
  }
}

export function getCaseEvents({ store, authed, clampLimit, offsetOf, parseEventData }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const limit = clampLimit(req.query.limit, 50)
    const offset = offsetOf(req.query.offset)
    const page = await timelinePageFor(store, req.params.id, { limit, offset }, req.caseyAccount, parseEventData)
    const events = (await nameEventAssignees(store, page.events, { field: isFieldAccount(req.caseyAccount) })).map(eventProjection)
    res.json({ events, offset, limit })
  }
}

export function patchCase({ store, authed, str, AUTONOMY, PRIORITY, CASE_TYPE, actingOperator, UNCLAIMED_ASSIGNEE }) {
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
    const patchReason = str(res, req.body, 'reason', { required: false }); if (patchReason === undefined) return
    let prior = await store.getCase(req.params.id)
    if (req.body && req.body.expected != null) {
      if (typeof req.body.expected !== 'object' || Array.isArray(req.body.expected)) {
        return res.status(400).json({ error: 'expected must be an object of field -> prior value' })
      }
      const COLUMN_DEFAULT = { autonomy: 'auto', case_type: 'unset' }
      const norm = (v, k) => {
        const s = v == null ? '' : String(v)
        return (s === '' && k in COLUMN_DEFAULT) ? COLUMN_DEFAULT[k] : s
      }
      const stale = Object.keys(patch).filter(k => k in req.body.expected && norm(prior?.[k], k) !== norm(req.body.expected[k], k))
      if (stale.length) {
        return res.status(409).json({
          error: `this case was changed by someone else (${stale.join(', ')}) -- reload and try again`,
          conflicted_fields: stale,
        })
      }
    }
    if (Object.keys(patch).some(k => k !== 'autonomy' && k !== 'assignee')) {
      if (prior?.autonomy === 'observe') return res.status(400).json({ error: 'case autonomy is observe; only autonomy and assignee can be changed' })
    }
    const op = actingOperator(req)
    if ('assignee' in patch) {
      if (!prior) return res.status(404).json({ error: 'not found' })
      const want = String(patch.assignee || '').trim()
      const had = String(prior.assignee || '').trim()
      const target = want === UNCLAIMED_ASSIGNEE ? '' : want
      const held = had && had !== UNCLAIMED_ASSIGNEE
      delete patch.assignee
      if (target !== (held ? had : '')) {
        let contact = null
        if (isContactAssignee(target)) {
          contact = await store.getContact(contactIdOfAssignee(target))
          if (!contact) return res.status(400).json({ error: 'that team member is not registered' })
          if (!atLeast(contact.tier, TIER_FIELD_WORKER)) return res.status(400).json({ error: 'that person is not on the team (they hold no team role), so a report cannot be assigned to them' })
          if (isOwnConversation(prior, contact)) return res.status(400).json({ error: 'that is this team member\'s own chat with the assistant, not a report to assign to them' })
        } else if (target && !(await findAccountByUsername(store, target))) {
          return res.status(400).json({ error: 'no team member or login by that name' })
        }
        const by = op.name || op.id
        if (held) { await releaseCase({ store, caseRow: prior, by, user: op }); clearFocusForCase(prior.id) }
        if (target) {
          await store.updateCase(prior.id, { assignee: target }, op)
          const data = { assignee: target, by }
          if (contact) { data.assigned_contact_id = contact.id; data.assigned_name = contact.display_name || '' }
          await store.appendEvent(prior.id, { kind: 'action', actor: 'operator', text: 'edited assignee', data })
        }
        prior = await store.getCase(req.params.id)
      }
      if (!Object.keys(patch).length) {
        const after = await store.getCase(req.params.id)
        store.learnOperatorActivity(op.id, after).catch(() => {})
        return res.json(await writeProjection(store, after, req))
      }
    }
    let updated
    try {
      updated = await store.updateCase(req.params.id, patch, op, prior?._version != null ? { expectedVersion: prior._version } : {})
    } catch (e) {
      if (e.code === 'conflict') return res.status(409).json({ error: 'this case was changed by someone else -- reload and try again' })
      throw e
    }
    if (!updated) return res.status(404).json({ error: 'not found' })
    store.learnOperatorActivity(op.id, updated).catch(() => {})
    const autonomyChanged = 'autonomy' in patch && prior && prior.autonomy !== patch.autonomy
    if (autonomyChanged) {
      await store.appendEvent(req.params.id, {
        kind: 'autonomy_change', actor: 'operator',
        text: `autonomy ${prior.autonomy} -> ${patch.autonomy}`,
        data: { from: prior.autonomy, to: patch.autonomy, by: op.id, reason: patchReason || '' },
      })
    }
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
    res.json(await writeProjection(store, updated, req))
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
    const legal = store.availableTransitions(c, op)
    if (to !== c.status && !legal.includes(to)) {
      return res.status(400).json({ error: `cannot transition to '${to}'`, allowed: legal })
    }
    if (MANDATORY_MINIMUM_BLOCKED_STATUSES.includes(to) && SIGNOFF_DIAGNOSIS_FIELDS.length) {
      const given = {}
      for (const k of SIGNOFF_DIAGNOSIS_FIELDS) if (typeof req.body?.[k] === 'string' && req.body[k].trim()) given[k] = req.body[k].trim()
      if (Object.keys(given).length) {
        const merged = await store.mergeReport(c.id, given, op, { bypassObserve: true, autoAssign: false })
        if (merged.error) return res.status(400).json({ error: merged.error })
        await store.appendEvent(c.id, { kind: 'action', actor: 'operator', text: `diagnosis recorded at sign-off: ${Object.keys(given).map(fieldLabel).join(', ')}`, data: { by: op.id, signoff: true, ...given } })
      }
    }
    await store.transition(req.params.id, to, { user: op, reason: reason || 'operator override' })
    const after = await store.getCase(req.params.id)
    store.learnOperatorActivity(op.id, after).catch(() => {})
    res.json(await writeProjection(store, after, req))
  }
}

export function postBulk({ store, authed, actingOperator, sendReply }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : null
    if (!ids || !ids.length) return res.status(400).json({ error: 'ids must be a non-empty array' })
    if (ids.length > 500) return res.status(413).json({ error: 'too many ids (max 500 per bulk request)' })
    const action = String(req.body?.action || '')
    const ACTIONS = new Set(['claim', 'transition', 'tag', 'untag', 'note', 'draft_approve', 'draft_discard', 'remind'])
    if (!ACTIONS.has(action)) return res.status(400).json({ error: `unknown action '${action}'`, allowed: [...ACTIONS] })
    const op = actingOperator(req)
    const to = action === 'transition' ? String(req.body?.to || '') : null
    if (action === 'transition' && !to) return res.status(400).json({ error: 'transition requires a "to" stage' })
    const NOTE_MAX_LEN = 4000
    const tag = (action === 'tag' || action === 'untag') ? String(req.body?.tag || '').trim() : null
    if ((action === 'tag' || action === 'untag') && !tag) return res.status(400).json({ error: `${action} requires a "tag"` })
    if ((action === 'tag' || action === 'untag') && /[,]/.test(tag)) return res.status(400).json({ error: 'tag must not contain a comma' })
    if ((action === 'tag' || action === 'untag') && tag.length > NOTE_MAX_LEN) {
      return res.status(413).json({ error: `tag too long (max ${NOTE_MAX_LEN})` })
    }
    const noteText = action === 'note' ? String(req.body?.text || '').trim() : null
    if (action === 'note' && !noteText) return res.status(400).json({ error: 'note requires non-empty "text"' })
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
        } else if (action === 'remind') {
          const plan = await prepareReminder({ store, caseRow: c })
          if (!plan.ok) { results.push({ id, ok: false, error: plan.error }); continue }
          let delivered = false
          if (sendReply) {
            try { await sendReply(c, plan.text); delivered = true }
            catch (e) { await store.appendEvent(id, { kind: 'observation', actor: 'system', text: `Failed to send operator reminder on channel: ${e.message || 'unknown error'}` }) }
          }
          await appendReplyEvent(store, c, plan.text, op, {
            delivered, reason: sendReply ? 'send_failed' : 'no_channel',
            extra: { [OPERATOR_REMINDER_FLAG]: true, operator_authored: false, quiet_for_ms: plan.quietForMs, breaches: plan.breaches, bulk: true },
          })
          if (!delivered) { results.push({ id, ok: false, error: 'send failed' }); continue }
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
      until = now + Math.min(Math.max(m, 0), 60 * 24 * 14) * 60000
    } else {
      return res.status(400).json({ error: 'snooze requires "minutes" or "until"' })
    }
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

export function postUndo({ store, authed, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const c = await store.getCase(req.params.id)
    if (!c) return res.status(404).json({ error: 'not found' })
    const op = actingOperator(req)
    const { evData } = await import('../../overview.js')
    const { toDate } = await import('../../format.js')
    const WINDOW_MS = 120000
    const now = Date.now()
    const events = await store.listEvents(c.id)
    const undoneIds = new Set()
    for (const e of events) { const d = evData(e); if (d.undo_of) undoneIds.add(String(d.undo_of)) }
    const isRecent = (e) => {
      const d = e.created_at ? toDate(e.created_at) : null
      return d ? (now - d.getTime()) <= WINDOW_MS : true
    }
    let target = null, kind = null
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (undoneIds.has(String(e.id))) continue
      if (!isRecent(e)) break
      if (e.kind === 'transition' && e.actor === 'operator') {
        if (evData(e).reason === 'undo') continue
        target = e; kind = 'transition'; break
      }
      if (e.kind === 'action' && e.actor === 'operator') {
        const txt = String(e.text || '')
        if (/^Undo by/.test(txt)) continue
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
    const relayed = isFieldAccount(req.caseyAccount) && req.body.relayed === true
    await store.appendEvent(req.params.id, { kind: 'note', actor: 'operator', text: relayed ? `Relayed by ${op.name || op.id} (told to them by the reporter, not written by the reporter): ${text}` : text, data: { ...(field ? { field } : {}), by: op.id, ...(relayed ? { relayed: true } : {}) } })
    res.json({ ok: true })
  }
}

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
    if (!tagList(c).includes('flagged-reply')) {
      await store.updateCase(req.params.id, { tags: mergeTag(c.tags, 'flagged-reply') })
    }
    res.json({ ok: true })
  }
}

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

export function postSplit({ store, authed, str, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const { event_ids } = req.body
    if (!Array.isArray(event_ids) || !event_ids.length) return res.status(400).json({ error: 'event_ids must be a non-empty array' })
    const subject = str(res, req.body, 'subject', { required: false }); if (subject === undefined) return
    const reason = str(res, req.body, 'reason', { required: false }); if (reason === undefined) return
    const result = await store.splitCase(req.params.id, event_ids, { subject: subject || '', reason: reason || 'operator split' }, actingOperator(req))
    if (result.error) return res.status(400).json({ error: result.error })
    res.json({ ok: true, new_case_id: result.newCase?.id, new_case_ref: result.newCase?.ref, moved_events: result.movedEvents })
  }
}

export function postReply({ store, authed, str, actingOperator, sendReply, UNCLAIMED_ASSIGNEE }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const raw = str(res, req.body, 'text'); if (raw === undefined) return
    const text = raw.trim()
    if (!text) return res.status(400).json({ error: 'empty reply' })
    const c = await store.getCase(req.params.id)
    if (!c) return res.status(404).json({ error: 'not found' })
    if (tagList(c).includes('opted-out')) return res.status(409).json({ error: 'This person asked us to stop messaging them, so nothing was sent.' })
    const op = actingOperator(req)
    let delivered = false
    if (sendReply) {
      try { await sendReply(c, text); delivered = true }
      catch (e) {
        await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `Failed to send operator reply on channel: ${e.message || 'unknown error'}` })
      }
    }
    let claimed = false
    if (delivered) {
      const current = String(c.assignee || '').trim()
      if (!current || current === UNCLAIMED_ASSIGNEE) {
        await store.updateCase(c.id, { assignee: op.id }, op)
        await store.appendEvent(c.id, { kind: 'action', actor: 'operator', text: `Claimed by ${op.name || op.id}`, data: { claimed_by: op.id, was: current || null } })
        claimed = true
      }
    }
    if (delivered && req.caseyRole && (c.autonomy || 'auto') === 'auto') {
      await store.updateCase(c.id, { autonomy: 'observe' }, op)
      await store.appendEvent(c.id, { kind: 'autonomy_change', actor: 'operator', text: 'autonomy auto -> observe', data: { from: 'auto', to: 'observe', by: op.name || op.id, reason: 'a team member took over the conversation' } })
    }
    await appendReplyEvent(store, c, text, op, { delivered, reason: sendReply ? 'send_failed' : 'no_channel' })
    store.learnOperatorActivity(op.id, c).catch(() => {})
    if (delivered) {
      const tags = tagList(c)
      const keep = tags.filter(t => t !== 'needs-human' && t !== 'ai-offline')
      if (keep.length !== tags.length) {
        await store.updateCase(c.id, { tags: keep.join(',') }, op)
      }
    }
    res.json({ ok: delivered, sent: !!sendReply, delivered, claimed, recorded: delivered ? 'outbound' : 'note' })
  }
}

export function postRemind({ store, authed, str, actingOperator, sendReply }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const c = await store.getCase(req.params.id)
    if (!c) return res.status(404).json({ error: 'not found' })
    let override = null
    if (req.body && typeof req.body.text === 'string' && req.body.text.trim()) {
      const edited = str(res, req.body, 'text', { required: false }); if (edited === undefined) return
      override = edited
    }
    const plan = await prepareReminder({ store, caseRow: c, overrideText: override })
    if (!plan.ok) return res.status(plan.status).json({ error: plan.error, ...(plan.reminded_at ? { reminded_at: plan.reminded_at } : {}) })
    const op = actingOperator(req)
    let delivered = false
    if (sendReply) {
      try { await sendReply(c, plan.text); delivered = true }
      catch (e) { await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `Failed to send operator reminder on channel: ${e.message || 'unknown error'}` }) }
    }
    await appendReplyEvent(store, c, plan.text, op, {
      delivered, reason: sendReply ? 'send_failed' : 'no_channel',
      extra: {
        [OPERATOR_REMINDER_FLAG]: true,
        operator_authored: plan.operator_authored,
        quiet_for_ms: plan.quietForMs,
        breaches: plan.breaches,
      },
    })
    store.learnOperatorActivity(op.id, c).catch(() => {})
    res.json({ ok: delivered, sent: !!sendReply, delivered, text: plan.text, recorded: delivered ? 'outbound' : 'note' })
  }
}

export function postDraftApprove({ store, authed, str, actingOperator, sendReply }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const c = await store.getCase(req.params.id)
    if (!c) return res.status(404).json({ error: 'not found' })
    const draft = await pendingDraft(store, c)
    if (!draft) return res.status(409).json({ error: 'no pending draft' })
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
    await appendReplyEvent(store, c, text, op, { delivered, reason: sendReply ? 'send_failed' : 'no_channel', extra: { from_draft: true } })
    if (delivered) {
      await store.updateCase(c.id, { tags: dropTag(c.tags, 'draft-pending', 'needs-human') }, op)
    }
    res.json({ ok: delivered, sent: !!sendReply, delivered, recorded: delivered ? 'outbound' : 'note' })
  }
}

export function postDraftDiscard({ store, authed, str, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const c = await store.getCase(req.params.id)
    if (!c) return res.status(404).json({ error: 'not found' })
    const draft = await pendingDraft(store, c)
    if (!draft) return res.status(409).json({ error: 'no pending draft' })
    const rawReason = str(res, req.body, 'reason', { required: false }); if (rawReason === undefined) return
    const reason = rawReason.trim() || 'operator discarded'
    const op = actingOperator(req)
    await store.updateCase(c.id, { tags: dropTag(c.tags, 'draft-pending') }, op)
    await store.appendEvent(c.id, { kind: 'observation', actor: 'operator', text: `DRAFT DISCARDED: ${reason}.`, data: { by: op.id } })
    res.json({ ok: true })
  }
}

const FIELD_DEF_BY_KEY = new Map((REPORT_FIELD_DEFS || []).filter(f => f && f.key).map(f => [f.key, f]))
const MULTILINE_FILL_LINES = 3
function fillLinesHtml(key) {
  const d = FIELD_DEF_BY_KEY.get(key)
  const n = (d && (d.multiline === true || d.append === true)) ? MULTILINE_FILL_LINES : 1
  return `<span class="ds-fill-lines" aria-hidden="true">${'<span class="ds-fill-line"></span>'.repeat(n)}</span>`
}

export function getReportHtml({ store, authed, esc, REPORT_KEY_LIST, printableReport }) {
  return async (req, res) => {
    try {
      if (!authed(req)) return res.status(401).send('<p>Unauthorized.</p>')
      const c = await store.getCase(req.params.id)
      if (!c) return res.status(404).send('<p>Case not found.</p>')
      let r = parseReport(c)
      const mediaLinkRe = /\(saved: (media\/[^)]+)\)/g
      const hidden = new Set(hiddenFieldsFor(req.caseyAccount && req.caseyAccount.role))
      const rows = REPORT_KEY_LIST.filter(k => !hidden.has(k)).map(k => {
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
      const mapsUrl = r.location ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(String(r.location))}` : null
      const phone = c.external_id || ''
      const telLink = /^[+0-9]{7,}$/.test(phone.replace(/[\s\-()]/g, '')) ? `tel:${phone.replace(/[\s\-()]/g, '')}` : null
      const extraCss = `body{max-width:700px;margin:var(--space-5) auto}`
        + `table{width:100%}th{width:40%;font-weight:600;vertical-align:top}td{vertical-align:top}`
        + `.maplink{font-size:var(--fs-micro)}`
        + `.act{display:flex;gap:var(--space-2-75);flex-wrap:wrap;margin:var(--space-2-5) 0 var(--space-4)}`
        + `.act a{background:${BRAND.ground};color:${BRAND.ink};padding:var(--space-2) var(--space-3);border-radius:6px;text-decoration:none;font-size:var(--fs-xs);font-weight:600}`
        + `.act a:hover{background:${BRAND.hover}}`
        + `@media print{.act{display:none}}`
      const who = await reporterSummary(store, c.contact_id, c.id).catch(() => null)
      const whoLine = who && who.people > 1
        ? `<p><strong>Reported by:</strong> ${esc(who.reported_by ? who.reported_by.name : 'not recorded')}, shared phone: ${who.people} people</p>` : ''
      const body = `<h1>Field briefing: ${esc(c.ref||c.id)}</h1>
<p><strong>Subject:</strong> ${esc(c.subject||'')}</p>${whoLine}
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
  ['post', '/api/cases/:id/location', postLocation],
  ['post', '/api/cases/:id/send-back', postSendBack],
  ['post', '/api/cases/:id/flag-reply', postFlagReply],
  ['get', '/api/cases/:id/suggestions', getSuggestions],
  ['get', '/api/cases/:id/site-history', getSiteHistory],
  ['post', '/api/cases/:id/merge', postMerge],
  ['post', '/api/cases/:id/split', postSplit],
  ['post', '/api/cases/:id/reply', postReply],
  ['post', '/api/cases/:id/remind', postRemind],
  ['post', '/api/cases/:id/draft/approve', postDraftApprove],
  ['post', '/api/cases/:id/draft/discard', postDraftDiscard],
  ['get', '/api/cases/:id/report.html', getReportHtml, { raw: true }],
]

export function postLocation({ store, authed, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const lat = Number(req.body?.lat), lon = Number(req.body?.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return res.status(400).json({ error: 'That position is not valid.' })
    const c = await store.getCase(req.params.id)
    if (!c) return res.status(404).json({ error: 'not found' })
    const op = actingOperator(req)
    await store.updateCase(c.id, { lat, lon, location_source: 'gps', location_confidence: 100 }, op)
    await store.appendEvent(c.id, { kind: 'action', actor: 'operator', text: 'location marked from the field', data: { by: op.id, lat, lon } })
    res.json({ ok: true })
  }
}

export function postSendBack({ store, authed, str, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const c = await store.getCase(req.params.id)
    if (!c) return res.status(404).json({ error: 'not found' })
    const text = str(res, req.body, 'text', { required: false }); if (text === undefined) return
    const missing = Array.isArray(req.body?.missing) ? req.body.missing.filter(k => typeof k === 'string').slice(0, 20) : []
    if (!text.trim() && !missing.length) return res.status(400).json({ error: 'Say what is missing so it can be fixed.' })
    const op = actingOperator(req)
    await sendBackToRanger(store, c.id, { by: op.name || op.id, user: op, text, missing, data: { by: op.id } })
    res.json({ ok: true })
  }
}

export function registerCases(app, deps) {
  mountRoutes(app, deps, ROUTES)
}
