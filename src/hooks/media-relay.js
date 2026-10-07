

import { observation } from './case-writes.js'
import { carriesArtifact } from './media-intake.js'
import { truncate } from './heuristics.js'
import { staffLabel } from './staff-outbound.js'
import { atLeast, resolveContactTier, TIER_FIELD_WORKER } from '../contact-tiers.js'
import { assigneeKeyFor, isAssignedTo, isOwnConversation } from '../case-assignment.js'
import { refsIn, writeGate, focusOf, proposeFocus, identifyingLine } from '../team-focus.js'
import { isOpenCase } from '../format.js'
import { isValidLatLon } from '../case-tools-shared.js'
import { toStorable } from '../store/guards.js'
import { confirmRecordChoices, candidateChoices } from '../choices.js'

const eligible = (c, contact) => !!c && isOpenCase(c) && isAssignedTo(c, contact) && !isOwnConversation(c, contact)

const cand = (c) => `${c.ref} (${identifyingLine(c).replace(/[\[\]<>\r\n]+/g, ' ')})`

function whatArrived(msg) {
  const parts = []
  if (msg.location) parts.push('the location pin')
  const r = msg.raw || {}
  const list = Array.isArray(msg.media) ? msg.media : (msg.media ? [msg.media] : [])
  if (list.some(m => m?.type === 'audio') || r.audio || r.voice || r.type === 'audio' || r.type === 'voice') parts.push('a voice note')
  if (list.some(m => m && m.type !== 'audio') || r.image || r.type === 'image') parts.push('a photo')
  return parts.join(' and ') || 'media'
}

export async function routeStaffArtifact({ store, log, caseRow, msg, inboundText, msgId, now = Date.now() }) {
  if (!carriesArtifact(msg)) return null
  try {
    const contact = caseRow.contact_id ? await store.getContact(caseRow.contact_id) : null
    if (!contact || !atLeast(resolveContactTier(contact), TIER_FIELD_WORKER)) return null
    const ctx = { contact, inboundRefs: refsIn(inboundText), turnId: String(msgId || '') }
    const f = await focusOf(store, contact.id, now)
    const target = f ? await store.getCase(f.caseId) : null
    if (eligible(target, contact)) {
      const refused = await writeGate(store, ctx, target, {}, now)
      if (!refused) return { mode: 'relay', target, contact }
      return { mode: 'ask', contact, candidates: [target], reason: refused.error }
    }
    const key = assigneeKeyFor(contact)
    if (!key) return null
    const mine = (await store.listCases({ assignee: key }, { limit: 200 })).filter(c => eligible(c, contact))
    if (!mine.length) return null
    const named = ctx.inboundRefs.map(r => mine.find(c => String(c.ref).toUpperCase() === r)).filter(Boolean)
    const candidates = named.length === 1 ? named : mine.slice(0, 3)
    if (candidates.length === 1) await proposeFocus(store, contact.id, candidates[0], msgId, now)
    return { mode: 'ask', contact, candidates, more: mine.length - candidates.length, reason: 'No assigned record is confirmed as the one they are working on right now.' }
  } catch (e) {
    log.warn?.('[casey] staff media routing failed; keeping media on the sender\'s own record', { caseId: caseRow.id, error: e.message })
    return null
  }
}

export async function recordRelayedLocationPin({ store, log, route, msg }) {
  const pin = msg.location
  if (!pin) return
  const { target, contact } = route
  const by = staffLabel(contact)
  const data = { on_behalf: true, relayed_by: by, staff_contact_id: contact.id }
  try {
    if (!isValidLatLon(pin.lat, pin.lon)) {
      await store.appendEvent(target.id, observation(`RANGER LOCATION PIN REJECTED: the position ${by} shared was out of range (lat=${pin.lat}, lon=${pin.lon}) and was not recorded.`, data))
      return
    }
    await store.t.update('contact', contact.id, toStorable({
      last_location_lat: pin.lat, last_location_lon: pin.lon, last_location_at: new Date().toISOString(), last_location_source: 'gps',
    }), { id: 'casey-agent', role: 'agent' })
    const place = [pin.name, pin.address].filter(Boolean).join(', ')
    await store.appendEvent(target.id, observation(
      `ranger location pin: lat ${pin.lat}, lon ${pin.lon}${place ? ` (WhatsApp label "${truncate(place, 200)}")` : ''} -- relayed by ${by} on the reporter's behalf. This is ${by}'s own position on site, not the animals' location; the record's own position is unchanged.`, data))
  } catch (e) { log.warn?.('[casey] ranger location pin failed', { caseId: target.id, error: e.message }) }
}

export function routeChoices(route) {
  if (route?.mode !== 'ask' || !route.candidates?.length) return null
  if (route.candidates.length === 1) return confirmRecordChoices(route.candidates[0].ref)
  return candidateChoices(route.candidates.map(c => ({ ref: c.ref, what: identifyingLine(c) })))
}


const heardAsk = (msg) => (msg._transcript?.text && !msg._transcript.unheard
  ? ' The transcript of the voice note is heard text and is not recorded on any record either: write nothing from it to a record until they confirm which record it belongs to, and ask that in this same single reply.'
  : '')

export async function noteRoute({ store, log, caseRow, route, msg, barePin = false }) {
  const what = whatArrived(msg)
  let text
  if (route.mode === 'relay') {
    text = `MEDIA FILED ON ${cand(route.target)}: ${what} they just sent was recorded on that record on the reporter's behalf, not on this chat. In your reply name that reference and what it is, and confirm what was saved.`
    if (msg.location && !barePin) text += ` The pin was recorded as THEIR OWN position (the record's own position is unchanged). Ask if that pin is also where the animals are; only if they say yes, record it with case_edit using EXACTLY lat ${msg.location.lat}, lon ${msg.location.lon} and location_source gps (never a position guessed from a place name).`
  } else {
    const list = route.candidates.map(cand).join('; ')
    text = `MEDIA NOT FILED ON A TEAM RECORD: ${what} they just sent stayed on this chat only. ${route.reason} Candidate${route.candidates.length > 1 ? 's' : ''}: ${list}${route.more > 0 ? ` (and ${route.more} more)` : ''}. Never say it was saved, filed or received on a record: say plainly that it is NOT on the record yet. Ask which record it belongs to, naming the candidate, as the last thing in your reply; do not guess. Only after they answer yes in their NEXT message call case_focus with that record and confirm set to true; nothing already sent is moved automatically, so it must be sent again after they confirm (an operator can also move it).${heardAsk(msg)}`
  }
  try { await store.appendEvent(caseRow.id, observation(text, { media_route: route.mode })) }
  catch (e) { log.warn?.('[casey] media route note failed', { caseId: caseRow.id, error: e.message }) }

  return `\n\n[System note: ${text}]`
}
