// signoff-desk.js  --  the hand-over from the ranger (the triage "nurse") to the
// animal health technician's sign-off desk (the "doctor"), as one rule in one
// place so the WhatsApp tools, the dashboard roles and the store agree.
//
// THE MARKER. A ranger who has confirmed the record is full hands it over:
// the record keeps its assignee (the ranger keeps supporting it) and gains the
// system tag `handed-off`. The tag is RESERVED (hooks/heuristics.js RESERVED_TAG):
// no team member adds or drops it by hand, only handoffToTechnician /
// withdrawHandoff below do, and each writes a timeline event.
//
// THE SIGN-OFF QUEUE RULE (least surprising):
//   an open record that already holds the mandatory minimum is on the desk when
//     (a) it has been HANDED OFF, whoever holds it, or
//     (b) nobody holds it (the unassigned-and-complete rule that predates this).
//   A complete record still assigned to a ranger and NOT handed over stays off the
//   desk: the ranger is still finishing triage, and the technician is not shown a
//   record its triage owner has not released. Withdrawing the hand-over (the
//   technician's send-back / case_ask_ranger) puts it back with the ranger.
//
// The desk reads this file's predicate; roles.js re-exports it and
// case-tools-team-review.js filters through it. Pure except for the two writers.

import { tagList, parseReport } from './timestamp.js'
import { MANDATORY_MINIMUM_BLOCKED_STATUSES, missingMandatoryMinimum, fieldLabel } from './store/report-shape.js'
import { mergeTag, dropTag } from './hooks/heuristics.js'

export const HANDED_OFF_TAG = 'handed-off'
const UNCLAIMED = 'agent'
const DONE = new Set(['resolved', 'closed', ...MANDATORY_MINIMUM_BLOCKED_STATUSES])

export const isDone = (c) => DONE.has(String(c?.status || ''))
export const isHandedOff = (c) => tagList(c).includes(HANDED_OFF_TAG)
export const isUnheld = (c) => { const a = String(c?.assignee || '').trim(); return !a || a === UNCLAIMED }

export function inSignOffQueue(c, unclaimedKey = UNCLAIMED) {
  if (!c || isDone(c)) return false
  if (missingMandatoryMinimum(parseReport(c)).length) return false
  if (isHandedOff(c)) return true
  const a = String(c.assignee || '').trim()
  return !a || a === unclaimedKey
}

// Hand a record to the sign-off desk. `user` is the store actor for the write;
// `by` the display name for the timeline; `data` extra event data (actorData).
// Refuses, with a plain reason and a machine `code`, a record that is finished, a
// record missing part of the mandatory minimum (named) and one already handed over
// (reported as ok, not an error: the second click changes nothing).
export async function handoffToTechnician(store, caseId, { by = 'a team member', user, data = {}, note = '' } = {}) {
  return store._withLock(`assign|${caseId}`, async () => {
    const c = await store.getCase(caseId)
    if (!c || c.channel === 'system') return { ok: false, code: 'not_found', error: 'No such record.' }
    if (isDone(c)) return { ok: false, code: 'finished', error: 'That record is already finished, so there is nothing to hand over.' }
    const missing = missingMandatoryMinimum(parseReport(c))
    if (missing.length) {
      return { ok: false, code: 'missing_minimum', missing, error: `Not ready to hand over: ${missing.map(fieldLabel).join(', ')} ${missing.length === 1 ? 'is' : 'are'} still not recorded. Record ${missing.length === 1 ? 'it' : 'them'} first.` }
    }
    if (isHandedOff(c)) return { ok: true, already: true, ref: c.ref }
    await store.updateCase(c.id, { tags: mergeTag(c.tags || '', HANDED_OFF_TAG) }, user)
    await store.appendEvent(c.id, {
      kind: 'action', actor: 'operator',
      text: `HANDED TO THE SIGN-OFF DESK by ${by}${note ? `: ${String(note).slice(0, 400)}` : ''}`,
      data: { ...data, by, handed_off: true },
    })
    return { ok: true, ref: c.ref }
  })
}

// Take the hand-over back (the technician sent the record back, or a hand-over was
// made by mistake). Silent no-op when the record was never handed over.
export async function withdrawHandoff(store, caseId, { by = 'a team member', user, reason = '', data = {} } = {}) {
  return store._withLock(`assign|${caseId}`, async () => {
    const c = await store.getCase(caseId)
    if (!c) return { ok: false, code: 'not_found', error: 'No such record.' }
    if (!isHandedOff(c)) return { ok: true, was: false, ref: c.ref }
    await store.updateCase(c.id, { tags: dropTag(c.tags || '', HANDED_OFF_TAG) }, user)
    await store.appendEvent(c.id, {
      kind: 'action', actor: 'operator',
      text: `HAND-OVER WITHDRAWN by ${by}${reason ? `: ${String(reason).slice(0, 400)}` : ''}`,
      data: { ...data, by, handoff_withdrawn: true },
    })
    return { ok: true, was: true, ref: c.ref }
  })
}

// The technician sends a record back to whoever is working it, saying what is
// missing: the `sent-back` tag (the ranger's list puts it first), one note on the
// timeline, and the hand-over withdrawn. Nothing is sent to any channel. Used by
// the dashboard send-back and by case_ask_ranger for a record the public filed.
export async function sendBackToRanger(store, caseId, { by = 'a team member', user, text = '', missing = [], data = {} } = {}) {
  const c = await store.getCase(caseId)
  if (!c || c.channel === 'system') return { ok: false, error: 'No such record.' }
  const tags = tagList(c)
  if (!tags.includes('sent-back')) await store.updateCase(c.id, { tags: mergeTag(c.tags || '', 'sent-back') }, user)
  const line = `Sent back by ${by}${missing.length ? `: still needed -- ${missing.join(', ')}` : ''}${String(text).trim() ? `. ${String(text).trim()}` : ''}`
  await store.appendEvent(c.id, { kind: 'note', actor: 'operator', text: line, data: { ...data, by: data.by || by, sent_back: true, missing } })
  await withdrawHandoff(store, c.id, { by, user, reason: 'sent back' })
  return { ok: true, ref: c.ref }
}
