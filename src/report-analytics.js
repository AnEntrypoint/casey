// report-analytics.js -- management analytics that the single-window briefing
// (report.js) does not yet compute: SLA compliance pass/fail, period-over-period
// comparison, and per-intake-channel response speed. Pure and deterministic like
// overview.js: given case rows + their events (+ now / window), each returns an
// aggregate-only object (no per-contact rows, never external_id) for /api/report.json
// and the management report. Times in stored events are unix SECONDS; every
// duration returned is MILLISECONDS so the SAST formatters and ms thresholds agree.

import { buildOverview, firstResponseMs, median, evData } from './overview.js'

const DAY = 24 * 3600 * 1000

// SLA compliance over the open + recently-closed pool: for every case that has
// an answerable first inbound, did the first reply land within slaTargetMs? A
// case never answered counts as breached (the worst miss), so the rate is honest
// rather than flattering. breached_by_reason splits answered-late vs never-answered
// so a manager can tell a slow team from an unstaffed one. Aggregate-only.
export function buildSLAReport(cases, eventsByCaseId, slaTargetMs, now = Date.now()) {
  const target = Number.isFinite(slaTargetMs) && slaTargetMs > 0 ? slaTargetMs : 30 * 60 * 1000
  let met = 0, late = 0, neverAnswered = 0, considered = 0
  for (const c of cases || []) {
    const events = eventsByCaseId.get?.(c.id) || eventsByCaseId[c.id] || []
    const hasInbound = events.some(e => e.kind === 'inbound')
    if (!hasInbound) continue // no contact message -> nothing was owed
    considered++
    const r = firstResponseMs(events)
    if (r == null) { neverAnswered++; continue } // an unanswered inbound is a breach
    if (r <= target) met++; else late++
  }
  const breached = late + neverAnswered
  const breachPct = considered ? Math.round((breached / considered) * 1000) / 10 : 0
  return {
    sla_target_ms: target,
    considered,
    met_count: met,
    breached_count: breached,
    breach_pct: breachPct,
    breached_by_reason: { answered_late: late, never_answered: neverAnswered },
  }
}

// The same SLA compliance, segmented by case_type, so a director can ask whether
// outbreak cases meet the handoff bar more (or less) often than routine intake.
// Partitions the pool on c.case_type (unset when the field is blank) and runs the
// existing buildSLAReport per slice; `overall` is the unsegmented figure so the
// by-type rows always reconcile against one total. Aggregate-only, no external_id.
export function buildSLAReportByType(cases, eventsByCaseId, slaTargetMs, now = Date.now()) {
  const byType = {}
  const groups = new Map()
  for (const c of cases || []) {
    const t = c.case_type || 'unset'
    if (!groups.has(t)) groups.set(t, [])
    groups.get(t).push(c)
  }
  for (const [t, slice] of groups) {
    byType[t] = buildSLAReport(slice, eventsByCaseId, slaTargetMs, now)
  }
  return {
    by_type: byType,
    overall: buildSLAReport(cases, eventsByCaseId, slaTargetMs, now),
  }
}

// Period-over-period comparison: run the existing overview builder over two
// adjacent windows ([now-window, now] vs [now-2*window, now-window]) and return
// both snapshots plus signed deltas a manager reads at a glance. A null median in
// either window yields a null delta (not a misleading 0). Aggregate-only.
export function buildReportComparison(cases, eventsByCaseId, now = Date.now(), windowMs = 14 * DAY) {
  const current = buildOverview(cases, eventsByCaseId, now, windowMs)
  const prior = buildOverview(cases, eventsByCaseId, now - windowMs, windowMs)
  const sum = (m) => Object.values(m || {}).reduce((s, n) => s + n, 0)
  const pctDelta = (a, b) => (a == null || b == null || b === 0) ? null : Math.round(((a - b) / b) * 1000) / 10
  const curOpened = sum(current.opened_by_day), priOpened = sum(prior.opened_by_day)
  const curClosed = sum(current.closed_by_day), priClosed = sum(prior.closed_by_day)
  const curMed = current.first_response_ms.median, priMed = prior.first_response_ms.median
  return {
    window_ms: windowMs,
    current: {
      median_first_response_ms: curMed,
      opened: curOpened, closed: curClosed,
    },
    prior: {
      median_first_response_ms: priMed,
      opened: priOpened, closed: priClosed,
    },
    deltas: {
      // negative response_time_delta_pct = faster (improvement)
      response_time_delta_pct: pctDelta(curMed, priMed),
      opened_delta: curOpened - priOpened,
      closed_delta: curClosed - priClosed,
    },
  }
}

// A case is reopened when a transition event moves it OUT of resolved/closed back
// to an active stage. Counting these per slice tells a manager whether a channel
// (or case type) is being closed prematurely. Reads transition events only.
function reopenCount(events) {
  let n = 0
  for (const e of events) {
    if (e.kind !== 'transition') continue
    const d = evData(e)
    const from = String(d.from || '')
    const to = String(d.to || '')
    if ((from === 'resolved' || from === 'closed') && to && to !== 'resolved' && to !== 'closed') n++
  }
  return n
}

// Per-intake-channel response speed + volume + quality so a manager can see whether
// (say) WhatsApp intake is slower than the web form, and which channel actually
// resolves cleanly. Median first-response, opened/closed counts, closure rate, and
// reopen count per channel. Aggregate-only; channel is a coarse enum, not a PII.
export function buildChannelMetrics(cases, eventsByCaseId) {
  return rollupByKey(cases, eventsByCaseId, (c) => c.channel || 'other')
}

// Per-case-type response speed + volume, so the case_type enum becomes a real
// management lens: do import_alerts spike, do outbreaks answer slower? Identical
// shape to buildChannelMetrics, keyed on c.case_type (unset when blank).
export function buildCaseTypeMetrics(cases, eventsByCaseId) {
  return rollupByKey(cases, eventsByCaseId, (c) => c.case_type || 'unset')
}

// Shared rollup the two metrics above specialise by their key function -- one loop,
// one shape, so the channel and case_type lenses can never drift apart.
function rollupByKey(cases, eventsByCaseId, keyOf) {
  const byKey = {}
  for (const c of cases || []) {
    const k = keyOf(c)
    const slot = byKey[k] || (byKey[k] = { responses: [], opened: 0, closed: 0, reopens: 0 })
    slot.opened++
    if (c.status === 'resolved' || c.status === 'closed') slot.closed++
    const events = eventsByCaseId.get?.(c.id) || eventsByCaseId[c.id] || []
    const r = firstResponseMs(events)
    if (r != null) slot.responses.push(r)
    slot.reopens += reopenCount(events)
  }
  const out = {}
  for (const [k, s] of Object.entries(byKey)) {
    out[k] = {
      first_response_ms_median: median(s.responses),
      opened_count: s.opened,
      closed_count: s.closed,
      answered_count: s.responses.length,
      closed_pct: s.opened ? Math.round((s.closed / s.opened) * 1000) / 10 : 0,
      reopen_count: s.reopens,
    }
  }
  return out
}

// Structured, machine-parseable breach payload for an external pager
// (PagerDuty/Opsgenie/a generic webhook), as opposed to the scraped Discord text
// line. Carries the case ref, its case_type (so the pager can route an outbreak
// differently from a follow_up), the breach kind, a severity tier, and the elapsed
// time -- and NEVER the external_id, so a compliance pager file cannot leak a
// contact phone. `escalated` marks the supervisor tier. Pure; the notifier POSTs it.
const ESCALATED_TIER = 'escalated'
export function buildAlertPayload(c, breach, detail, opts = {}) {
  const sinceMs = Number.isFinite(opts.sinceMs) ? opts.sinceMs : null
  return {
    case_ref: c?.ref || null,
    case_type: c?.case_type || 'unset',
    breach_type: breach || null,
    severity_tier: opts.escalated ? ESCALATED_TIER : 'breach',
    since_ms: sinceMs,
    sla_window_ms: Number.isFinite(opts.slaWindowMs) ? opts.slaWindowMs : null,
    detail: detail || breach || '',
  }
}
