// hooks/staff-outbound.js  --  a team member's message to a reporter, sent over
// the channel from the agent tool surface (case_message, team_remind,
// team_draft, case_ask_ranger).
//
// ONE outbound seam. Every send here goes through the `sendReply(caseRow, text)`
// the caller hands in -- casey.js's Casey.sendReply, the very function the
// dashboard's operator reply, reminder and draft-approve routes call -- never an
// adapter of its own. What this file adds is only what those routes' callers
// have to be true BEFORE calling it, stated once:
//
//   - opt-out: a person who said STOP is never messaged (OPTED_OUT_TAG);
//   - the 24h session window: measured from the reporter's own last inbound
//     (hooks/notifiers.js withinSessionWindow). casey has no template messages,
//     so outside the window a free-form send is rejected by Meta rather than
//     delivered; this returns an honest refusal BEFORE the attempt instead of a
//     silent no-op or a delivered-looking timeline row;
//   - a wired channel: no sendReply / no adapter for the channel is a refusal.
//
// RECORDING. A delivered message is an `outbound` event with actor 'operator'
// (the event.actor enum has no other human value, and workload.js / case-sweep.js
// already read an operator outbound as "a person answered") and data.by = the
// sender's display id, data.by_tier = their rung. NEVER actor 'agent': nothing
// the model decided produced these words. An undelivered send is recorded as a
// note that says so in its own first words, never as an outbound (an outbound
// row means the reporter received it).
//
// HUMAN TAKES OVER. After a delivered message the sender owns the case when it
// was unclaimed (the dashboard's claim-on-reply), and when the sender IS the
// assignee an 'auto' case moves to 'observe' with a recorded autonomy_change --
// the existing mechanism (hooks/case-intake.js's observe gate) that stops the
// agent replying over a person. Inbound is still recorded and STOP/HUMAN still
// fire; releaseCase() below is the way back to 'auto'.

import { tagList } from '../timestamp.js'
import { OPTED_OUT_TAG } from './heuristics.js'
import { assigneeKeyFor, isAssignedTo } from '../case-assignment.js'
import { UNCLAIMED_ASSIGNEE } from '../case-store.js'

export const STAFF_TEXT_MAX_LEN = 4000

// The sender's display id. A contact whose name is only their own number (the
// findOrCreateContact fallback) must not put that number on the timeline.
export function staffLabel(contact) {
  const name = String(contact?.display_name || '').trim()
  if (name && !/^\+?[\d\s()-]{6,}$/.test(name)) return name.slice(0, 80)
  return 'a team member'
}

// Refusal-or-null for messaging this case's reporter right now. Returns
// { error } (honest, plain) or { recent } when sending is allowed.
export async function outboundRefusal(store, caseRow, { canSend = null, sendReply = null, now = Date.now() } = {}) {
  if (!caseRow) return { error: 'no such record' }
  if (!sendReply || (canSend && !canSend(caseRow.channel))) {
    return { error: 'nothing was sent: this conversation is not attached to a messaging channel right now' }
  }
  if (tagList(caseRow).includes(OPTED_OUT_TAG)) {
    return { error: 'nothing was sent: this person asked us not to message them again' }
  }
  // Imported lazily: notifiers.js reaches handler.js -> inbound-turn.js ->
  // turn-attempts.js, which builds the toolset at module load, so a static import
  // here would close a cycle back onto case-tools.js while it is still evaluating.
  const { withinSessionWindow, sessionWindowHours } = await import('./notifiers.js')
  let recent = []
  try { recent = await store.listEventsPage(caseRow.id, { limit: 25, offset: 0 }) }
  catch (e) { return { error: `nothing was sent: could not read this conversation's history (${e.message})` } }
  if (!withinSessionWindow(caseRow, recent, now)) {
    return { error: `nothing was sent: this person last wrote more than ${sessionWindowHours()}h ago, outside WhatsApp's free reply window, so the message would be rejected rather than delivered. Reach them another way if it cannot wait.` }
  }
  return { recent }
}

// Send `text` to the case's reporter and record it. `staff` is the sender's
// contact row; `extra` lands in the outbound event's data (e.g. operator_reminder).
// `answers:false` (a reminder) leaves needs-human in place; `claim:false` skips the
// claim-on-reply.
// Returns { ok:true, ... } or { ok:false, error } -- never throws on a refusal.
export async function sendStaffMessage({ store, sendReply, canSend = null, caseRow, text, staff, extra = {}, claim = true, answers = true, dropTags = [], now = Date.now() }) {
  const body = String(text || '').trim()
  if (!body) return { ok: false, error: 'nothing was sent: the message is empty' }
  if (body.length > STAFF_TEXT_MAX_LEN) return { ok: false, error: `nothing was sent: the message is too long (max ${STAFF_TEXT_MAX_LEN})` }
  const gate = await outboundRefusal(store, caseRow, { canSend, sendReply, now })
  if (gate.error) return { ok: false, error: gate.error }
  const by = staffLabel(staff)
  const data = { to: caseRow.external_id, by, by_tier: staff?.tier || '', staff_contact_id: staff?.id || '', ...extra }
  try { await sendReply(caseRow, body) }
  catch (e) {
    await store.appendEvent(caseRow.id, {
      kind: 'note', actor: 'operator', channel: caseRow.channel,
      text: `NOT SENT to the contact (the channel refused it). ${by} wrote: ${body}`,
      data: { undelivered: true, reason: 'send_failed', by, text: body, ...extra },
    })
    return { ok: false, error: `nothing was sent: the channel refused the message (${e.message || 'unknown error'})` }
  }
  let claimed = false
  let tookOver = false
  let current = caseRow
  if (claim && staff?.id) {
    const assignee = String(caseRow.assignee || '').trim()
    if (!assignee || assignee === UNCLAIMED_ASSIGNEE) {
      current = await store.updateCase(caseRow.id, { assignee: assigneeKeyFor(staff) }, { id: by, role: 'operator' }) || caseRow
      await store.appendEvent(caseRow.id, { kind: 'action', actor: 'operator', text: `Claimed by ${by}`, data: { claimed_by: assigneeKeyFor(staff), by, was: assignee || null } })
      claimed = true
    }
    if (isAssignedTo(current, staff) && (current.autonomy || 'auto') === 'auto') {
      await store.updateCase(caseRow.id, { autonomy: 'observe' }, { id: by, role: 'operator' })
      await store.appendEvent(caseRow.id, { kind: 'autonomy_change', actor: 'operator', text: 'autonomy auto -> observe', data: { from: 'auto', to: 'observe', by, reason: 'a team member took over the conversation' } })
      tookOver = true
    }
  }
  await store.appendEvent(caseRow.id, { kind: 'outbound', actor: 'operator', channel: caseRow.channel, text: body, data })
  // A delivered ANSWER satisfies the flags that asked for a person; a reminder
  // or nudge answers nobody, so it clears only what the caller names.
  const cleared = new Set([...(answers ? ['needs-human', 'ai-offline'] : []), ...dropTags])
  const tags = tagList(caseRow)
  const keep = tags.filter(t => !cleared.has(t))
  if (keep.length !== tags.length) await store.updateCase(caseRow.id, { tags: keep.join(',') }, { id: by, role: 'operator' })
  return { ok: true, delivered: true, claimed, took_over: tookOver, recorded: 'outbound' }
}

// The latest pending assisted draft for a case, or null (same rule as the
// dashboard: pending only while draft-pending is on the case).
export async function pendingDraft(store, caseRow) {
  if (!tagList(caseRow).includes('draft-pending')) return null
  const events = await store.listEvents(caseRow.id)
  const drafts = events.filter(e => e.kind === 'draft')
  return drafts.length ? drafts[drafts.length - 1] : null
}

// Hand a case back: unassign it and, when a person had taken over ('observe'),
// let the bot resume ('auto'). Recorded on the timeline either way.
export async function releaseCase({ store, caseRow, by, user }) {
  const patch = { assignee: UNCLAIMED_ASSIGNEE }
  const wasObserve = caseRow.autonomy === 'observe'
  if (wasObserve) patch.autonomy = 'auto'
  await store.updateCase(caseRow.id, patch, user)
  await store.appendEvent(caseRow.id, { kind: 'action', actor: 'operator', text: `edited assignee`, data: { assignee: UNCLAIMED_ASSIGNEE, by } })
  if (wasObserve) {
    await store.appendEvent(caseRow.id, { kind: 'autonomy_change', actor: 'operator', text: 'autonomy observe -> auto', data: { from: 'observe', to: 'auto', by, reason: 'handed back to the assistant' } })
  }
  return { autonomy: wasObserve ? 'auto' : caseRow.autonomy || 'auto', resumed: wasObserve }
}
