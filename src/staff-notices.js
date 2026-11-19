

import { tagList } from './timestamp.js'
import { assigneeKeyFor } from './case-assignment.js'
import { isOpenCase } from './format.js'
import { evData } from './safe.js'
import { canSignOff } from './contact-tiers.js'
import { isHandedOff } from './signoff-desk.js'
import { isOwnConversation } from './case-assignment.js'
import { SPECIALIST_NOTE, notesTagged, offersFor, offerLine } from './relay.js'
import { firstTimeStaff, issuesGroupUrl, issuesInviteDue, markIssuesInvited } from './staff-help.js'
import { caseyText } from './deployment-text.js';

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
  const iTechNote = lastIndex(events, e => dataOf(e).tag === SPECIALIST_NOTE)
  const newTechNote = iTechNote > iAnnounced
  return {
    reply_undelivered: undelivered,
    new_technician_note: newTechNote,
    ...(newTechNote ? { technician_note: notesTagged(events, SPECIALIST_NOTE)[0].text } : {}),
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
  const mine = (await store.listCases({ assignee: key }, { limit: cap * 4 })).filter(c => isOpenCase(c) && !isOwnConversation(c, contact)).slice(0, cap)
  const assigned = []
  for (const c of mine) {
    const events = await store.listEvents(c.id)
    const flags = assignedCaseState(events, contact)
    assigned.push({ c, flags })
    if (mark && (flags.new_assignment || flags.new_reply || flags.sent_back || flags.new_technician_note)) {
      await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: caseyText("src/staff-notices.js#s0"), data: { announced_to: contact.id }, touch: false })
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
        if (mark) await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: caseyText("src/staff-notices.js#s1"), data: { announced_to: contact.id }, touch: false })
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

export async function ownReplyUndelivered(store, contact, { mark = false } = {}) {
  if (!contact?.id || !contact.external_id) return null
  const cases = await store.listCases({ channel: contact.channel, external_id: contact.external_id }, { limit: 20 })
  for (const c of cases) {
    const events = await store.listEvents(c.id)
    const iBad = lastIndex(events, e => e.kind === 'outbound' && dataOf(e).delivered === false)
    const iAnnounced = lastIndex(events, e => e.kind === 'observation' && dataOf(e).undelivered_announced_to === contact.id)
    if (iBad < 0 || iBad <= iAnnounced) continue
    if (mark) await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: caseyText("src/staff-notices.js#0"), data: { undelivered_announced_to: contact.id }, touch: false })
    return { reason: String(dataOf(events[iBad]).send_error || caseyText("src/staff-notices.js#s2")), began: String(events[iBad].text || '').slice(0, 160) }
  }
  return null
}

export async function staffNoticeNote(store, contact) {
  let n
  let own = null
  try { n = (await staffNotices(store, contact)).counts; own = await ownReplyUndelivered(store, contact, { mark: true }) } catch { return '' }
  const ownNote = own ? caseyText("src/staff-notices.js#1", [own.reason, own.began]) : ''
  const first = await firstTimeStaff(store, contact)
  let inviteNote = ''
  if (await issuesInviteDue(store, contact)) {
    inviteNote = caseyText("src/staff-notices.js#2", [issuesGroupUrl()])
    await markIssuesInvited(store, contact)
  }
  const firstNote = first ? caseyText("src/staff-notices.js#3") : ''
  if (!n.new_assignments && !n.new_replies && !n.dispatches && !n.undelivered && !n.sent_back && !n.new_handoffs && !n.handover_offers && !n.technician_notes) return ownNote + firstNote + inviteNote
  const bits = []
  if (n.handover_offers) bits.push(caseyText("src/staff-notices.js#4", [n.handover_offers]))
  if (n.technician_notes) bits.push(caseyText("src/staff-notices.js#s3", [n.technician_notes]))
  if (n.new_assignments) bits.push(caseyText("src/staff-notices.js#s4", [n.new_assignments]))
  if (n.new_replies) bits.push(caseyText("src/staff-notices.js#s5", [n.new_replies]))
  if (n.dispatches) bits.push(caseyText("src/staff-notices.js#s6", [n.dispatches]))
  if (n.sent_back) bits.push(caseyText("src/staff-notices.js#s7", [n.sent_back]))
  if (n.new_handoffs) bits.push(caseyText("src/staff-notices.js#5", [n.new_handoffs]))
  if (n.undelivered) bits.push(caseyText("src/staff-notices.js#6", [n.undelivered]))
  return caseyText("src/staff-notices.js#7", [ownNote, firstNote, inviteNote, bits.join('; ')])
}
