import { REPORT_CONCEPT as K } from './report-concepts.js'


import { CASE_REF_RE } from './hooks/heuristics.js'
import { publicAssignee, assigneeKeyFor } from './case-assignment.js'
import { isOpenCase } from './format.js'
import { missingMandatoryMinimum, fieldLabel } from './store/report-shape.js'
import { parseReport } from './timestamp.js'
import { reporterSummary, firstName } from './phone-persons.js'
import { confirmRecordChoices } from './choices.js'
import { caseyText } from './deployment-text.js';

export const FOCUS_IDLE_MS = Number(process.env.CASEY_TEAM_FOCUS_IDLE_MS) || 30 * 60e3
export const PROPOSAL_TTL_MS = 10 * 60e3

export const refsIn = (text) => [...new Set((String(text || '').match(CASE_REF_RE) || []).map(r => r.toUpperCase()))]

export function identifyingLine(c) {
  const r = parseReport(c)
  const what = String(r[K.kind] || '').trim() || caseyText("src/team-focus.js#s5")
  const where = String(r.location || '').trim() || caseyText("src/team-focus.js#s0")
  return `${what.slice(0, 60)} at ${where.slice(0, 80)}`
}

export async function recordedOn(store, c, ctx) {
  let first = caseyText("src/team-focus.js#s1")
  try {
    const contact = c.contact_id ? await store.getContact(c.contact_id) : null
    const name = String(contact?.display_name || '').trim().split(/\s+/)[0]
    if (name && !/^\+?\d[\d\s()-]*$/.test(name)) first = name.slice(0, 40)
  } catch {  }

  let shared = null
  try {
    const who = await reporterSummary(store, c.contact_id, c.id)
    if (who && who.reported_by) first = firstName(who.reported_by.name).slice(0, 40) || first
    if (who && who.people > 1) shared = caseyText("src/team-focus.js#s2", [who.people])
  } catch {  }
  return { ref: c.ref, what: identifyingLine(c), reporter: first, ...(shared ? { shared_phone: shared } : {}), assigned_to: publicAssignee(c.assignee, ctx?.contact) || 'nobody' }
}

const TOUCH_WRITE_INTERVAL_MS = 60e3

export async function focusOf(store, contactId, now = Date.now()) {
  if (!contactId) return null
  const f = (await store.readStaffState(contactId)).focus
  if (!f) return null
  if (now - f.lastUsedAt > FOCUS_IDLE_MS) {
    await store.mutateStaffState(contactId, (st) => { if (st.focus?.lastUsedAt === f.lastUsedAt) delete st.focus })
    return null
  }
  return f
}

export async function proposeFocus(store, contactId, c, turn, now = Date.now()) {
  if (!contactId) return
  await store.mutateStaffState(contactId, (st) => { st.proposal = { caseId: c.id, ref: c.ref, at: now, turn: String(turn || '') } })
}

export async function setFocus(store, contactId, c, now = Date.now()) {
  if (!contactId) return
  await store.mutateStaffState(contactId, (st) => { st.focus = { caseId: c.id, ref: c.ref, lastUsedAt: now } })
}

async function touchFocus(store, contactId, now) {
  await store.mutateStaffState(contactId, (st) => {
    if (st.focus && now - st.focus.lastUsedAt >= TOUCH_WRITE_INTERVAL_MS) st.focus.lastUsedAt = now
  })
}

export async function confirmFocus(store, contactId, c, turn, now = Date.now()) {
  return store.mutateStaffState(contactId, (st) => {
    const p = st.proposal
    if (!p || p.caseId !== c.id) return { error: caseyText("src/team-focus.js#0", [c.ref]) }
    if (now - p.at > PROPOSAL_TTL_MS) { delete st.proposal; return { error: caseyText("src/team-focus.js#1", [c.ref]) } }
    if (p.turn === String(turn || '')) return { error: caseyText("src/team-focus.js#2", [c.ref]) }
    delete st.proposal
    st.focus = { caseId: c.id, ref: c.ref, lastUsedAt: now }
    return { ok: true }
  })
}

export async function clearFocusForCase(store, caseId) {
  const holders = (await store.t.list('contact', {}, { limit: 2000 })).filter(h => typeof h.staff_state === 'string' && h.staff_state.includes(caseId))
  for (const h of holders) {
    await store.mutateStaffState(h.id, (st) => {
      if (st.focus?.caseId === caseId) delete st.focus
      if (st.proposal?.caseId === caseId) delete st.proposal
    })
  }
}

export function withinOneEdit(a, b) {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1)
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1)
}

export async function confusableHeldRefs(store, contact, ref) {
  const key = assigneeKeyFor(contact)
  if (!key) return []
  const upper = String(ref).toUpperCase()
  const held = (await store.listCases({ assignee: key }, { limit: 200 })).filter(isOpenCase)
  return held.map(c => String(c.ref).toUpperCase()).filter(r => r !== upper && withinOneEdit(r, upper))
}

export async function writeGate(store, ctx, c, { confirm = true } = {}, now = Date.now()) {
  const me = ctx?.contact?.id
  const named = ctx?.inboundRefs || []
  const ours = String(c.ref).toUpperCase()
  const others = named.filter(r => r !== ours)
  if (others.length && named.length > 1) {
    return { error: caseyText("src/team-focus.js#3", [named.join(', ')]) }
  }
  if (others.length) {
    return { error: caseyText("src/team-focus.js#4", [others[0], c.ref]) }
  }

  const needsConfirm = (ctx?.confirmRefs || []).includes(ours)
  if (named.length === 1 && named[0] === ours && !needsConfirm) { if (me) await setFocus(store, me, c, now); return null }
  const f = me ? await focusOf(store, me, now) : null
  if (f && f.caseId === c.id) { await touchFocus(store, me, now); return null }
  if (!confirm) return null
  await proposeFocus(store, me, c, ctx?.turnId, now)
  return { error: caseyText("src/team-focus.js#5", [c.ref, identifyingLine(c)]), ...confirmRecordChoices(c.ref) }
}

export async function staffProgressLine(store, contact, now = Date.now()) {
  const f = contact?.id ? await focusOf(store, contact.id, now) : null
  const c = f ? await store.getCase(f.caseId) : null
  if (!c) return ''
  const missing = missingMandatoryMinimum(parseReport(c)).map(fieldLabel)
  return caseyText("src/team-focus.js#s3", [c.ref, identifyingLine(c), String(c.status || 'new').replace(/_/g, ' '), missing.length ? caseyText("src/team-focus.js#s4", [missing.join(', ')]) : ''])
}
