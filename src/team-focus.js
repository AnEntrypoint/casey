// team-focus.js  --  which record a field-team member is working on RIGHT NOW,
// enforced in code so a fact relayed for one farm is never written to another.
//
// A ranger or technician (authority 'assigned', case-tools-team-shared.js) may
// hold several assigned records and talk about them in one chat. Every write
// tool in the team family names its record explicitly AND passes writeGate()
// first. The gate refuses, with a plain sentence that names the candidate, when:
//
//   1. the staff member's own inbound message names a record reference (an
//      exact CASE-<digits>-<suffix> token, pulled out by pattern -- extraction
//      of an identifier, not classification of intent) that is not the record
//      this write targets, or names more than one;
//   2. that record is not their CONFIRMED focus: nothing has been confirmed yet,
//      the focus went idle (CASEY_TEAM_FOCUS_IDLE_MS, default 30 min), or another
//      record was proposed since.
//
// Confirmation is two-step and structural: case_focus PROPOSES a record (or a
// refused write proposes it), and case_focus with confirm:true accepts it only
// when the proposal was made in an EARLIER turn -- the staff member's next
// message, not the same turn the model is composing -- for that same record and
// while it is still fresh (PROPOSAL_TTL_MS). The model still decides whether the
// person really said yes (no keyword routing); the code guarantees the answer
// came in a later message than the question.
//
// State is in memory by design: a restart empties it, and empty means "ask
// again", the fail-closed direction. Reassignment and sign-off call
// clearFocusForCase so a stale focus can never receive a write (the assignment
// check in authorityOn would refuse it anyway; this makes the binding go away).

import { CASE_REF_RE } from './hooks/heuristics.js'
import { publicAssignee } from './case-assignment.js'
import { parseReport } from './timestamp.js'

export const FOCUS_IDLE_MS = Number(process.env.CASEY_TEAM_FOCUS_IDLE_MS) || 30 * 60e3
export const PROPOSAL_TTL_MS = 10 * 60e3

const focus = new Map()      // contactId -> { caseId, ref, lastUsedAt }
const proposals = new Map()  // contactId -> { caseId, ref, at, turn }

export const refsIn = (text) => [...new Set((String(text || '').match(CASE_REF_RE) || []).map(r => r.toUpperCase()))]

// One identifying line, no phone number: what the animals are and where.
export function identifyingLine(c) {
  const r = parseReport(c)
  const what = String(r.species || '').trim() || 'animals'
  const where = String(r.location || '').trim() || 'place not recorded'
  return `${what.slice(0, 60)} at ${where.slice(0, 80)}`
}

// The shape every team write returns, so the transcript always shows what was touched.
export async function recordedOn(store, c, ctx) {
  let first = 'the reporter'
  try {
    const contact = c.contact_id ? await store.getContact(c.contact_id) : null
    const name = String(contact?.display_name || '').trim().split(/\s+/)[0]
    if (name && !/^\+?\d[\d\s()-]*$/.test(name)) first = name.slice(0, 40)
  } catch { /* the first name is a courtesy, never a dependency */ }
  return { ref: c.ref, what: identifyingLine(c), reporter: first, assigned_to: publicAssignee(c.assignee, ctx?.contact) || 'nobody' }
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

// null when the write may proceed, else { error } to hand straight back to the model.
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
  const f = me ? focusOf(me, now) : null
  if (f && f.caseId === c.id) { f.lastUsedAt = now; return null }
  proposeFocus(me, c, ctx?.dedupeCache, now)
  return { error: `Not recorded yet: confirm the record first. Ask them "${c.ref} (${identifyingLine(c)}) -- is this the one?" as the last thing in your reply, and only after they answer yes in their NEXT message call case_focus with that record and confirm set to true, then repeat this.` }
}
