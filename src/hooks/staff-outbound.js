

import { tagList } from '../timestamp.js'
import { OPTED_OUT_TAG } from './heuristics.js'
import { assigneeKeyFor, isAssignedTo, isOwnConversation } from '../case-assignment.js'
import { UNCLAIMED_ASSIGNEE } from '../case-store.js'
import { withoutIssuedCodes } from '../role-invites.js'
import { proactiveRefusal } from '../proactive-sends.js'
import { vocabText } from '../config-loader.js'

export const STAFF_TEXT_MAX_LEN = 4000

const OUTBOUND_REFUSAL_DEFAULTS = {
  empty: ['ui.outbound_refused_empty', 'nothing was sent: the message is empty'],
  too_long: ['ui.outbound_refused_too_long', 'nothing was sent: the message is too long (max {max})'],
  registration_code: ['ui.outbound_refused_registration_code', 'nothing was sent: the message contains a registration code'],
  own_chat: ['ui.outbound_refused_own_chat', 'nothing was sent: that is this same chat with the assistant, not a reporter to message'],
}

function refusedSend(reason, vars = {}) {
  const [key, fallback] = OUTBOUND_REFUSAL_DEFAULTS[reason]
  return { ok: false, reason, error: vocabText(key, fallback, vars) }
}

export function staffLabel(contact) {
  const name = String(contact?.display_name || '').trim()
  if (name && !/^\+?[\d\s()-]{6,}$/.test(name)) return name.slice(0, 80)
  return 'a team member'
}

export async function outboundRefusal(store, caseRow, { canSend = null, sendReply = null, now = Date.now(), kind = 'message' } = {}) {
  if (!caseRow) return { error: 'no such record' }

  const noStart = proactiveRefusal({ kind })
  if (noStart) return { error: noStart }
  if (!sendReply || (canSend && !canSend(caseRow.channel))) {
    return { error: 'nothing was sent: this conversation is not attached to a messaging channel right now' }
  }
  if (tagList(caseRow).includes(OPTED_OUT_TAG)) {
    return { error: 'nothing was sent: this person asked us not to message them again' }
  }

  const { withinSessionWindow, sessionWindowHours } = await import('./notifiers.js')
  let recent = []
  try { recent = await store.listEventsPage(caseRow.id, { limit: 25, offset: 0 }) }
  catch (e) { return { error: `nothing was sent: could not read this conversation's history (${e.message})` } }
  if (!withinSessionWindow(caseRow, recent, now)) {
    return { error: `nothing was sent: this person last wrote more than ${sessionWindowHours()}h ago, outside WhatsApp's free reply window, so the message would be rejected rather than delivered. Reach them another way if it cannot wait.` }
  }
  return { recent }
}

export async function sendStaffMessage({ store, sendReply, canSend = null, caseRow, text, staff, extra = {}, claim = true, answers = true, dropTags = [], now = Date.now() }) {
  const body = String(text || '').trim()
  if (!body) return refusedSend('empty')
  if (body.length > STAFF_TEXT_MAX_LEN) return refusedSend('too_long', { max: STAFF_TEXT_MAX_LEN })

  if (await withoutIssuedCodes(store, body).catch(() => null) != null) return refusedSend('registration_code')
  if (isOwnConversation(caseRow, staff)) return refusedSend('own_chat')
  const gate = await outboundRefusal(store, caseRow, { canSend, sendReply, now, kind: extra?.staff_nudge ? 'staff_nudge' : 'message' })
  if (gate.error) return { ok: false, error: gate.error }
  const by = staffLabel(staff)
  const data = { to: caseRow.external_id, by, by_tier: staff?.tier || '', staff_contact_id: staff?.id || '', ...extra }
  try { await sendReply(caseRow, body) }
  catch (e) {
    await store.appendEvent(caseRow.id, {
      kind: 'note', actor: 'operator', channel: caseRow.channel,
      text: vocabText('ui.staff_note_channel_refused', 'Not sent: the channel refused it. {by} wrote: {body}', { by, body }),
      data: { undelivered: true, reason: 'send_failed', by, text: body, error: e.message || 'unknown error', ...extra },
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

  const cleared = new Set([...(answers ? ['needs-human', 'ai-offline'] : []), ...dropTags])
  const tags = tagList(caseRow)
  const keep = tags.filter(t => !cleared.has(t))
  if (keep.length !== tags.length) await store.updateCase(caseRow.id, { tags: keep.join(',') }, { id: by, role: 'operator' })
  return { ok: true, delivered: true, claimed, took_over: tookOver, recorded: 'outbound' }
}

export async function pendingDraft(store, caseRow) {
  if (!tagList(caseRow).includes('draft-pending')) return null
  const events = await store.listEvents(caseRow.id)
  const drafts = events.filter(e => e.kind === 'draft')
  return drafts.length ? drafts[drafts.length - 1] : null
}

const UNDELIVERED_REPLY_REASONS = {
  no_channel: 'this console is not attached to the messaging channels',
  send_failed: 'the channel refused it',
}
export function appendReplyEvent(store, c, text, op, { delivered, reason, extra = {} }) {
  if (delivered) {
    return store.appendEvent(c.id, { kind: 'outbound', actor: 'operator', channel: c.channel, text, data: { to: c.external_id, by: op.id, ...extra } })
  }
  const why = UNDELIVERED_REPLY_REASONS[reason] || 'the send did not happen'
  return store.appendEvent(c.id, {
    kind: 'note', actor: 'operator', channel: c.channel,
    text: `NOT SENT to the contact (${why}). Operator wrote: ${text}`,
    data: { undelivered: true, reason, by: op.id, text, ...extra },
  })
}

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
