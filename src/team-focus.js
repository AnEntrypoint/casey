

import { CASE_REF_RE } from './hooks/heuristics.js'
import { publicAssignee } from './case-assignment.js'
import { parseReport } from './timestamp.js'
import { reporterSummary, firstName } from './phone-persons.js'

export const FOCUS_IDLE_MS = Number(process.env.CASEY_TEAM_FOCUS_IDLE_MS) || 30 * 60e3
export const PROPOSAL_TTL_MS = 10 * 60e3

const focus = new Map()
const proposals = new Map()

export const refsIn = (text) => [...new Set((String(text || '').match(CASE_REF_RE) || []).map(r => r.toUpperCase()))]

export function identifyingLine(c) {
  const r = parseReport(c)
  const what = String(r.species || '').trim() || 'animals'
  const where = String(r.location || '').trim() || 'place not recorded'
  return `${what.slice(0, 60)} at ${where.slice(0, 80)}`
}

export async function recordedOn(store, c, ctx) {
  let first = 'the reporter'
  try {
    const contact = c.contact_id ? await store.getContact(c.contact_id) : null
    const name = String(contact?.display_name || '').trim().split(/\s+/)[0]
    if (name && !/^\+?\d[\d\s()-]*$/.test(name)) first = name.slice(0, 40)
  } catch {  }

  let shared = null
  try {
    const who = await reporterSummary(store, c.contact_id, c.id)
    if (who && who.reported_by) first = firstName(who.reported_by.name).slice(0, 40) || first
    if (who && who.people > 1) shared = `shared phone (${who.people} people)`
  } catch {  }
  return { ref: c.ref, what: identifyingLine(c), reporter: first, ...(shared ? { shared_phone: shared } : {}), assigned_to: publicAssignee(c.assignee, ctx?.contact) || 'nobody' }
}

export function focusOf(contactId, now = Date.now()) {
  const f = focus.get(contactId)
  if (!f) return null
  if (now - f.lastUsedAt > FOCUS_IDLE_MS) { focus.delete(contactId); return null }
  return f
}

export function proposeFocus(contactId, c, turn, now = Date.now()) {
  if (!contactId) return
  proposals.set(contactId, { caseId: c.id, ref: c.ref, at: now, turn })
}

export function setFocus(contactId, c, now = Date.now()) {
  if (contactId) focus.set(contactId, { caseId: c.id, ref: c.ref, lastUsedAt: now })
}

export function confirmFocus(contactId, c, turn, now = Date.now()) {
  const p = proposals.get(contactId)
  if (!p || p.caseId !== c.id) return { error: `There is nothing to confirm for ${c.ref}: ask which record they mean first, naming it, and wait for their answer.` }
  if (now - p.at > PROPOSAL_TTL_MS) { proposals.delete(contactId); return { error: `That question about ${c.ref} is too old to rely on: ask again and wait for their answer.` } }
  if (p.turn === turn) return { error: `Their answer about ${c.ref} has to come in a NEW message. Ask them now, end your reply with the question, and confirm only after they reply.` }
  proposals.delete(contactId)
  setFocus(contactId, c, now)
  return { ok: true }
}

export function clearFocusForCase(caseId) {
  for (const [k, f] of focus) if (f.caseId === caseId) focus.delete(k)
  for (const [k, p] of proposals) if (p.caseId === caseId) proposals.delete(k)
}

export function writeGate(ctx, c, now = Date.now()) {
  const me = ctx?.contact?.id
  const named = ctx?.inboundRefs || []
  const ours = String(c.ref).toUpperCase()
  const others = named.filter(r => r !== ours)
  if (others.length && named.length > 1) {
    return { error: `The message names more than one record (${named.join(', ')}). Nothing was recorded. Deal with them one at a time: ask which comes first.` }
  }
  if (others.length) {
    return { error: `The message names ${others[0]} but this would be recorded on ${c.ref}. Nothing was recorded. Ask which one they mean.` }
  }

  if (named.length === 1 && named[0] === ours) { if (me) setFocus(me, c, now); return null }
  const f = me ? focusOf(me, now) : null
  if (f && f.caseId === c.id) { f.lastUsedAt = now; return null }
  proposeFocus(me, c, ctx?.dedupeCache, now)
  return { error: `Not recorded yet: confirm the record first. Ask them "${c.ref} (${identifyingLine(c)}) -- is this the one?" as the last thing in your reply, and only after they answer yes in their NEXT message call case_focus with that record and confirm set to true, then repeat this.` }
}
