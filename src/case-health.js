// case-health.js  --  time-based guardrails: how a case goes WRONG OVER TIME.
//
// The lifecycle machine stops illegal STAGE moves, but it says nothing about a
// case that is technically in a legal stage yet quietly rotting -- a report that
// no one has touched in days, a stage a case has been stuck in far too long, a
// farmer who asked for a human and never got one, an intake abandoned with the
// on-site facts still missing. Those are the failures that lose a disease report,
// and the system had no notion of them.
//
// classifyCaseHealth is a PURE function of (case row, now, thresholds): no clock,
// no I/O. `now` is injected so every breach boundary is testable to the
// millisecond. It returns the list of breaches currently true for the case; the
// sweep layer turns that list into observable tags and notes.

// Default thresholds, in milliseconds, tuned for a rural one-shot reporting
// service where a field visit is the goal and delay is the enemy. Every value is
// overridable so an operator team can tighten or relax without code changes.
export const DEFAULT_THRESHOLDS = {
  staleMs: 48 * 3600e3,            // open, untouched for 2 days
  handoffMs: 4 * 3600e3,           // a human was asked for, none replied in 4h
  abandonMs: 24 * 3600e3,          // intake stalled with on-site facts missing
  neverClosedMs: 7 * 24 * 3600e3,  // resolved but not closed for a week
  // Per-stage maximum dwell. A case sitting in one stage past this is "stuck".
  stageMaxDwellMs: {
    new: 12 * 3600e3,              // un-triaged for half a day
    triaging: 24 * 3600e3,
    in_progress: 5 * 24 * 3600e3,
    waiting: 7 * 24 * 3600e3,
  },
}

// On-site facts a field visit cannot proceed without -- the same set the intake
// flow already treats as visit-critical. Kept here so the classifier is
// self-contained (pure, no import cycle through gateway-hooks).
const VISIT_CRITICAL = ['species', 'symptoms', 'location', 'how_to_find', 'farmer_available', 'contact_fallback']

const OPEN = new Set(['new', 'triaging', 'in_progress', 'waiting', 'resolved'])

function ms(v) {
  // last_event_at is an ISO string (nowIso); created_at can be unix-seconds
  // (thatcher) or ISO. Normalize both to epoch ms, or NaN when unknown.
  if (v == null || v === '') return NaN
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v   // seconds to ms
  const t = Date.parse(v)
  return Number.isNaN(t) ? NaN : t
}
function parseReport(c) {
  try { return c && c.report ? JSON.parse(c.report) : {} } catch { return {} }
}
function tagList(c) {
  return String(c?.tags || '').split(',').map(s => s.trim()).filter(Boolean)
}
function lastTouch(c) {
  // The most recent signal of activity: last_event_at if present, else created_at.
  const le = ms(c?.last_event_at), ca = ms(c?.created_at)
  return Number.isNaN(le) ? ca : le
}

// Returns [{ breach, since_ms, detail }] -- the guardrails currently tripped.
// since_ms is how long the breach has been true (for "stale for 3 days" display).
export function classifyCaseHealth(caseRow, now, thresholds = DEFAULT_THRESHOLDS) {
  const out = []
  if (!caseRow || !Number.isFinite(now)) return out
  const status = caseRow.status
  // A closed case is finished: it cannot be stale, stuck, or abandoned. This is
  // the structural guard against flagging done work (P6 -- the wrong state is
  // unrepresentable, not merely filtered).
  if (status === 'closed' || !OPEN.has(status)) return out

  const touched = lastTouch(caseRow)
  const idle = Number.isFinite(touched) ? now - touched : 0

  // A resolved case is awaiting only closure: its single over-time failure is
  // never being closed. It is not "stale/stuck/abandoned" -- the work is done.
  if (status === 'resolved') {
    if (Number.isFinite(touched) && idle >= thresholds.neverClosedMs) {
      out.push({ breach: 'never_closed', since_ms: idle, detail: `resolved but not closed for ${hours(idle)}` })
    }
    return out
  }

  // STALE: an open case no one has touched in too long.
  if (Number.isFinite(touched) && idle >= thresholds.staleMs) {
    out.push({ breach: 'stale', since_ms: idle, detail: `no activity for ${hours(idle)}` })
  }

  // STUCK: in the current stage past its allowed dwell. We approximate stage
  // entry by last_event_at -- the last transition is an event, so a case that has
  // not moved or been touched since is dwelling. Conservative: only the stages
  // with a configured ceiling are checked.
  const cap = thresholds.stageMaxDwellMs?.[status]
  if (cap && Number.isFinite(touched) && idle >= cap) {
    out.push({ breach: 'stuck', since_ms: idle, detail: `in "${status}" for ${hours(idle)} (max ${hours(cap)})` })
  }

  // UNANSWERED_HANDOFF: the contact asked for a human (needs-human tag) and no
  // operator has replied within the window. An operator reply clears needs-human
  // (see dashboard reply), so the tag still being present IS the unanswered signal.
  if (tagList(caseRow).includes('needs-human') && Number.isFinite(touched) && idle >= thresholds.handoffMs) {
    out.push({ breach: 'unanswered_handoff', since_ms: idle, detail: `a person was asked for ${hours(idle)} ago` })
  }

  // ABANDONED_INTAKE: the one-shot capture stalled with on-site facts still
  // missing -- the worst over-time failure, because the farmer has left and the
  // facts are now unrecoverable.
  const rep = parseReport(caseRow)
  const missingCritical = VISIT_CRITICAL.some(k => rep[k] == null || String(rep[k]).trim() === '')
  if (missingCritical && Number.isFinite(touched) && idle >= thresholds.abandonMs) {
    out.push({ breach: 'abandoned_intake', since_ms: idle, detail: `on-site facts still missing after ${hours(idle)}` })
  }
  return out
}

function hours(msVal) {
  const h = msVal / 3600e3
  if (h < 1) return `${Math.round(msVal / 60e3)} min`
  if (h < 48) return `${Math.round(h)}h`
  return `${Math.round(h / 24)} days`
}

// Stable tag name for a breach, so the sweep can set/clear them idempotently.
export function healthTag(breach) { return 'health:' + breach }
export const ALL_HEALTH_TAGS = ['stale', 'stuck', 'unanswered_handoff', 'abandoned_intake', 'never_closed'].map(healthTag)
