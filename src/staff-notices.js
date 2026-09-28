// staff-notices.js  --  what is waiting for a team member who works over WhatsApp.
//
// casey never originates a WhatsApp message outside a contact's 24h window (no
// templates exist), so an assignee cannot be pinged when a reporter answers or
// when an operator assigns them a case. The notice is QUEUED as derived state on
// the timelines and delivered in the assignee's NEXT in-window turn: the turn
// composer appends a one-line count (staffNoticeNote) and case_pending returns
// the rows. Nothing here sends anything.
//
// State, all on existing append-only events -- no new column, no new entity:
//   assignment   an 'action' event with data.assigned_contact_id = the contact
//                (written by team_assign / case_claim);
//   dispatch     an 'action' event with data.dispatch_worker_id = the contact
//                (routes/map.js postCaseDispatch) plus the 'dispatch-suggested'
//                tag; answered by an event with data.dispatch_response_by;
//   announced    an 'observation' with data.announced_to = the contact, written
//                when case_pending has shown them what was new, so the same
//                news is not announced twice;
//   waiting      the reporter's last inbound is newer than the last staff
//                outbound -- derived, so it stays listed until someone answers.
//
// PII-free by construction: rows carry ref, stage, place and species through
// enquiryRow's headline fields, and never the contact's phone number.

import { tagList } from './timestamp.js'
import { assigneeKeyFor } from './case-assignment.js'
import { isOpenCase } from './format.js'
import { evData } from './safe.js'

export const NOTICE_CASE_CAP = 25

const lastIndex = (events, pred) => {
  for (let i = events.length - 1; i >= 0; i--) if (pred(events[i])) return i
  return -1
}
const dataOf = evData

// Assignment + reply state for one assigned case.
export function assignedCaseState(events, contact) {
  const me = contact?.id
  const iIn = lastIndex(events, e => e.kind === 'inbound')
  const iOut = lastIndex(events, e => e.kind === 'outbound' && e.actor === 'operator')
  const iAssigned = lastIndex(events, e => e.kind === 'action' && dataOf(e).assigned_contact_id === me)
  const iAnnounced = lastIndex(events, e => e.kind === 'observation' && dataOf(e).announced_to === me)
  // The newest reply casey or a person sent that WhatsApp reported as not
  // delivered (delivery-status.js writes delivered:false on the outbound event),
  // and the reporter has not written since. Nothing they were told reached them.
  const iOutAny = lastIndex(events, e => e.kind === 'outbound')
  const undelivered = iOutAny > iIn && iOutAny >= 0 && dataOf(events[iOutAny]).delivered === false
  return {
    reply_undelivered: undelivered,
    new_assignment: iAssigned > iAnnounced,
    waiting_for_you: iIn > iOut,
    new_reply: iIn > iAnnounced && iIn > iOut,
  }
}

// Dispatch suggestions addressed to this contact that they have not answered.
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

// { assigned:[{case,flags}], dispatches:[{case,note}], counts }. With mark:true,
// every assigned case that carried news is stamped announced so it is news once.
export async function staffNotices(store, contact, { mark = false, cap = NOTICE_CASE_CAP } = {}) {
  const key = assigneeKeyFor(contact)
  if (!key) return { assigned: [], dispatches: [], counts: { assigned: 0, new_assignments: 0, new_replies: 0, dispatches: 0, undelivered: 0 } }
  const mine = (await store.listCases({ assignee: key }, { limit: cap * 4 })).filter(isOpenCase).slice(0, cap)
  const assigned = []
  for (const c of mine) {
    const events = await store.listEvents(c.id)
    const flags = assignedCaseState(events, contact)
    assigned.push({ c, flags })
    if (mark && (flags.new_assignment || flags.new_reply)) {
      await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: 'NOTICE ANNOUNCED to the assignee', data: { announced_to: contact.id }, touch: false })
    }
  }
  const everything = await store.listCases({}, { limit: 10000, offset: 0 })
  const dispatches = await pendingDispatchesFor(store, contact, everything)
  return {
    assigned, dispatches,
    counts: {
      assigned: assigned.length,
      new_assignments: assigned.filter(a => a.flags.new_assignment).length,
      new_replies: assigned.filter(a => a.flags.new_reply).length,
      undelivered: assigned.filter(a => a.flags.reply_undelivered).length,
      dispatches: dispatches.length,
    },
  }
}

// The one line appended to a staff member's turn so the model raises the queued
// news in its own words. Counts only -- no refs, no places, nothing to leak.
export async function staffNoticeNote(store, contact) {
  let n
  try { n = (await staffNotices(store, contact)).counts } catch { return '' }
  if (!n.new_assignments && !n.new_replies && !n.dispatches && !n.undelivered) return ''
  const bits = []
  if (n.new_assignments) bits.push(`${n.new_assignments} newly assigned to them`)
  if (n.new_replies) bits.push(`${n.new_replies} where the reporter has answered`)
  if (n.dispatches) bits.push(`${n.dispatches} suggested for them to attend`)
  if (n.undelivered) bits.push(`${n.undelivered} where WhatsApp did not deliver the last reply (the reporter has to message first, or be phoned)`)
  return `\n\n[System note: waiting for this team member: ${bits.join('; ')}. Call case_pending, and after dealing with what they just said, tell them briefly in your own words. It is queued news, not a new message from them.]`
}
