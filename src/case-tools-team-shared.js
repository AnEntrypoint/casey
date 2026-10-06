

import { AGENT_USER, UNCLAIMED_ASSIGNEE } from './case-store.js'
import { isOperator, canQueryCases, atLeast, TIER_ANIMAL_HEALTH_TECHNICIAN } from './contact-tiers.js'
import { isAssignedTo, isOwnConversation, publicAssignee, assigneeKeyFor } from './case-assignment.js'
import { enquiryRow } from './case-tools-shared.js'
import { staffLabel } from './hooks/staff-outbound.js'
import { MANDATORY_MINIMUM_BLOCKED_STATUSES } from './store/report-shape.js'
import { isHandedOff } from './signoff-desk.js'
import { reportersForCases } from './phone-persons.js'

export const NOT_ASSIGNED = {
  error: 'This one is not assigned to you, so you can look at it but not change it or message the person who reported it. Say that plainly, and offer to ask an operator to assign it to you.',
}

export function doneStages() {
  return [...new Set(['resolved', 'closed', ...MANDATORY_MINIMUM_BLOCKED_STATUSES])]
}

export async function findCase(store, idOrRef) {
  const key = String(idOrRef || '').trim()
  if (!key) return null
  let c = null
  try { c = await store.getCase(key) } catch { c = null }
  if (!c) { try { c = await store.getCaseByRef(key) } catch { c = null } }

  return c && c.channel !== 'system' ? c : null
}

export function authorityOn(ctx, caseRow) {
  if (isOperator(ctx?.tier)) return 'operator'
  if (canQueryCases(ctx?.tier) && isAssignedTo(caseRow, ctx?.contact) && !isOwnConversation(caseRow, ctx?.contact)) return 'assigned'
  return null
}

export function deskAuthorityOn(ctx, caseRow) {
  const direct = authorityOn(ctx, caseRow)
  if (direct) return direct
  const a = String(caseRow?.assignee || '').trim()

  if (atLeast(ctx?.tier, TIER_ANIMAL_HEALTH_TECHNICIAN) && (!a || a === UNCLAIMED_ASSIGNEE || isHandedOff(caseRow)) && !isOwnConversation(caseRow, ctx?.contact)) return 'assigned'
  return null
}

export function storeUser(ctx, authority) {
  return authority === 'operator' ? { id: staffLabel(ctx?.contact), role: 'operator' } : AGENT_USER
}

export function actorData(ctx, extra = {}) {
  return { by: staffLabel(ctx?.contact), by_tier: ctx?.tier || '', staff_contact_id: ctx?.contact?.id || '', ...extra }
}

export function teamRow(c, ctx, extra = {}) {
  const row = enquiryRow(c)
  row.assignee = publicAssignee(c.assignee, ctx?.contact) || null
  return { ...row, ...extra }
}

export async function reporterExtras(store, cases) {
  const m = await reportersForCases(store, cases).catch(() => new Map())
  const extra = (c) => { const w = m.get(c.id); return w ? { ...(w.name ? { reported_by: w.name } : {}), ...(w.people > 1 ? { shared_phone: `shared phone (${w.people} people)` } : {}) } : {} }
  const text = (c) => { const w = m.get(c.id); return w ? { by_person: [w.name ? `reported by ${w.name}` : '', w.people > 1 ? `shared phone (${w.people} people)` : ''].filter(Boolean).join(', ') } : {} }
  return { extra, text }
}

export const NUMBER_FIELDS = ['owner_contact', 'contact_fallback']

const NUMBER_OR_REF = /(CASE-\d+-[a-z0-9]+)|(\+?\d[\d ()\-.]{5,}\d)/gi

export const scrubNumbers = (text) => String(text ?? '').replace(NUMBER_OR_REF, (m, ref) => (ref ? m : '(number not shown)'))

export function maskNumberFields(report) {
  if (!report) return report
  const out = { ...report }
  for (const k of NUMBER_FIELDS) if (out[k]) out[k] = 'recorded (not repeated here)'
  return out
}

export const stripSavedPaths = (text) => String(text || '').replace(/\s*\(saved: [^)]*\)/g, '')

export const cleanRelayed = (v) => typeof v === 'string'
  ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
  : v

export function ownFiledAuthority(ctx, caseRow) {
  return canQueryCases(ctx?.tier) && isAssignedTo(caseRow, ctx?.contact) && isOwnConversation(caseRow, ctx?.contact) ? 'own' : null
}

export async function claimSelfFiledReport(store, ctx, caseId) {
  const me = ctx?.contact
  if (!me?.id || !canQueryCases(ctx?.tier)) return false
  return store._withLock(`assign|${caseId}`, async () => {
    const c = await store.getCase(caseId)
    if (!c || !isOwnConversation(c, me)) return false
    const held = String(c.assignee || '').trim()
    if (held && held !== UNCLAIMED_ASSIGNEE) return false
    await store.updateCase(c.id, { assignee: assigneeKeyFor(me) }, AGENT_USER)
    await store.appendEvent(c.id, { kind: 'action', actor: 'system', text: `Filed by ${staffLabel(me)}, a team member, and assigned to them`, data: { self_filed: true, by: staffLabel(me), staff_contact_id: me.id } })
    return true
  })
}
