import { isOpenCase } from './format.js'
import { tagList, tsMs } from './timestamp.js'
import { isOwnConversation } from './case-assignment.js'
import { haversineKm, isValidLatLon } from './case-tools-shared.js'
import { doneStages } from './case-tools-team-shared.js'
import { identifyingLine } from './team-focus.js'
import { keysForContact } from './my-day.js'

export const ROUTE_CAP = 8
export const NO_PIN_LISTED = 5
const URGENT_PRIORITIES = new Set(['urgent', 'high'])
const TIER_REASONS = ['sent back by the technician', 'urgent', 'the reporter is waiting for an answer', 'open']

export function ageWords(ms) {
  const minutes = Math.max(0, Math.round(ms / 60e3))
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} days ago`
}

export const casePin = (c) => {
  if (c.lat == null || c.lon == null) return null
  const lat = Number(c.lat)
  const lon = Number(c.lon)
  return isValidLatLon(lat, lon) ? { lat, lon } : null
}

async function readerWaiting(store, c) {
  const events = await store.listEvents(c.id)
  let lastIn = -1
  let lastOut = -1
  events.forEach((e, i) => {
    if (e.kind === 'inbound') lastIn = i
    if (e.kind === 'outbound' && e.actor === 'operator') lastOut = i
  })
  return lastIn > lastOut
}

export const tierOf = (c, waiting) => {
  if (tagList(c).includes('sent-back')) return 0
  if (URGENT_PRIORITIES.has(String(c.priority || '').toLowerCase())) return 1
  return waiting ? 2 : 3
}

export function orderStops(entries, from) {
  const byRank = [...entries].sort((a, b) => a.tier - b.tier
    || (tsMs(a.c.last_event_at) || 0) - (tsMs(b.c.last_event_at) || 0)
    || String(a.c.id).localeCompare(String(b.c.id)))
  const ordered = []
  let here = from
  for (let tier = 0; tier < TIER_REASONS.length; tier++) {
    const left = byRank.filter(e => e.tier === tier)
    while (left.length) {
      let pick = 0
      if (here) {
        let best = Infinity
        left.forEach((e, i) => {
          const d = haversineKm(here.lat, here.lon, e.pin.lat, e.pin.lon)
          if (d < best) { best = d; pick = i }
        })
      }
      const [next] = left.splice(pick, 1)
      ordered.push({ ...next, leg_km: here ? haversineKm(here.lat, here.lon, next.pin.lat, next.pin.lon) : null })
      here = next.pin
    }
  }
  return ordered
}

export async function assignedOpenCases(store, contact) {
  const seen = new Map()
  for (const key of await keysForContact(store, contact)) {
    for (const c of await store.listCases({ assignee: key }, { limit: 200 })) seen.set(c.id, c)
  }
  const stages = new Set(doneStages())
  return [...seen.values()].filter(c => c.channel !== 'system' && isOpenCase(c) && !stages.has(c.status) && !isOwnConversation(c, contact))
}

export function positionOf(contact, now) {
  const lat = Number(contact?.last_location_lat)
  const lon = Number(contact?.last_location_lon)
  if (contact?.last_location_lat == null || contact?.last_location_lon == null || !isValidLatLon(lat, lon)) return null
  const at = tsMs(contact.last_location_at)
  return { lat, lon, age: at ? ageWords(now - at) : 'at an unknown time' }
}

export async function planRoute(store, contact, now = Date.now()) {
  const mine = await assignedOpenCases(store, contact)
  const withPin = []
  const noPin = []
  for (const c of mine) {
    const waiting = await readerWaiting(store, c)
    const entry = { c, tier: tierOf(c, waiting), pin: casePin(c) }
    if (entry.pin) withPin.push(entry)
    else noPin.push(entry)
  }
  const position = positionOf(contact, now)
  const stops = orderStops(withPin, position).slice(0, ROUTE_CAP)
  noPin.sort((a, b) => a.tier - b.tier || String(a.c.id).localeCompare(String(b.c.id)))
  return {
    position,
    open_assigned: mine.length,
    stops: stops.map((s, i) => ({
      n: i + 1,
      ref: s.c.ref,
      what: identifyingLine(s.c),
      why: TIER_REASONS[s.tier],
      ...(s.leg_km == null ? {} : { distance: `about ${s.leg_km < 10 ? Math.round(s.leg_km * 10) / 10 : Math.round(s.leg_km)} km straight line ${i === 0 ? 'from you' : 'from the previous stop'}` }),
    })),
    left_off_for_length: Math.max(0, withPin.length - ROUTE_CAP),
    no_pin_yet: noPin.slice(0, NO_PIN_LISTED).map(e => ({ ref: e.c.ref, what: identifyingLine(e.c), why: TIER_REASONS[e.tier], note: 'no pin yet' })),
    no_pin_not_listed: Math.max(0, noPin.length - NO_PIN_LISTED),
  }
}
