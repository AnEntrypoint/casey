// my-day.js  --  "how many cases in my area today, and where do they stand".
//
// A ranger's day starts with two questions: what is in my area today, and what is
// the current status. This answers both, and what changed since the day began and
// what each record still needs, for the cases ASSIGNED to the person and the cases
// in the AREAS they cover (areas.js). A technician gets the same plus their
// sign-off desk. PII-free by construction: counts, references, the identifying line
// (animals and place), status words and still-missing field labels; never a phone
// number, never a reporter name, never an assignee key.
//
// The same function serves the WhatsApp tools (case_my_day, team_ranger_day) and the
// dashboard route GET /api/my-day.

import { isOpenCase, SAST_TZ } from './format.js'
import { parseReport, tagList, tsMs } from './timestamp.js'
import { evData } from './safe.js'
import { assigneeKeyFor } from './case-assignment.js'
import { normalizeMsisdn } from './role-invites.js'
import { canSignOff } from './contact-tiers.js'
import { identifyingLine } from './team-focus.js'
import { SIGNOFF_DIAGNOSIS_FIELDS, missingMandatoryMinimum, missingSignoffDiagnosis, fieldLabel } from './store/report-shape.js'
import { loadAreas, areasOfRanger, resolveArea, statedArea } from './areas.js'
import { isHandedOff, inSignOffQueue } from './signoff-desk.js'

// Every assignee key that means this contact: their `contact:<id>` key plus the
// dashboard login (if any) linked to their phone, since an area may name either.
export async function keysForContact(store, contact) {
  const keys = [assigneeKeyFor(contact)]
  const phone = String(contact?.external_id || '')
  try {
    for (const a of await store.t.list('operator_account', {}, { limit: 500 })) {
      if (a.username && a.contact_phone && normalizeMsisdn(a.contact_phone) === phone) keys.push(a.username)
    }
  } catch { /* the contact key alone still answers */ }
  return keys.filter(Boolean)
}

const NEEDS_CAP = 15
const SCOPE_EVENT_CAP = 150

// Midnight at the start of the local day in `tz`, as epoch ms (the "day boundary").
export function dayStartMs(now = Date.now(), tz = SAST_TZ) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(now)).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]))
  const wallNow = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  const offset = wallNow - Math.floor(now / 1000) * 1000
  return Date.UTC(parts.year, parts.month - 1, parts.day) - offset
}

const countBy = (rows, f) => { const o = {}; for (const r of rows) { const k = f(r); o[k] = (o[k] || 0) + 1 } return o }

// keys: every assignee key that means this person (`contact:<id>` and/or a login
// username). `tier`: the person's contact tier, decides whether the sign-off desk
// block is included. `since` overrides the day boundary (epoch ms).
export async function myDay(store, { keys = [], contact = null, tier = '', name = '', now = Date.now(), since = null } = {}) {
  const myKeys = [...new Set([...keys, assigneeKeyFor(contact)].filter(Boolean))]
  const dayStart = since != null && Number.isFinite(Number(since)) ? Number(since) : dayStartMs(now)
  const areas = await loadAreas(store)
  const mineAreas = areasOfRanger(areas, myKeys)
  const mineAreaIds = new Set(mineAreas.map(a => a.id))

  const all = (await store.listCases({}, { limit: 10000, offset: 0 })).filter(c => c.channel !== 'system')
  const heldByMe = (c) => myKeys.includes(String(c.assignee || '').trim())
  const areaOf = (c) => { const r = parseReport(c); return resolveArea(areas, { association: statedArea(r), location: r.location })?.area || null }
  const cached = new Map()
  const inMyArea = (c) => { if (!cached.has(c.id)) cached.set(c.id, mineAreaIds.size ? mineAreaIds.has(areaOf(c)?.id) : false); return cached.get(c.id) }
  const scope = all.filter(c => heldByMe(c) || inMyArea(c))
  const open = scope.filter(isOpenCase)
  const createdToday = (c) => tsMs(c.created_at) >= dayStart
  const mine = open.filter(heldByMe)
  const holderWord = (c) => (heldByMe(c) ? 'you' : (String(c.assignee || '').trim() && c.assignee !== 'agent' ? 'someone else' : 'nobody'))

  // What changed since the boundary, read off the timelines of the scope's open
  // records (bounded) plus anything finished today.
  const finishedToday = scope.filter(c => !isOpenCase(c) && tsMs(c.last_event_at) >= dayStart)
  const changed = { new_cases: scope.filter(createdToday).length, reporter_replies: 0, newly_assigned_to_you: 0, sent_back: 0, handed_to_desk: 0, signed_off: finishedToday.length, moved_stage: 0 }
  const lastInbound = new Map()
  for (const c of [...open].sort((a, b) => (tsMs(b.last_event_at) || 0) - (tsMs(a.last_event_at) || 0)).slice(0, SCOPE_EVENT_CAP)) {
    const events = await store.listEvents(c.id)
    let iIn = -1; let iOut = -1
    events.forEach((e, i) => { if (e.kind === 'inbound') iIn = i; if (e.kind === 'outbound' && e.actor === 'operator') iOut = i })
    lastInbound.set(c.id, iIn > iOut)
    for (const e of events) {
      if (!(tsMs(e.created_at) >= dayStart)) continue
      const d = evData(e)
      if (e.kind === 'inbound') changed.reporter_replies += 1
      else if (e.kind === 'transition') changed.moved_stage += 1
      if (d.assigned_contact_id && myKeys.includes(`contact:${d.assigned_contact_id}`)) changed.newly_assigned_to_you += 1
      if (d.sent_back) changed.sent_back += 1
      if (d.handed_off) changed.handed_to_desk += 1
    }
  }

  // What each of the person's own open records still needs.
  const needs = mine.map((c) => {
    const rep = parseReport(c)
    const still = missingMandatoryMinimum(rep).map(fieldLabel)
    const items = []
    const tags = tagList(c)
    if (tags.includes('sent-back')) items.push('sent back by the technician: check what was asked')
    if (still.length) items.push(`the report still needs: ${still.join(', ')}`)
    else if (!isHandedOff(c)) items.push('the report is complete: hand it to the technician')
    else items.push('with the technician for sign-off')
    if (lastInbound.get(c.id)) items.push('the reporter has written and is waiting for an answer')
    const rank = (tags.includes('sent-back') ? 0 : 1) + (lastInbound.get(c.id) ? 0 : 1) * 0.5 + (still.length ? 0 : 0.25)
    return { ref: c.ref, what: identifyingLine(c), stage: c.status, needs: items, _rank: rank - still.length * 0.01 }
  }).sort((a, b) => a._rank - b._rank).slice(0, NEEDS_CAP).map(({ _rank, ...r }) => r)

  const areaOpen = open.filter(inMyArea)
  const out = {
    as_of: new Date(now).toISOString(),
    day_started_at: new Date(dayStart).toISOString(),
    person: { name: name || null, areas: mineAreas.map(a => a.name) },
    in_your_area: mineAreas.length ? {
      new_today: scope.filter(c => createdToday(c) && inMyArea(c)).length,
      open_now: areaOpen.length,
      by_stage: countBy(areaOpen, c => c.status),
      with_you: areaOpen.filter(heldByMe).length,
      with_someone_else: areaOpen.filter(c => !heldByMe(c) && holderWord(c) === 'someone else').length,
      unassigned: areaOpen.filter(c => holderWord(c) === 'nobody').length,
      handed_to_desk: areaOpen.filter(isHandedOff).length,
    } : null,
    yours: {
      open_now: mine.length,
      by_stage: countBy(mine, c => c.status),
      record_full_not_handed_over: mine.filter(c => !missingMandatoryMinimum(parseReport(c)).length && !isHandedOff(c)).length,
      with_the_technician: mine.filter(isHandedOff).length,
      finished_today: finishedToday.filter(heldByMe).length,
    },
    since_the_day_began: changed,
    needs,
    needs_shown: needs.length,
    needs_total: mine.length,
  }
  if (!mineAreas.length) out.note = 'No area is set for this person, so this covers only the reports given to them.'
  if (canSignOff(tier)) {
    const desk = all.filter(c => isOpenCase(c) && inSignOffQueue(c))
    const nodx = SIGNOFF_DIAGNOSIS_FIELDS.length ? desk.filter(c => missingSignoffDiagnosis(parseReport(c)).length) : []
    out.sign_off_desk = {
      waiting: desk.length,
      handed_over_by_rangers: desk.filter(isHandedOff).length,
      unassigned_and_full: desk.filter(c => !isHandedOff(c)).length,
      diagnosis_still_to_record: nodx.length,
      first: desk.slice(0, 8).map(c => ({ ref: c.ref, what: identifyingLine(c), from_a_ranger: isHandedOff(c) })),
    }
  }
  return out
}
