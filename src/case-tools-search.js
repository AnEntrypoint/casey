import { createHash } from 'node:crypto'
import { defTool, str, haversineKm } from './case-tools-shared.js'
import { vocabWord } from './config-loader.js'
import { SAST_TZ } from './format.js'
import { parseReport, tagList, tsMs } from './timestamp.js'
import { dayStartMs, keysForContact } from './my-day.js'
import { loadAreas, areasOfRanger, resolveArea, statedArea } from './areas.js'
import { isHandedOff, isUnheld } from './signoff-desk.js'
import { doneStages, deskAuthorityOn, scrubNumbers } from './case-tools-team-shared.js'
import { OPTED_OUT_TAG, CASE_REF_RE } from './hooks/heuristics.js'
import { reportersForCases, firstName } from './phone-persons.js'
import { atLeast, TIER } from './contact-tiers.js'
import {
  MANDATORY_MINIMUM_FIELDS, CRITICAL_FIELDS, REPORT_KEYS, AREA_FIELD, SIGNOFF_DIAGNOSIS_FIELDS, missingMandatoryMinimum, fieldLabel,
} from './store/report-shape.js'
import { REPORT_CONCEPT as K } from './report-concepts.js'
import { caseyText } from './deployment-text.js';
import { TOOL_ARG } from './tool-arguments.js'

const SCAN_LIMIT = 10000
const DEFAULT_LIMIT = 8
const MAX_LIMIT = 25
const REPLY_SCAN_CAP = 200
const SPECIES_SHOWN = 6
const DAY_MS = 86400e3
const SCOPES = ['mine', 'area', 'all']
const SORTS = ['worst_first', 'newest', 'oldest', 'nearest']
const FLAGS = ['sent_back', 'handed_off', 'complete', 'incomplete', 'needs_reply', 'no_photo', 'opted_out']
const HOLD_STATES = ['open', 'claimed', 'closed', 'unassigned', 'any']
const DATE_BY = ['activity', 'created']
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 }
const KIND_ARG = K.kind
const DISEASE_KEY = SIGNOFF_DIAGNOSIS_FIELDS[0]
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const fold = (s) => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
const has = (v) => v != null && String(v).trim() !== ''
const finite = (n) => (Number.isFinite(n) ? n : 0)
const asList = (v) => (v == null || v === '' ? [] : (Array.isArray(v) ? v : String(v).split(',')).map(x => String(x).trim()).filter(Boolean))
const fail = (message, extra = {}) => ({ error: message, ...extra })

function tzParts(ms) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: SAST_TZ, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' })
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).filter(x => x.type !== 'literal').map(x => [x.type, x.value]))
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), weekday: WEEKDAYS.indexOf(p.weekday) }
}

const startOfDayAt = (ms) => dayStartMs(ms, SAST_TZ)
const nextDayStart = (dayStart) => startOfDayAt(dayStart + DAY_MS * 1.5)
const prevDayStart = (dayStart) => startOfDayAt(dayStart - DAY_MS / 2)

function startOfDate(y, m, d) {
  const guess = Date.UTC(y, m - 1, d, 12)
  const local = tzParts(guess)
  const drift = (Date.UTC(y, m - 1, d) - Date.UTC(local.y, local.m - 1, local.d)) / DAY_MS
  return startOfDayAt(guess + drift * DAY_MS)
}

function daysBack(dayStart, n) {
  let t = dayStart
  for (let i = 0; i < n; i++) t = prevDayStart(t)
  return t
}

function resolveInstant(value, edge, now) {
  const word = fold(value).replace(/[\s-]+/g, '_')
  const today = startOfDayAt(now)
  const endOfToday = nextDayStart(today)
  if (word === 'today') return edge === 'since' ? today : endOfToday
  if (word === 'yesterday') return edge === 'since' ? prevDayStart(today) : today
  if (word === 'this_week') return edge === 'since' ? daysBack(today, tzParts(now).weekday) : endOfToday
  if (word === 'this_month') return edge === 'since' ? daysBack(today, tzParts(now).d - 1) : endOfToday
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim())
  if (dateOnly) {
    const start = startOfDate(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]))
    return edge === 'since' ? start : nextDayStart(start)
  }
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(String(value).trim())) {
    const t = Date.parse(value)
    if (Number.isFinite(t)) return t
  }
  return null
}

function agoWords(ms, now) {
  if (!ms) return caseyText("src/case-tools-search.js#s0")
  const s = Math.max(0, (now - ms) / 1000)
  if (s < 60) return caseyText("src/case-tools-search.js#s1")
  if (s < 3600) return caseyText("src/case-tools-search.js#s2", [Math.floor(s / 60)])
  if (s < 86400) { const h = Math.floor(s / 3600); return caseyText("src/case-tools-search.js#s3", [h, h === 1 ? '' : 's']) }
  if (s < 172800) return 'yesterday'
  if (s < 14 * 86400) return caseyText("src/case-tools-search.js#s4", [Math.floor(s / 86400)])
  if (s < 60 * 86400) return caseyText("src/case-tools-search.js#s5", [Math.floor(s / (7 * 86400))])
  return caseyText("src/case-tools-search.js#s6", [Math.floor(s / (30 * 86400))])
}

const compareKeys = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}

function encodeCursor(sig, key) {
  return Buffer.from(JSON.stringify({ s: sig, k: key })).toString('base64url')
}

function decodeCursor(raw, sig) {
  let c
  try { c = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8')) } catch { c = null }
  if (!c || !Array.isArray(c.k) || typeof c.s !== 'string') return fail(caseyText("src/case-tools-search.js#0"))
  if (c.s !== sig) return fail(caseyText("src/case-tools-search.js#1"))
  return { key: c.k }
}

async function awaitingAnswer(store, caseRow) {
  const events = await store.listEvents(caseRow.id)
  let last = null
  for (const e of events) if (e.kind === 'inbound' || e.kind === 'outbound') last = e
  return !!last && last.kind === 'inbound'
}

function whatOf(report) {
  const species = has(report[K.kind]) ? String(report[K.kind]).trim() : ''
  const place = has(report.location) ? `in ${String(report.location).trim()}` : ''
  const what = scrubNumbers([species, place].filter(Boolean).join(' ')).slice(0, 90)
  return what || caseyText("src/case-tools-search.js#s7")
}

function describeFilters(f) {
  const out = { scope: f.scope, state: f.state, sort: f.sort }
  if (f.q) out.q = f.q
  if (f.flags.length) out.flag = f.flags
  if (KIND_ARG && f.kind) out[KIND_ARG] = f.kind
  if (f.disease) out[TOOL_ARG.condition] = f.disease
  if (f.missing) out.missing = f.missing
  if (f.since != null) out.since = new Date(f.since).toISOString()
  if (f.until != null) out.until = new Date(f.until).toISOString()
  if (f.since != null || f.until != null) out.date_by = f.dateBy
  if (f.near) out.near = f.nearMe ? { near_me: true, radius_km: f.near.radius } : { lat: f.near.lat, lon: f.near.lon, radius_km: f.near.radius }
  return out
}

function parseArgs(args, ctx, now) {
  const scopeDefault = atLeast(ctx?.tier, TIER.specialist) ? 'all' : 'mine'
  const scope = fold(args.scope) || scopeDefault
  if (!SCOPES.includes(scope)) return fail(caseyText("src/case-tools-search.js#s8", [SCOPES.join(', ')]))
  const q = String(args.q ?? '').trim()
  const words = fold(q).split(/[\s,]+/).filter(Boolean)
  const refAsked = !!q.match(CASE_REF_RE)
  const stateRaw = fold(args.state || args.stage)
  const state = stateRaw || (refAsked ? 'any' : 'open')
  const flags = asList(args.flag).map(fold)
  for (const f of flags) if (!FLAGS.includes(f)) return fail(caseyText("src/case-tools-search.js#s9", [f]), { allowed_flags: FLAGS })
  const sort = fold(args.sort) || (scope === 'mine' ? 'worst_first' : 'newest')
  if (!SORTS.includes(sort)) return fail(caseyText("src/case-tools-search.js#s10", [SORTS.join(', ')]))
  const dateBy = fold(args.date_by) || 'activity'
  if (!DATE_BY.includes(dateBy)) return fail(caseyText("src/case-tools-search.js#s11", [DATE_BY.join(', ')]))
  const since = has(args.since) ? resolveInstant(args.since, 'since', now) : null
  const until = has(args.until) ? resolveInstant(args.until, 'until', now) : null
  if (has(args.since) && since == null) return fail(caseyText("src/case-tools-search.js#2", [args.since]))
  if (has(args.until) && until == null) return fail(caseyText("src/case-tools-search.js#3", [args.until]))
  const missing = has(args.missing) ? String(args.missing).trim() : ''
  const missingAllowed = [...new Set([...MANDATORY_MINIMUM_FIELDS, ...CRITICAL_FIELDS])]
  if (missing && !missingAllowed.includes(missing)) return fail(caseyText("src/case-tools-search.js#4", [missing]), { allowed_fields: missingAllowed })
  const disease = has(args[TOOL_ARG.condition]) ? fold(args[TOOL_ARG.condition]) : ''
  if (disease && !REPORT_KEYS.has(DISEASE_KEY)) return fail(caseyText("src/case-tools-search.js#5"))
  const radius = Number(args.radius_km)
  if (has(args.radius_km) && !(Number.isFinite(radius) && radius >= 0)) return fail(caseyText("src/case-tools-search.js#s12", [args.radius_km]))
  let near = null
  const nearMe = args.near_me === true
  if (nearMe) {
    const me = ctx?.contact
    const lat = Number(me?.last_location_lat), lon = Number(me?.last_location_lon)
    if (me?.last_location_lat == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return fail(caseyText("src/case-tools-search.js#6"))
    near = { lat, lon, radius: has(args.radius_km) ? radius : null }
  } else if (args.near && typeof args.near.lat === 'number' && typeof args.near.lon === 'number') {
    const r = has(args.radius_km) ? radius : (typeof args.near.radius_km === 'number' ? args.near.radius_km : null)
    if (r != null && !(Number.isFinite(r) && r >= 0)) return fail(caseyText("src/case-tools-search.js#s13", [r]))
    near = { lat: args.near.lat, lon: args.near.lon, radius: r }
  } else if (args.near != null) return fail(caseyText("src/case-tools-search.js#s14"))
  if (sort === 'nearest' && !near) return fail(caseyText("src/case-tools-search.js#s15"))
  const limit = Math.min(Math.max(Math.floor(Number(args.limit)) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  return {
    scope, q, words, state, flags, sort, dateBy, since, until, missing, disease,
    kind: KIND_ARG && has(args[KIND_ARG]) ? fold(args[KIND_ARG]) : '', near, nearMe, limit, after: args.after || '',
  }
}

function checkState(state, stageValues) {
  if (HOLD_STATES.includes(state) || stageValues.includes(state)) return null
  return fail(caseyText("src/case-tools-search.js#s16", [state]), { allowed_states: [...HOLD_STATES, ...stageValues] })
}

function filterSignature(f) {
  return createHash('sha1').update(JSON.stringify(describeFilters(f))).digest('hex').slice(0, 12)
}

export async function searchCases(store, ctx, args = {}, { now = Date.now() } = {}) {
  const f = parseArgs(args, ctx, now)
  if (f.error) return f
  const stageValues = typeof store.getValidStatuses === 'function' ? store.getValidStatuses() : []
  const badState = checkState(f.state, stageValues)
  if (badState) return badState
  const sig = filterSignature(f)
  const cursor = f.after ? decodeCursor(f.after, sig) : null
  if (cursor?.error) return cursor

  const done = new Set(doneStages())
  const keys = new Set(await keysForContact(store, ctx?.contact))
  const pool = (await store.listCases({}, { limit: SCAN_LIMIT, offset: 0 })).filter(c => c.channel !== 'system')
  const notes = []
  if (pool.length >= SCAN_LIMIT) notes.push(caseyText("src/case-tools-search.js#7", [SCAN_LIMIT]))

  let areaIds = null
  let areas = null
  if (f.scope === 'area') {
    areas = await loadAreas(store)
    areaIds = new Set(areasOfRanger(areas, [...keys]).map(a => a.id))
    if (!areaIds.size) notes.push(caseyText("src/case-tools-search.js#8"))
  }
  const inArea = (report) => !!areaIds && areaIds.size > 0 && areaIds.has(resolveArea(areas, { stated: statedArea(report), location: report.location })?.area?.id)

  const rows = pool.map(c => {
    const report = parseReport(c)
    const tags = tagList(c)
    const lastMs = finite(tsMs(c.last_event_at || c.created_at))
    return {
      c, report, tags, lastMs,
      createdMs: finite(tsMs(c.created_at)),
      missing: missingMandatoryMinimum(report),
      isDone: done.has(c.status),
      held: !isUnheld(c),
      mine: keys.has(String(c.assignee || '').trim()),
      optedOut: tags.includes(OPTED_OUT_TAG),
    }
  })

  const inScope = rows.filter(r => f.scope === 'all' || r.mine || (f.scope === 'area' && inArea(r.report)))
  const wantsOptedOut = f.flags.includes('opted_out')
  const hiddenOptedOut = wantsOptedOut ? 0 : inScope.filter(r => r.optedOut).length
  const visible = inScope.filter(r => wantsOptedOut || !r.optedOut)

  const needNames = f.words.length > 0
  const named = new Map()
  if (needNames) {
    const authorised = visible.filter(r => deskAuthorityOn(ctx, r.c))
    const found = await reportersForCases(store, authorised.map(r => r.c))
    for (const r of authorised) { const w = found.get(r.c.id); if (w?.name) named.set(r.c.id, firstName(w.name)) }
  }

  const stateOk = (r) => {
    if (f.state === 'any') return true
    if (f.state === 'open') return !r.isDone
    if (f.state === 'closed') return r.isDone
    if (f.state === 'claimed') return !r.isDone && r.held
    if (f.state === 'unassigned') return !r.isDone && !r.held
    return r.c.status === f.state
  }
  const flagOk = {
    sent_back: (r) => r.tags.includes('sent-back'),
    handed_off: (r) => isHandedOff(r.c),
    complete: (r) => r.missing.length === 0,
    incomplete: (r) => r.missing.length > 0,
    no_photo: (r) => !has(r.report.photos),
    opted_out: (r) => r.optedOut,
  }
  const haystack = (r) => fold([r.c.ref, r.report[K.kind], r.report[K.signs], r.report.location,
    AREA_FIELD ? r.report[AREA_FIELD] : '', r.report[DISEASE_KEY], r.c.subject, named.get(r.c.id)].filter(has).join(' '))
  const dateMs = (r) => (f.dateBy === 'created' ? r.createdMs : r.lastMs)

  let withDist = 0
  let noCoordinates = 0
  let matched = visible.filter(r => {
    if (!stateOk(r)) return false
    for (const fl of f.flags) if (flagOk[fl] && !flagOk[fl](r)) return false
    if (f.kind && !fold(r.report[K.kind]).includes(f.kind)) return false
    if (f.disease && !fold(r.report[DISEASE_KEY]).includes(f.disease)) return false
    if (f.missing && has(r.report[f.missing])) return false
    if (f.since != null && dateMs(r) < f.since) return false
    if (f.until != null && dateMs(r) >= f.until) return false
    if (f.words.length) { const hay = haystack(r); if (!f.words.every(w => hay.includes(w))) return false }
    if (f.near) {
      const lat = Number(r.c.lat), lon = Number(r.c.lon)
      if (r.c.lat == null || r.c.lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) { noCoordinates++; return false }
      r.distance = Math.round(haversineKm(f.near.lat, f.near.lon, lat, lon) * 10) / 10
      if (f.near.radius != null && r.distance > f.near.radius) return false
      withDist++
    }
    return true
  })

  if (f.flags.includes('needs_reply')) {
    matched.sort((a, b) => b.lastMs - a.lastMs)
    const open = matched.filter(r => !r.isDone)
    const checked = open.slice(0, REPLY_SCAN_CAP)
    if (open.length > checked.length) notes.push(caseyText("src/case-tools-search.js#9", [REPLY_SCAN_CAP, open.length - checked.length]))
    const waiting = []
    for (const r of checked) if (await awaitingAnswer(store, r.c)) waiting.push(r)
    matched = waiting
  }

  const keyOf = {
    worst_first: (r) => [r.tags.includes('sent-back') ? 0 : 1, PRIORITY_RANK[r.c.priority] ?? 2, -r.missing.length, r.lastMs, r.c.id],
    newest: (r) => [-r.lastMs, r.c.id],
    oldest: (r) => [r.lastMs, r.c.id],
    nearest: (r) => [r.distance, r.c.id],
  }[f.sort]
  for (const r of matched) r.key = keyOf(r)
  matched.sort((a, b) => compareKeys(a.key, b.key))

  const total = matched.length
  const remaining = cursor ? matched.filter(r => compareKeys(r.key, cursor.key) > 0) : matched
  const page = remaining.slice(0, f.limit)
  const more = remaining.length > page.length
  const behind = total - remaining.length

  const out = {
    total, shown: page.length, as_of: new Date(now).toISOString(), timezone: SAST_TZ,
    next: more ? encodeCursor(sig, page[page.length - 1].key) : null,
    filters_applied: describeFilters(f),
  }
  if (behind) out.already_shown_before_this_page = behind

  const needsReplyFor = new Map()
  for (const r of page) needsReplyFor.set(r.c.id, r.isDone ? false : await awaitingAnswer(store, r.c))
  out.cases = page.map(r => {
    const row = {
      ref: r.c.ref,
      what: whatOf(r.report),
      stage: vocabWord(`stages.${r.c.status}`, r.c.status),
      hold_state: r.isDone ? 'Closed' : (r.held ? 'Claimed' : 'Open'),
      still_needed: r.missing.map(fieldLabel),
      photo: has(r.report.photos),
      sent_back: r.tags.includes('sent-back'),
      needs_reply: needsReplyFor.get(r.c.id),
      last_activity: agoWords(r.lastMs, now),
      assigned_to_you: r.mine,
    }
    if (r.distance != null) row.distance_km = r.distance
    if (deskAuthorityOn(ctx, r.c) && named.get(r.c.id)) row.reported_by = named.get(r.c.id)
    return row
  })

  if (total > page.length) {
    const byHold = {}
    const bySpecies = {}
    for (const r of matched) {
      const h = r.isDone ? 'Closed' : (r.held ? 'Claimed' : 'Open')
      byHold[h] = (byHold[h] || 0) + 1
      const sp = fold(r.report[K.kind]) || caseyText("src/case-tools-search.js#s17")
      bySpecies[sp] = (bySpecies[sp] || 0) + 1
    }
    const ranked = Object.entries(bySpecies).sort((a, b) => b[1] - a[1])
    const top = Object.fromEntries(ranked.slice(0, SPECIES_SHOWN))
    const rest = ranked.slice(SPECIES_SHOWN).reduce((n, [, c]) => n + c, 0)
    out.summary = { by_hold_state: byHold, [`by_${K.kind}`]: rest ? { ...top, other: rest } : top }
  }
  if (hiddenOptedOut) out.hidden_opted_out = hiddenOptedOut
  if (f.near && noCoordinates) notes.push(caseyText("src/case-tools-search.js#10", [noCoordinates]))
  if (more) notes.unshift(caseyText("src/case-tools-search.js#11", [page.length, total, behind ? caseyText("src/case-tools-search.js#s18", [behind]) : '']))
  if (!total) notes.unshift(caseyText("src/case-tools-search.js#12"))
  else if (!page.length) notes.unshift(caseyText("src/case-tools-search.js#13"))
  if (notes.length) out.note = notes.join(' ')
  return out
}

export function buildSearchTools(store, { stageValues }) {
  return [
    defTool('case_search', 'cases',
      caseyText("src/case-tools-search.js#14"),
      {
        type: 'object',
        properties: {
          q: str(caseyText("src/case-tools-search.js#15")),
          scope: str(caseyText("src/case-tools-search.js#16"), { enum: SCOPES }),
          state: str(caseyText("src/case-tools-search.js#17", [stageValues.join(', ')])),
          stage: str(caseyText("src/case-tools-search.js#s19")),
          flag: { type: 'array', items: { type: 'string', enum: FLAGS }, description: caseyText("src/case-tools-search.js#18") },
          ...(KIND_ARG ? { [KIND_ARG]: str(caseyText("src/case-tools-search.js#s20")) } : {}),
          [TOOL_ARG.condition]: str(caseyText("src/case-tools-search.js#s21")),
          missing: str(caseyText("src/case-tools-search.js#19")),
          since: str(caseyText("src/case-tools-search.js#20")),
          until: str(caseyText("src/case-tools-search.js#21")),
          date_by: str(caseyText("src/case-tools-search.js#22"), { enum: DATE_BY }),
          near: { type: 'object', description: caseyText("src/case-tools-search.js#23"), properties: { lat: { type: 'number' }, lon: { type: 'number' } } },
          near_me: { type: 'boolean', description: caseyText("src/case-tools-search.js#24") },
          radius_km: { type: 'number', description: caseyText("src/case-tools-search.js#25") },
          sort: str(caseyText("src/case-tools-search.js#26"), { enum: SORTS }),
          limit: { type: 'number', description: caseyText("src/case-tools-search.js#s22", [DEFAULT_LIMIT, MAX_LIMIT]) },
          after: str(caseyText("src/case-tools-search.js#27")),
        },
      },
      async (args, ctx) => searchCases(store(), ctx, args)),
  ]
}
