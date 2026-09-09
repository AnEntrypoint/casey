// case-health.js  --  time-based guardrails: how a case goes WRONG OVER TIME.
//
// The lifecycle machine stops illegal STAGE moves, but it says nothing about a
// case that is technically in a legal stage yet quietly rotting -- a report that
// no one has touched in days, a stage a case has been stuck in far too long, a
// farmer who asked for a human and never got one, an intake abandoned with the
// on-site facts still missing. Those are the failures that lose a disease report.
//
// classifyCaseHealth is a PURE function of (case row, now, thresholds): no clock,
// no I/O. `now` is injected so every breach boundary is testable to the
// millisecond. It returns the list of breaches currently true for the case; the
// sweep layer turns that list into observable tags and notes.

import { tsMs, tagList, parseReport } from './timestamp.js'
import { fieldLabel } from './store/report-shape.js'
import { CRITICAL_FIELDS } from './store/report-shape.js'

// Default thresholds, in milliseconds, tuned for a rural one-shot reporting
// service where a field visit is the goal and delay is the enemy. Every value is
// overridable so an operator team can tighten or relax without code changes.
export const DEFAULT_THRESHOLDS = {
  staleMs: 48 * 3600e3,            // open, untouched for 2 days
  handoffMs: 4 * 3600e3,           // a human was asked for, none replied in 4h
  escalateHandoffMs: 12 * 3600e3,  // still no operator reply after 12h -- escalate
  abandonMs: 24 * 3600e3,          // intake stalled with on-site facts missing
  neverClosedMs: 7 * 24 * 3600e3,  // resolved but not closed for a week
  // A case in active work (past triaging) that still has critical facts missing.
  // Worse than abandoned_intake because work has started but the visit cannot proceed.
  incompleteCriticalMs: 8 * 3600e3,
  // An assisted-mode draft reply composed but not yet approved/sent. The contact
  // is waiting on a human to release it, so a stale draft is a silent delay.
  unsentDraftMs: 1 * 3600e3,
  // How long a field worker's self-reported location (case_checkin) stays
  // "current" on the operator map before fading/dropping as stale -- a worker
  // moves on, so an hours-old ping is a poor dispatch signal. Not itself a
  // health-breach classifier (no case is unhealthy because of this), just a
  // display/dispatch-relevance cutoff the map layer reads.
  workerLocationStaleMs: 3 * 3600e3,
  // Per-stage maximum dwell. A case sitting in one stage past this is "stuck".
  stageMaxDwellMs: {
    new: 12 * 3600e3,              // un-triaged for half a day
    triaging: 24 * 3600e3,
    in_progress: 5 * 24 * 3600e3,
    waiting: 7 * 24 * 3600e3,
  },
}

// On-site facts a field visit cannot proceed without. Exported so gateway-hooks
// and the dashboard can import the canonical list instead of maintaining copies.
// Default only -- classifyCaseHealth prefers thresholds.visitCritical (an array)
// when present, so a deployment with a different report schema (e.g. a
// case_type whose on-site-critical fields differ) can retune it via
// mergeThresholds/PUT /api/thresholds with no code change. Sourced from the
// active config package's report-fields.yml critical_for_visit flags (see
// store/report-shape.js) rather than a hardcoded literal, so the default
// itself already matches whichever domain (animal-health, IT helpdesk, or a
// deployer's own) is configured.
export const VISIT_CRITICAL = CRITICAL_FIELDS

// Fallback only -- classifyCaseHealth prefers the live thresholds.openStatuses
// (case-sweep.js passes store.getOpenStatuses()) so a workflow-config change is
// picked up with no code edit here.
const OPEN = new Set(['new', 'triaging', 'in_progress', 'waiting', 'resolved'])

// Default "active work" stages -- past triaging, visit not yet dispatched.
// Fallback only -- classifyCaseHealth prefers thresholds.activeWorkStatuses (a
// Set) when present, matching the openStatuses override pattern above, so a
// deployment that renames/restructures workflow stages does not need a code
// change here either. One shared constant, never a literal Set at each call
// site: two copies drift silently when only one is edited.
const ACTIVE_WORK_STAGES = new Set(['in_progress', 'waiting'])

// tsMs/tagList/parseReport are timestamp.js's single shared implementation; do
// not add a local copy here (format.js's toDate stays separate on purpose).
function lastTouch(c) {
  // The most recent signal of activity: last_event_at if present, else created_at.
  const le = tsMs(c?.last_event_at), ca = tsMs(c?.created_at)
  return Number.isNaN(le) ? ca : le
}

// Returns [{ breach, since_ms, detail }] -- the guardrails currently tripped.
// since_ms is how long the breach has been true (for "stale for 3 days" display).
export function classifyCaseHealth(caseRow, now, thresholds = DEFAULT_THRESHOLDS) {
  const out = []
  if (!caseRow || !Number.isFinite(now)) return out
  const status = caseRow.status
  // A closed case is finished: it cannot be stale, stuck, or abandoned. This is
  // the structural guard against flagging done work -- the wrong state is
  // unrepresentable, not merely filtered.
  const openStatuses = thresholds?.openStatuses instanceof Set ? thresholds.openStatuses : OPEN
  if (status === 'closed' || !openStatuses.has(status)) return out

  const touched = lastTouch(caseRow)
  if (!Number.isFinite(touched)) {
    // A resolved case must never surface abandoned_intake/incomplete_critical --
    // both breaches page on-call about work that is done, contradicting the
    // resolved-only-ever-carries-never_closed invariant below. openStatuses
    // includes 'resolved' (it is not 'closed'), so this branch is otherwise
    // reachable for it before that invariant's own status check runs.
    out.push({ breach: 'timestamp_corrupt', since_ms: 0, detail: 'case timestamps missing or corrupted; unable to assess staleness' })
    if (status === 'resolved') return out
    // Every check below this point is gated on a valid `idle` duration (now -
    // touched), which is unavailable here -- but MISSING_CRITICAL is a pure
    // report-shape check with no duration dependency, so it must still run: a
    // corrupt-timestamp case must not also go dark on the sweep's only
    // duration-independent breach class until an operator happens to fix the
    // timestamp. Not a real-time breach (no idle to compare against a window),
    // so it fires once, unconditionally, whenever the fact is genuinely missing.
    const rep = parseReport(caseRow)
    const visitCritical = Array.isArray(thresholds?.visitCritical) ? thresholds.visitCritical : VISIT_CRITICAL
    const missingCritical = visitCritical.some(k => rep[k] == null || String(rep[k]).trim() === '')
    const activeWorkStages = thresholds?.activeWorkStatuses instanceof Set ? thresholds.activeWorkStatuses : ACTIVE_WORK_STAGES
    if (missingCritical && activeWorkStages.has(status)) {
      out.push({ breach: 'incomplete_critical', since_ms: 0, detail: `in ${status} with visit-critical facts still missing (timestamps corrupt, age unknown)` })
    } else if (missingCritical) {
      out.push({ breach: 'abandoned_intake', since_ms: 0, detail: 'on-site facts still missing (timestamps corrupt, age unknown)' })
    }
    return out
  }
  const idle = now - touched
  // A case_type-specific SLA override (thresholds.byCaseType[case_type][key])
  // wins over the deployment-wide default -- e.g. an 'outbreak' can carry a
  // tighter handoffMs than a routine 'follow_up'. Falls straight through to
  // the global value when no per-type override exists (or thatcher's own
  // getFieldEnum-validated default of 'unset'). Inlined rather than imported
  // from thresholds.js: that module imports DEFAULT_THRESHOLDS from HERE, so
  // an import back would be circular; this is a tiny, deliberately duplicated
  // pure lookup, not a second copy of the clamping/merge logic.
  const caseType = caseRow.case_type || 'unset'
  const forType = (key) => {
    const perType = thresholds?.byCaseType?.[caseType]?.[key]
    return Number.isFinite(perType) ? perType : thresholds?.[key]
  }

  // A resolved case is awaiting only closure: its single over-time failure is
  // never being closed. It is not "stale/stuck/abandoned" -- the work is done.
  if (status === 'resolved') {
    if (Number.isFinite(touched) && idle >= forType('neverClosedMs')) {
      out.push({ breach: 'never_closed', since_ms: idle, detail: `resolved but not closed for ${hours(idle)}` })
    }
    // PREMATURE_COMPLETE: resolved means somebody -- usually the agent -- called
    // this done, but the facts a team needs to act on it are still blank. That is
    // a different failure from incomplete_critical, which only fires on ACTIVE
    // work stages (activeWorkStages excludes resolved), so the two cannot both
    // fire on one case: one says "still working and missing facts", this says
    // "claimed finished and missing facts". In disease surveillance the second is
    // worse, because nothing further will happen to the case on its own.
    //
    // Not time-gated. Every other breach here asks "has this sat too long"; this
    // one is wrong the instant it is true, and waiting a window before saying so
    // only delays the correction while the reporter is still reachable.
    const resolvedRep = parseReport(caseRow)
    const resolvedCritical = Array.isArray(thresholds?.visitCritical) ? thresholds.visitCritical : VISIT_CRITICAL
    const blank = resolvedCritical.filter(k => resolvedRep[k] == null || String(resolvedRep[k]).trim() === '')
    if (blank.length) {
      // The field's LABEL, not its storage key. This detail is rendered verbatim
    // on the operator's timeline, and "how_to_find, contact_fallback" is the
    // column name; "How to find the place" is what the dashboard calls the same
    // field everywhere else. fieldLabel falls back to the key, so a field with
    // no declared label degrades to today's behaviour rather than to nothing.
    out.push({ breach: 'premature_complete', since_ms: Number.isFinite(touched) ? idle : 0, detail: `marked resolved with ${blank.length} of ${resolvedCritical.length} visit-critical fact(s) still blank: ${blank.map(fieldLabel).join(', ')}` })
    }
    return out
  }

  // STALE: an open case no one has touched in too long.
  if (Number.isFinite(touched) && idle >= forType('staleMs')) {
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
  if (tagList(caseRow).includes('needs-human') && Number.isFinite(touched) && idle >= forType('handoffMs')) {
    out.push({ breach: 'unanswered_handoff', since_ms: idle, detail: `a person was asked for ${hours(idle)} ago` })
    // ESCALATED tier: a DISTINCT breach (own name -> own health tag) so the sweep,
    // which dedups one observation per newly-entered tag, fires a SECOND, separate
    // notification when the wait crosses the escalation window. Same name with a
    // larger since_ms would never re-fire (the tag is already present).
    const escMs = forType('escalateHandoffMs') ?? (12 * 3600e3)
    if (idle >= escMs) {
      out.push({ breach: 'unanswered_handoff_escalated', since_ms: idle, detail: `still no operator reply after ${hours(idle)} -- escalating` })
    }
  }

  // UNSENT_DRAFT: an assisted-mode reply is composed and waiting for an operator
  // to approve it. The draft-pending tag is set when the draft is held and cleared
  // on approve/discard/supersede, so the tag still being present past the window
  // IS the unsent-draft signal -- the contact is waiting on a human to release it.
  if (tagList(caseRow).includes('draft-pending') && Number.isFinite(touched) && idle >= (forType('unsentDraftMs') ?? (1 * 3600e3))) {
    out.push({ breach: 'unsent_draft', since_ms: idle, detail: `a drafted reply has waited ${hours(idle)} for approval` })
  }

  // ABANDONED_INTAKE: the one-shot capture stalled with on-site facts still
  // missing -- the worst over-time failure, because the farmer has left and the
  // facts are now unrecoverable.
  const rep = parseReport(caseRow)
  const visitCritical = Array.isArray(thresholds?.visitCritical) ? thresholds.visitCritical : VISIT_CRITICAL
  const missingCritical = visitCritical.some(k => rep[k] == null || String(rep[k]).trim() === '')
  if (missingCritical && Number.isFinite(touched) && idle >= forType('abandonMs')) {
    out.push({ breach: 'abandoned_intake', since_ms: idle, detail: `on-site facts still missing after ${hours(idle)}` })
  }

  // INCOMPLETE_CRITICAL: case has moved beyond triaging (active work in progress)
  // but still lacks critical visit facts. The farmer may still be reachable, but
  // the window is closing and the team cannot dispatch without this information.
  const activeWorkStages = thresholds?.activeWorkStatuses instanceof Set ? thresholds.activeWorkStatuses : ACTIVE_WORK_STAGES
  const icThreshold = forType('incompleteCriticalMs') ?? (8 * 3600e3)
  if (missingCritical && activeWorkStages.has(status) && Number.isFinite(touched) && idle >= icThreshold) {
    out.push({ breach: 'incomplete_critical', since_ms: idle, detail: `in ${status} for ${hours(idle)} but visit-critical facts still missing` })
  }

  // There is deliberately NO 'contact_degradation' breach (sustained turn
  // failures for one contact): classifyCaseHealth is never handed per-contact
  // failure data, so any such branch here would be permanently false. The real
  // data does exist (degraded-turns.js, behind /api/turns/degraded); to add the
  // breach, feed that into classifyCaseHealth's inputs and add the tag to
  // ALL_HEALTH_TAGS in the same change, not before.

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
// What a breach is CALLED in text a person reads. The sweep writes an
// observation onto the case timeline for every newly-entered breach, and that
// text used to be `GUARDRAIL [never_closed]: ... Needs attention.` -- a
// bracketed storage key and a filler sentence, on the one surface where an
// operator reads what happened to a case in their own language.
//
// The machine key is unchanged and still travels in the event's `data.guardrail`,
// which is what every consumer actually reads; only the prose changed.
//
// Kept in step with ALL_HEALTH_TAGS below, and deliberately NOT shared with
// dashboard/public/src/views/case-list/inbox-panel.js's own BREACH_FACT table:
// that one runs in the browser, a separate bundle with no import path to this
// module, the same split timestamp.js's tagList documents for the same reason.
// Two tables, one vocabulary -- change both or neither.
export const BREACH_LABEL = {
  stale: 'has gone quiet',
  stuck: 'has been sitting in this stage too long',
  unanswered_handoff: 'asked for a person and nobody has answered',
  unanswered_handoff_escalated: 'still has nobody on it, well past the first deadline',
  unsent_draft: 'has a written reply nobody has sent',
  abandoned_intake: 'was left part-way through with on-site facts missing',
  incomplete_critical: 'is being worked on with visit-critical facts still missing',
  never_closed: 'was resolved but never closed',
  timestamp_corrupt: 'has timestamps of its own that look wrong',
  premature_complete: 'was marked done with facts a field visit needs still blank',
}

export const ALL_HEALTH_TAGS = ['stale', 'stuck', 'unanswered_handoff', 'unanswered_handoff_escalated', 'unsent_draft', 'abandoned_intake', 'incomplete_critical', 'never_closed', 'timestamp_corrupt', 'premature_complete'].map(healthTag)

// Worker check-in baseline: every field_worker should check in at least once per
// configurable window (default 7 days). Returns a list of workers who are past the
// deadline, each with their last check-in timestamp and age. Pure function of
// (contacts, now, thresholds) -- no I/O, no clock.
export const WORKER_CHECKIN_WINDOW_MS = 7 * 24 * 3600e3
export function classifyWorkerCheckins(contacts, now = Date.now(), checkinWindowMs = WORKER_CHECKIN_WINDOW_MS) {
  const overdue = []
  for (const c of contacts) {
    if (c.tier !== 'field_worker') continue
    // tsMs, not new Date(): last_location_at is written as ISO (case-tools.js's
    // check-in handler), but this module already imports the one shared
    // digit-string-aware parser and hooks/prompt.js reads the SAME column
    // through it -- three readers of one column must not each guess differently.
    const lastAt = c.last_location_at ? tsMs(c.last_location_at) : null
    const ageMs = lastAt ? now - lastAt : Infinity
    if (!Number.isFinite(ageMs) || ageMs > checkinWindowMs) {
      // Identity deliberately absent: this row carries no external_id and no
      // display_name, and must not grow one. The only caller, routes/map.js,
      // reads contact_id to build a membership Set and emits a boolean
      // overdue_checkin through workerPinProjection, so either field would be a
      // pure function manufacturing PII no caller wants, one res.json() away
      // from a leak -- and lint's pii-safety gate would not catch it, because
      // that gate keys on the named case/contact projections and on store-call
      // dataflow, and this is neither. Cheaper to not build the value than to
      // guard it.
      overdue.push({
        contact_id: c.id,
        last_checkin_at: c.last_location_at || null,
        age_ms: Number.isFinite(ageMs) ? ageMs : null,
        overdue: true,
      })
    }
  }
  return overdue
}
