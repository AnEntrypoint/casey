

import { tagList } from './timestamp.js'
import { assigneeKeyFor } from './case-assignment.js'
import { isOpenCase } from './format.js'
import { evData } from './safe.js'
import { canSignOff } from './contact-tiers.js'
import { isHandedOff } from './signoff-desk.js'
import { isOwnConversation } from './case-assignment.js'
import { TECHNICIAN_NOTE, notesTagged, offersFor, offerLine } from './relay.js'
import { firstTimeStaff } from './staff-help.js'

export const NOTICE_CASE_CAP = 25

const lastIndex = (events, pred) => {
  for (let i = events.length - 1; i >= 0; i--) if (pred(events[i])) return i
  return -1
}
const dataOf = evData

export function assignedCaseState(events, contact) {
  const me = contact?.id
  const iIn = lastIndex(events, e => e.kind === 'inbound')
  const iOut = lastIndex(events, e => e.kind === 'outbound' && e.actor === 'operator')
  const iAssigned = lastIndex(events, e => e.kind === 'action' && dataOf(e).assigned_contact_id === me)
  const iAnnounced = lastIndex(events, e => e.kind === 'observation' && dataOf(e).announced_to === me)

  const iOutAny = lastIndex(events, e => e.kind === 'outbound')
  const undelivered = iOutAny > iIn && iOutAny >= 0 && dataOf(events[iOutAny]).delivered === false
  const iSentBack = lastIndex(events, e => { const d = dataOf(e); return d.sent_back === true || d.handoff_withdrawn === true })
  const iTechNote = lastIndex(events, e => dataOf(e).tag === TECHNICIAN_NOTE)
  const newTechNote = iTechNote > iAnnounced
  return {
    reply_undelivered: undelivered,
    new_technician_note: newTechNote,
    ...(newTechNote ? { technician_note: notesTagged(events, TECHNICIAN_NOTE)[0].text } : {}),
    sent_back: iSentBack > iAnnounced,
    new_assignment: iAssigned > iAnnounced,
    waiting_for_you: iIn > iOut,
    new_reply: iIn > iAnnounced && iIn > iOut,
  }
}

export async function pendingDispatchesFor(store, contact, cases) {
  const out = []
  for (const c of cases) {
    if (!isOpenCase(c) || !tagList(c).includes('dispatch-suggested')) continue
    const events = await store.listEvents(c.id)
    const iAsk = lastIndex(events, e => e.kind === 'action' && dataOf(e).dispatch_worker_id === contact.id)
    if (iAsk < 0) continue
    const iAnswer = lastIndex(events, e => dataOf(e).dispatch_response_by === contact.id)
    if (iAnswer > iAsk) continue
    out.push({ c, note: dataOf(events[iAsk]).note || null })
  }
  return out
}

export async function staffNotices(store, contact, { mark = false, cap = NOTICE_CASE_CAP, tier = undefined } = {}) {
  const key = assigneeKeyFor(contact)
  if (!key) return { assigned: [], dispatches: [], handoffs: [], offers: [], counts: { assigned: 0, new_assignments: 0, new_replies: 0, dispatches: 0, undelivered: 0, sent_back: 0, new_handoffs: 0, handover_offers: 0, technician_notes: 0 } }
  const mine = (await store.listCases({ assignee: key }, { limit: cap * 4 })).filter(isOpenCase).slice(0, cap)
  const assigned = []
  for (const c of mine) {
    const events = await store.listEvents(c.id)
    const flags = assignedCaseState(events, contact)
    assigned.push({ c, flags })
    if (mark && (flags.new_assignment || flags.new_reply || flags.sent_back || flags.new_technician_note)) {
      await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: 'NOTICE ANNOUNCED to the assignee', data: { announced_to: contact.id }, touch: false })
    }
  }
  const everything = await store.listCases({}, { limit: 10000, offset: 0 })
  const dispatches = await pendingDispatchesFor(store, contact, everything)

  const handoffs = []
  if (canSignOff(tier ?? contact?.tier)) {
    for (const c of everything.filter(x => x.channel !== 'system' && isOpenCase(x) && isHandedOff(x) && !isOwnConversation(x, contact)).slice(0, cap)) {
      const events = await store.listEvents(c.id)
      if (lastIndex(events, e => dataOf(e).handed_off === true) > lastIndex(events, e => e.kind === 'observation' && dataOf(e).announced_to === contact.id)) {
        handoffs.push({ c })
        if (mark) await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: 'NOTICE ANNOUNCED to the sign-off desk', data: { announced_to: contact.id }, touch: false })
      }
    }
  }
  const offers = (await offersFor(store, contact, everything, { mark })).map(({ c, offer }) => ({ c, offer, line: offerLine(c, offer) }))
  return {
    assigned, dispatches, handoffs, offers,
    counts: {
      handover_offers: offers.length,
      technician_notes: assigned.filter(a => a.flags.new_technician_note).length,
      assigned: assigned.length,
      new_assignments: assigned.filter(a => a.flags.new_assignment).length,
      new_replies: assigned.filter(a => a.flags.new_reply).length,
      undelivered: assigned.filter(a => a.flags.reply_undelivered).length,
      dispatches: dispatches.length,
      sent_back: assigned.filter(a => a.flags.sent_back).length,
      new_handoffs: handoffs.length,
    },
  }
}

export async function staffNoticeNote(store, contact) {
  let n
  try { n = (await staffNotices(store, contact)).counts } catch { return '' }
  const first = await firstTimeStaff(store, contact)
  const firstNote = first ? `\n\n[System note: this is the first time this team member has talked to you. After dealing with what they just said, call case_help and give them the short welcome it returns, in their language.]` : ''
  if (!n.new_assignments && !n.new_replies && !n.dispatches && !n.undelivered && !n.sent_back && !n.new_handoffs && !n.handover_offers && !n.technician_notes) return firstNote
  const bits = []
  if (n.handover_offers) bits.push(`${n.handover_offers} hand-over offered to them by another ranger (accept or decline)`)
  if (n.technician_notes) bits.push(`${n.technician_notes} with a new note from the technician`)
  if (n.new_assignments) bits.push(`${n.new_assignments} newly assigned to them`)
  if (n.new_replies) bits.push(`${n.new_replies} where the reporter has answered`)
  if (n.dispatches) bits.push(`${n.dispatches} suggested for them to attend`)
  if (n.sent_back) bits.push(`${n.sent_back} sent back to them by the technician`)
  if (n.new_handoffs) bits.push(`${n.new_handoffs} handed over to the sign-off desk by a ranger`)
  if (n.undelivered) bits.push(`${n.undelivered} where WhatsApp did not deliver the last reply (the reporter has to message first, or be phoned)`)
  return `${firstNote}\n\n[System note: waiting for this team member: ${bits.join('; ')}. Call case_pending, and after dealing with what they just said, tell them briefly in your own words. It is queued news, not a new message from them.]`
}
