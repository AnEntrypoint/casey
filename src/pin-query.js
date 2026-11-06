import { isOpenCase } from './format.js'
import { tagList } from './timestamp.js'
import { OPTED_OUT_TAG } from './hooks/heuristics.js'
import { isOwnConversation } from './case-assignment.js'
import { atLeast, resolveContactTier, TIER_FIELD_WORKER } from './contact-tiers.js'
import { haversineKm, isValidLatLon } from './case-tools-shared.js'
import { scrubNumbers } from './relay.js'
import { identifyingLine } from './team-focus.js'
import { toStorable } from './store/guards.js'
import { nearbyChoices } from './choices.js'
import { observation } from './hooks/case-writes.js'

export const NEARBY_LIMIT = 5

const kmWords = (km) => (km < 10 ? `${Math.round(km * 10) / 10} km` : `${Math.round(km)} km`)

export function isBarePin(msg, inboundText) {
  return !!msg?.location && !String(inboundText || '').trim()
}

export async function nearestOpenCases(store, contact, pin, limit = NEARBY_LIMIT) {
  const all = await store.listCases({}, { limit: 10000, offset: 0 })
  const rows = []
  for (const c of all) {
    if (c.channel === 'system' || !isOpenCase(c) || tagList(c).includes(OPTED_OUT_TAG) || isOwnConversation(c, contact)) continue
    const lat = Number(c.lat)
    const lon = Number(c.lon)
    if (c.lat == null || c.lon == null || !isValidLatLon(lat, lon)) continue
    rows.push({ c, km: haversineKm(pin.lat, pin.lon, lat, lon) })
  }
  rows.sort((a, b) => a.km - b.km || String(a.c.id).localeCompare(String(b.c.id)))
  return rows.slice(0, limit).map(({ c, km }) => ({
    ref: c.ref,
    description: scrubNumbers(`${identifyingLine(c)} - ${kmWords(km)}`),
  }))
}

async function storeCheckIn(store, contact, pin) {
  await store.t.update('contact', contact.id, toStorable({
    last_location_lat: pin.lat, last_location_lon: pin.lon, last_location_at: new Date().toISOString(), last_location_source: 'gps',
  }), { id: 'casey-agent', role: 'agent' })
}

export async function answerBarePin({ store, log, caseRow, msg }) {
  const contact = caseRow.contact_id ? await store.getContact(caseRow.contact_id) : null
  if (!contact || !atLeast(resolveContactTier(contact), TIER_FIELD_WORKER)) return null
  const pin = msg.location
  if (!isValidLatLon(pin.lat, pin.lon)) return null
  await storeCheckIn(store, contact, pin)
  const rows = await nearestOpenCases(store, contact, pin)
  const text = rows.length
    ? `They sent only their location pin, which is their own position and is now saved as their check-in. The system is showing them the ${rows.length} nearest open record${rows.length === 1 ? '' : 's'} as a list they can tap: write ONE short sentence saying so, in their language. Do not write the list, do not ask whether it is where the animals are, and record nothing from the pin.`
    : 'They sent only their location pin, which is their own position and is now saved as their check-in. No open record with a known position is on file near it. Say so in one short sentence in their language, and record nothing from the pin.'
  try { await store.appendEvent(caseRow.id, observation(`STAFF PIN QUERY: position saved as check-in; ${rows.length} nearby open record(s) offered`)) }
  catch (e) { log.warn?.('[casey] pin query note failed', { caseId: caseRow.id, error: e.message }) }
  return { promptNote: `\n\n[System note: ${text}]`, choices: rows.length ? nearbyChoices(rows) : null }
}
