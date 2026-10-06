import { defTool, str } from './case-tools-shared.js'
import { parseReport } from './timestamp.js'
import { staffLabel } from './hooks/staff-outbound.js'
import { REPORT_ENTITY_LABEL } from './store/report-shape.js'
import { findCase, deskAuthorityOn, actorData, NOT_ASSIGNED } from './case-tools-team-shared.js'
import { isOwnConversation } from './case-assignment.js'
import { loadAreas, areasOfRanger, resolveArea, statedArea } from './areas.js'
import { keysForContact } from './my-day.js'
import { identifyingLine } from './team-focus.js'
import { casePin, planRoute } from './route-plan.js'
import { KIND_BUTTONS, choiceLabel } from './choices.js'

const NO_SUCH = { error: 'No such record. Ask for the reference again.' }

const PIN_KIND = {
  gps: 'exact: it was read off a device',
  confirmed: 'an estimate the reporter agreed to',
  estimated: 'an estimate: a best guess from a place name, not a surveyed point',
}

export const mapsLink = (pin) => `https://maps.google.com/?q=${pin.lat},${pin.lon}`

async function mayNavigate(store, ctx, c) {
  if (isOwnConversation(c, ctx?.contact)) return false
  if (deskAuthorityOn(ctx, c)) return true
  const areas = await loadAreas(store)
  const mine = areasOfRanger(areas, await keysForContact(store, ctx?.contact))
  if (!mine.length) return false
  const r = parseReport(c)
  const hit = resolveArea(areas, { association: statedArea(r), location: r.location })?.area
  return !!hit && mine.some(a => a.id === hit.id)
}

export function buildNavigateTools(store) {
  return [
    defTool('case_navigate', 'cases',
      `Send this team member the map pin of ONE ${REPORT_ENTITY_LABEL} as a WhatsApp location message they can open in their maps app, so they can drive there. For a ${REPORT_ENTITY_LABEL} assigned to them or in an area they cover. Refused when the record has no coordinates (say so, and that the place is not pinned yet). Say whether the pin is exact or an estimate, as the result states. Never invent coordinates.`,
      { type: 'object', properties: { case: str('Record reference or id') }, required: ['case'] },
      async ({ case: ref }, ctx) => {
        const c = await findCase(store(), ref)
        if (!c) return NO_SUCH
        if (!(await mayNavigate(store(), ctx, c))) return NOT_ASSIGNED
        const pin = casePin(c)
        if (!pin) return { error: `${c.ref} has no coordinates recorded, so there is no pin to send. Say plainly that its place is not pinned yet; the place described is "${String(parseReport(c).location || 'not recorded').slice(0, 120)}".` }
        const pinIs = PIN_KIND[c.location_source] || 'of unrecorded origin, so treat it as approximate'
        const link = mapsLink(pin)
        const mine = ctx.activeCaseId ? await store().getCase(ctx.activeCaseId) : null
        if (!mine) return { error: 'Could not tell which chat to send the pin to, so nothing was sent.' }
        const place = String(parseReport(c).location || '').slice(0, 180)
        const canSend = typeof ctx.sendLocation === 'function' && ctx.canSendLocation?.(ctx.channel)
        if (!canSend) return { ok: true, ref: c.ref, sent: false, pin_is: pinIs, maps_link: link, note: 'This channel cannot send a location message: give them the maps link as text.' }
        try { await ctx.sendLocation(mine, { lat: pin.lat, lon: pin.lon, name: `${c.ref} ${identifyingLine(c)}`.slice(0, 100), address: place }) }
        catch (e) { return { error: `The pin could not be sent: ${String(e.message).slice(0, 160)}. The maps link is ${link}.`, maps_link: link } }
        await store().appendEvent(c.id, { kind: 'observation', actor: 'operator', text: `NAVIGATION PIN SENT to ${staffLabel(ctx.contact)}`, data: actorData(ctx, { navigation_sent: true }) })
        return { ok: true, ref: c.ref, sent: true, pin_is: pinIs, maps_link: link }
      }),
    defTool('case_route', 'cases',
      `Plan this team member's day on the road: their open assigned ${REPORT_ENTITY_LABEL}s that have a map pin, ordered sent-back first, then urgent, then reporter waiting, then the rest, and within each by the nearest next stop starting from their last check-in (its age is stated; with none, from the first). At most 8 stops; records with no pin are listed after as "no pin yet". Distances are straight line, never drive time: say "about N km straight line". The system offers a Navigate button for the first stop, so ask only if they want to go there.`,
      { type: 'object', properties: {} },
      async (_args, ctx) => {
        const me = ctx?.contact?.id ? await store().getContact(ctx.contact.id) : null
        if (!me) return { error: 'Could not tell who you are on this conversation, so no route was planned.' }
        const plan = await planRoute(store(), me)
        const first = plan.stops[0]
        const out = {
          from: plan.position ? { last_check_in: plan.position.age, note: plan.position.age.includes('hour') || plan.position.age.includes('days') ? 'That position may be out of date: say how old it is.' : undefined } : null,
          open_assigned: plan.open_assigned,
          stops: plan.stops,
          ...(plan.left_off_for_length ? { left_off_for_length: plan.left_off_for_length } : {}),
          ...(plan.no_pin_yet.length ? { no_pin_yet: plan.no_pin_yet } : {}),
          ...(plan.no_pin_not_listed ? { no_pin_not_listed: plan.no_pin_not_listed } : {}),
        }
        if (!plan.position) out.note = 'No check-in on record, so the order starts from the first by priority: say so and that sending their pin improves it.'
        if (!plan.stops.length) out.note = 'None of their open records has a map pin yet.'
        if (first) {
          out.kind = KIND_BUTTONS
          out.choices = [{ id: `navigate:${first.ref}`, title: choiceLabel('navigate'), meaning: `They want the pin for the first stop ${first.ref}. Call case_navigate with case ${first.ref}.` }]
        }
        return out
      }),
  ]
}
