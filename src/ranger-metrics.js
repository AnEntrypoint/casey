// ranger-metrics.js -- how the field team is actually doing, measured from the
// timeline events of each report. Pure functions: cases + their events + the
// team roster in, plain numbers out; nothing here reads a store or the clock.
//
// WHY THIS EXISTS. The overview's first_response_ms runs from the reporter's
// first message to the first outbound, and the bot's own replies count, so it
// measures the assistant and says nothing about a ranger. These are the human
// numbers, per ranger / technician and per area:
//   first_action   an assignment to the holder's first act on the report
//   signoff        a hand-over to the sign-off desk to the report being finished
//   nudges         operator reminders sent while a person held the report, and
//                  the share of holdings that needed one
//   stuck          reports still open with a holder who has done nothing on them
//                  for longer than stuckHours
//
// A "holding" (episode) is one span during which one person is the assignee: it
// starts at an assignment event and ends at the next assignment or release. A
// report given to two people in turn is two holdings, one per person.
//
// WHAT COUNTS AS THE HOLDER'S ACT. An event after the assignment that is not the
// reporter's message, not the assistant's or the system's, not an operator
// reminder, and that names the holder: their WhatsApp team tools stamp
// `staff_contact_id`, dashboard logins stamp `by: <username>`, a relayed photo or
// pin is worded "relayed by <name>", and a WhatsApp transition carries their name
// in its reason. Anything that cannot be tied to the holder is NOT counted for
// them, so these figures err toward "no action yet", never toward flattery.
//
// KNOWN LIMIT. A nudge sent by opening the operator's own WhatsApp from the
// Nudges panel (the wa.me link) leaves no event, so it cannot be counted; only
// reminders sent through casey (which log `operator_reminder`) are.
//
// PRIVACY. Person rows are for staff and carry names. Area rows are folded by
// privacy.js: an area with fewer than MIN_AGGREGATE_CELL holdings joins
// 'other/sparse', which itself reports no figures while it is still under the floor.
import { tsMs } from './timestamp.js'
import { evData } from './safe.js'
import { MIN_AGGREGATE_CELL, SPARSE_BUCKET_KEY, UNSUPPRESSED_BUCKET_KEYS } from './privacy.js'

export const DEFAULT_STUCK_HOURS = 48
const HOUR = 3600e3
const DONE = new Set(['resolved', 'closed'])
const REMINDER_FLAG = 'operator_reminder'

const lc = (v) => String(v == null ? '' : v).trim().toLowerCase()

export function median(xs) {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y)
  if (!a.length) return null
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2)
}
export function p90(xs) {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y)
  if (!a.length) return null
  return a[Math.max(0, Math.min(a.length - 1, Math.ceil(0.9 * a.length) - 1))]
}
const dist = (xs) => ({ n: xs.length, median_ms: median(xs), p90_ms: p90(xs) })

// person: { id, name, role, keys: [assignee keys they may be held under], ids: [lowercase identifiers] }
export function indexPeople(people) {
  const byKey = new Map()
  const idOwners = new Map()
  for (const p of people) {
    for (const k of p.keys || []) byKey.set(lc(k), p)
    for (const i of new Set((p.ids || []).map(lc).filter(Boolean))) {
      if (!idOwners.has(i)) idOwners.set(i, new Set())
      idOwners.get(i).add(p.id)
    }
  }
  // An identifier two people share (two "John"s) names nobody in particular.
  const ambiguous = new Set([...idOwners].filter(([, s]) => s.size > 1).map(([i]) => i))
  return { byKey, ambiguous }
}

function namesPerson(p, e, d, ambiguous) {
  const ids = new Set((p.ids || []).map(lc).filter((i) => i && !ambiguous.has(i)))
  for (const v of [d.by, d.staff_contact_id, d.claimed_by, d.signed_off_by]) { const s = lc(v); if (s && ids.has(s)) return true }
  const sc = lc(d.staff_contact_id)
  if (sc && ids.has('contact:' + sc)) return true
  const text = lc(e.text)
  if (e.kind === 'transition') {
    const reason = lc(d.reason)
    for (const i of ids) if (reason.startsWith(i + ':')) return true
  }
  for (const i of ids) if (i.length > 2 && !i.startsWith('contact:') && text.includes('relayed by ' + i)) return true
  return false
}

const isHumanActEvent = (e, d) => {
  if (e.kind === 'inbound' || e.kind === 'draft' || e.kind === 'autonomy_change') return false
  if (e.actor === 'contact' || e.actor === 'agent') return false
  if (d[REMINDER_FLAG]) return false
  if (d.area_auto_assigned || d.by === 'area-router') return false
  return true
}

// One case -> { episodes, signoffs }.
function walkCase(c, events, byKey, ambiguous, now, unclaimed) {
  const evs = events.map((e) => ({ e, d: evData(e), at: tsMs(e.created_at) })).filter((x) => Number.isFinite(x.at)).sort((a, b) => a.at - b.at)
  const isOpen = !DONE.has(c.status)
  const marks = []
  for (const x of evs) {
    if (x.e.kind !== 'action') continue
    const has = 'claimed_by' in x.d || 'assignee' in x.d
    if (!has) continue
    const key = lc(x.d.claimed_by ?? x.d.assignee)
    marks.push({ at: x.at, key: !key || key === unclaimed ? null : key, ev: x.e })
  }
  const cur = lc(c.assignee)
  const heldNow = cur && cur !== unclaimed ? cur : null
  // A holder set without an assignment event (CLI, import): span from creation.
  if (heldNow && !marks.length) marks.push({ at: tsMs(c.created_at), key: heldNow, ev: null, inferred: true })
  const episodes = []
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i]
    if (!m.key) continue
    const person = byKey.get(m.key)
    if (!person || !Number.isFinite(m.at)) continue
    const end = i + 1 < marks.length ? marks[i + 1].at : Infinity
    let first = null, last = null, nudges = 0
    for (const x of evs) {
      if (x.at < m.at || x.at >= end || x.e === m.ev) continue
      if (x.e.kind === 'outbound' && x.d[REMINDER_FLAG]) { nudges++; continue }
      if (isHumanActEvent(x.e, x.d) && namesPerson(person, x.e, x.d, ambiguous)) {
        if (first == null) first = x.at
        last = x.at
      }
    }
    const current = i === marks.length - 1 && isOpen && m.key === heldNow
    episodes.push({
      person, start: m.at, first_action_ms: first == null ? null : first - m.at,
      nudges, current, idle_since: last == null ? m.at : Math.max(m.at, last), acted: first != null, inferred: !!m.inferred,
    })
  }
  const signoffs = []
  for (const x of evs) {
    if (x.e.kind !== 'transition' || !DONE.has(x.d.to)) continue
    let handed = null
    for (const y of evs) {
      if (y.at > x.at) break
      if (y.d.handed_off) handed = y.at
      else if (y.d.handoff_withdrawn) handed = null
    }
    if (handed == null) continue
    const signer = [...new Set([...byKey.values()])].find((p) => namesPerson(p, x.e, x.d, ambiguous)) || null
    signoffs.push({ person: signer, ms: Math.max(0, x.at - handed) })
  }
  return { episodes, signoffs }
}

function aggregate(episodes, signoffs, stuckMs, now) {
  const acted = episodes.filter((e) => e.first_action_ms != null)
  const nudged = episodes.filter((e) => e.nudges > 0)
  const stuck = episodes.filter((e) => e.current && now - e.idle_since > stuckMs)
  return {
    assigned: episodes.length,
    first_action: dist(acted.map((e) => e.first_action_ms)),
    waiting_no_action: episodes.filter((e) => e.current && !e.acted).length,
    signoff: dist(signoffs.map((s) => s.ms)),
    nudges: episodes.reduce((s, e) => s + e.nudges, 0),
    reports_nudged: nudged.length,
    nudge_share: episodes.length ? Math.round((nudged.length / episodes.length) * 1000) / 1000 : null,
    stuck: stuck.length,
  }
}

const EMPTY_STATS = { first_action: null, waiting_no_action: null, signoff: null, nudges: null, reports_nudged: null, nudge_share: null, stuck: null }

// inputs: { cases, eventsByCase: Map|object, people, groupOf?(case)->string, now, stuckHours, sinceMs, k, unclaimed }
export function buildTeamMetrics({ cases, eventsByCase, people, groupOf = () => 'unknown', now, stuckHours = DEFAULT_STUCK_HOURS, sinceMs = 0, k = MIN_AGGREGATE_CELL, unclaimed = 'agent' }) {
  const { byKey, ambiguous } = indexPeople(people)
  const stuckMs = Math.max(1, Number(stuckHours) || DEFAULT_STUCK_HOURS) * HOUR
  const evOf = (id) => (eventsByCase?.get ? eventsByCase.get(id) : eventsByCase?.[id]) || []
  const eps = [], sos = []
  for (const c of cases || []) {
    if (c.channel === 'system') continue
    const group = String(groupOf(c) || 'unknown')
    const w = walkCase(c, evOf(c.id), byKey, ambiguous, now, lc(unclaimed))
    for (const e of w.episodes) if (e.start >= sinceMs) eps.push({ ...e, group })
    for (const s of w.signoffs) sos.push({ ...s, group })
  }
  const rows = people.map((p) => ({
    name: p.name, role: p.role || null,
    ...aggregate(eps.filter((e) => e.person === p), sos.filter((s) => s.person === p), stuckMs, now),
  })).filter((r) => r.assigned || r.signoff.n)
  rows.sort((a, b) => (b.stuck - a.stuck) || (b.nudges - a.nudges) || a.name.localeCompare(b.name))

  const groups = new Map()
  for (const e of eps) { const g = groups.get(e.group) || { eps: [], sos: [] }; g.eps.push(e); groups.set(e.group, g) }
  for (const s of sos) { const g = groups.get(s.group) || { eps: [], sos: [] }; g.sos.push(s); groups.set(s.group, g) }
  const areas = []
  const sparse = { eps: [], sos: [] }
  for (const [name, g] of groups) {
    if (g.eps.length >= k || UNSUPPRESSED_BUCKET_KEYS.has(name)) areas.push({ area: name, ...aggregate(g.eps, g.sos, stuckMs, now) })
    else { sparse.eps.push(...g.eps); sparse.sos.push(...g.sos) }
  }
  areas.sort((a, b) => b.assigned - a.assigned || a.area.localeCompare(b.area))
  if (sparse.eps.length || sparse.sos.length) {
    const agg = aggregate(sparse.eps, sparse.sos, stuckMs, now)
    areas.push(sparse.eps.length >= k ? { area: SPARSE_BUCKET_KEY, ...agg } : { area: SPARSE_BUCKET_KEY, assigned: null, ...EMPTY_STATS, suppressed: true })
  }
  return {
    generated_at: now, stuck_hours: stuckMs / HOUR, k,
    overall: aggregate(eps, sos, stuckMs, now),
    people: rows, areas,
  }
}
