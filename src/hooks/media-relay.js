

import { observation, raiseOperatorItem } from './case-writes.js'
import { carriesArtifact } from './media-intake.js'
import { truncate } from './heuristics.js'
import { staffLabel } from './staff-outbound.js'
import { atLeast, resolveContactTier, TIER } from '../contact-tiers.js'
import { assigneeKeyFor, isAssignedTo, isOwnConversation } from '../case-assignment.js'
import { refsIn, writeGate, focusOf, proposeFocus, identifyingLine } from '../team-focus.js'
import { isOpenCase } from '../format.js'
import { isValidLatLon } from '../case-tools-shared.js'
import { loadDomainConfig } from '../config-loader.js'
import { toStorable } from '../store/guards.js'
import { confirmRecordChoices, candidateChoices } from '../choices.js'
import { caseyText } from '../deployment-text.js';

const eligible = (c, contact) => !!c && isOpenCase(c) && isAssignedTo(c, contact) && !isOwnConversation(c, contact)

const cand = (c) => `${c.ref} (${identifyingLine(c).replace(/[\[\]<>\r\n]+/g, ' ')})`

function whatArrived(msg) {
  const parts = []
  if (msg.location) parts.push(caseyText("src/hooks/media-relay.js#s0"))
  const r = msg.raw || {}
  const list = Array.isArray(msg.media) ? msg.media : (msg.media ? [msg.media] : [])
  if (list.some(m => m?.type === 'audio') || r.audio || r.voice || r.type === 'audio' || r.type === 'voice') parts.push(caseyText("src/hooks/media-relay.js#s1"))
  if (list.some(m => m && m.type !== 'audio') || r.image || r.type === 'image') parts.push('a photo')
  return parts.join(' and ') || 'media'
}

export async function routeStaffArtifact({ store, log, caseRow, msg, inboundText, msgId, now = Date.now() }) {
  if (!carriesArtifact(msg)) return null
  try {
    const contact = caseRow.contact_id ? await store.getContact(caseRow.contact_id) : null
    if (!contact || !atLeast(resolveContactTier(contact), TIER.field)) return null
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
    return { mode: 'ask', contact, candidates, more: mine.length - candidates.length, reason: caseyText("src/hooks/media-relay.js#0") }
  } catch (e) {
    await raiseOperatorItem({ store, log, caseId: caseRow.id, code: 'media.route_failed' })
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
      await raiseOperatorItem({ store, log, caseId: target.id, code: 'location.rejected' })
      await store.appendEvent(target.id, observation(caseyText("src/hooks/media-relay.js#1", [by, pin.lat, pin.lon]), data))
      return
    }
    await store.t.update('contact', contact.id, toStorable({
      last_location_lat: pin.lat, last_location_lon: pin.lon, last_location_at: new Date().toISOString(), last_location_source: 'gps',
    }), { id: 'casey-agent', role: 'agent' })
    const place = [pin.name, pin.address].filter(Boolean).join(', ')
    await store.appendEvent(target.id, observation(
      caseyText("src/hooks/media-relay.js#2", [pin.lat, pin.lon, place ? caseyText("src/hooks/media-relay.js#s2", [truncate(place, 200)]) : '', by, by]), data))
  } catch {
    await raiseOperatorItem({ store, log, caseId: target.id, code: 'location.write_failed' })
  }
}

export function routeChoices(route) {
  if (route?.mode !== 'ask' || !route.candidates?.length) return null
  if (route.candidates.length === 1) return confirmRecordChoices(route.candidates[0].ref)
  return candidateChoices(route.candidates.map(c => ({ ref: c.ref, what: identifyingLine(c) })))
}


const heardAsk = (msg) => (msg._transcript?.text && !msg._transcript.unheard
  ? caseyText("src/hooks/media-relay.js#3")
  : '')

export async function noteRoute({ store, log, caseRow, route, msg, barePin = false }) {
  const what = whatArrived(msg)
  let text
  if (route.mode === 'relay') {
    text = caseyText("src/hooks/media-relay.js#4", [cand(route.target), what])
    if (msg.location && !barePin) text += caseyText("src/hooks/media-relay.js#5", [loadDomainConfig().persona.areaQuestion])
  } else {
    const list = route.candidates.map(cand).join('; ')
    text = caseyText("src/hooks/media-relay.js#6", [what, route.reason, route.candidates.length > 1 ? 's' : '', list, route.more > 0 ? caseyText("src/hooks/media-relay.js#s3", [route.more]) : '', heardAsk(msg)])
  }
  try { await store.appendEvent(caseRow.id, observation(text, { media_route: route.mode })) }
  catch (e) { log.warn?.('[casey] media route note failed', { caseId: caseRow.id, error: e.message }) }

  return caseyText("src/hooks/media-relay.js#s4", [text])
}
