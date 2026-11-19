import { vocabText } from './config-loader.js'
import { defTool, str } from './case-tools-shared.js'
import { parseReport } from './timestamp.js'
import { staffLabel } from './hooks/staff-outbound.js'
import { REPORT_ENTITY_LABEL } from './store/report-shape.js'
import { findCase, deskAuthorityOn, actorData, NOT_ASSIGNED } from './case-tools-team-shared.js'
import { isOwnConversation } from './case-assignment.js'
import { loadAreas, areasOfResponder, resolveArea, statedArea } from './areas.js'
import { keysForContact } from './my-day.js'
import { identifyingLine } from './team-focus.js'
import { casePin, planRoute } from './route-plan.js'
import { KIND_BUTTONS, choiceLabel } from './choices.js'
import { caseyText } from './deployment-text.js';

const NO_SUCH = { error: caseyText("src/case-tools-navigate.js#0") }

const PIN_KIND = {
  gps: caseyText("src/case-tools-navigate.js#s0"),
  confirmed: caseyText("src/case-tools-navigate.js#s1"),
  estimated: caseyText("src/case-tools-navigate.js#1"),
}

export const mapsLink = (pin) => `https://maps.google.com/?q=${pin.lat},${pin.lon}`

async function mayNavigate(store, ctx, c) {
  if (isOwnConversation(c, ctx?.contact)) return false
  if (deskAuthorityOn(ctx, c)) return true
  const areas = await loadAreas(store)
  const mine = areasOfResponder(areas, await keysForContact(store, ctx?.contact))
  if (!mine.length) return false
  const r = parseReport(c)
  const hit = resolveArea(areas, { stated: statedArea(r), location: r.location })?.area
  return !!hit && mine.some(a => a.id === hit.id)
}

export function buildNavigateTools(store) {
  return [
    defTool('case_navigate', 'cases',
      caseyText("src/case-tools-navigate.js#2", [REPORT_ENTITY_LABEL, REPORT_ENTITY_LABEL]),
      { type: 'object', properties: { case: str(caseyText("src/case-tools-navigate.js#s2")) }, required: ['case'] },
      async ({ case: ref }, ctx) => {
        const c = await findCase(store(), ref)
        if (!c) return NO_SUCH
        if (!(await mayNavigate(store(), ctx, c))) return NOT_ASSIGNED
        const pin = casePin(c)
        if (!pin) return { error: caseyText("src/case-tools-navigate.js#3", [c.ref, String(parseReport(c).location || caseyText("src/case-tools-navigate.js#s3")).slice(0, 120)]) }
        const pinIs = PIN_KIND[c.location_source] || caseyText("src/case-tools-navigate.js#4")
        const link = mapsLink(pin)
        const mine = ctx.activeCaseId ? await store().getCase(ctx.activeCaseId) : null
        if (!mine) return { error: vocabText('ui.pin_send_no_chat', caseyText("src/case-tools-navigate.js#5")) }
        const place = String(parseReport(c).location || '').slice(0, 180)
        const canSend = typeof ctx.sendLocation === 'function' && ctx.canSendLocation?.(ctx.channel)
        if (!canSend) return { ok: true, ref: c.ref, sent: false, pin_is: pinIs, maps_link: link, note: caseyText("src/case-tools-navigate.js#6") }
        try { await ctx.sendLocation(mine, { lat: pin.lat, lon: pin.lon, name: `${c.ref} ${identifyingLine(c)}`.slice(0, 100), address: place }) }
        catch (e) { return { error: caseyText("src/case-tools-navigate.js#7", [String(e.message).slice(0, 160), link]), maps_link: link } }
        await store().appendEvent(c.id, { kind: 'observation', actor: 'operator', text: caseyText("src/case-tools-navigate.js#s4", [staffLabel(ctx.contact)]), data: actorData(ctx, { navigation_sent: true }) })
        return { ok: true, ref: c.ref, sent: true, pin_is: pinIs, maps_link: link }
      }),
    defTool('case_route', 'cases',
      caseyText("src/case-tools-navigate.js#8", [REPORT_ENTITY_LABEL]),
      { type: 'object', properties: {} },
      async (_args, ctx) => {
        const me = ctx?.contact?.id ? await store().getContact(ctx.contact.id) : null
        if (!me) return { error: caseyText("src/case-tools-navigate.js#9") }
        const plan = await planRoute(store(), me)
        const first = plan.stops[0]
        const out = {
          from: plan.position ? { last_check_in: plan.position.age, note: plan.position.age.includes('hour') || plan.position.age.includes('days') ? caseyText("src/case-tools-navigate.js#10") : undefined } : null,
          open_assigned: plan.open_assigned,
          stops: plan.stops,
          ...(plan.left_off_for_length ? { left_off_for_length: plan.left_off_for_length } : {}),
          ...(plan.no_pin_yet.length ? { no_pin_yet: plan.no_pin_yet } : {}),
          ...(plan.no_pin_not_listed ? { no_pin_not_listed: plan.no_pin_not_listed } : {}),
        }
        if (!plan.position) out.note = caseyText("src/case-tools-navigate.js#11")
        if (!plan.stops.length) out.note = caseyText("src/case-tools-navigate.js#12")
        if (first) {
          out.kind = KIND_BUTTONS
          out.choices = [{ id: `navigate:${first.ref}`, title: choiceLabel('navigate'), meaning: caseyText("src/case-tools-navigate.js#13", [first.ref, first.ref]) }]
        }
        return out
      }),
  ]
}
