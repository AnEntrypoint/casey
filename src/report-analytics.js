// report-analytics.js -- management analytics that the single-window briefing
// (report.js) does not yet compute: SLA compliance pass/fail, period-over-period
// comparison, and per-intake-channel response speed. Pure and deterministic like
// overview.js: given case rows + their events (+ now / window), each returns an
// aggregate-only object (no per-contact rows, never external_id) for /api/report.json
// and the management report. Times in stored events are unix SECONDS; every
// duration returned is MILLISECONDS so the SAST formatters and ms thresholds agree.

import { buildOverview, firstResponseMs, median } from './overview.js'

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

// Per-intake-channel response speed + volume so a manager can see whether (say)
// WhatsApp intake is slower than the web form. Median first-response, opened and
// closed counts per channel. Aggregate-only; channel is a coarse enum, not a PII.
export function buildChannelMetrics(cases, eventsByCaseId) {
  const byChannel = {}
  for (const c of cases || []) {
    const ch = c.channel || 'other'
    const slot = byChannel[ch] || (byChannel[ch] = { responses: [], opened: 0, closed: 0 })
    slot.opened++
    if (c.status === 'resolved' || c.status === 'closed') slot.closed++
    const events = eventsByCaseId.get?.(c.id) || eventsByCaseId[c.id] || []
    const r = firstResponseMs(events)
    if (r != null) slot.responses.push(r)
  }
  const out = {}
  for (const [ch, s] of Object.entries(byChannel)) {
    out[ch] = {
      first_response_ms_median: median(s.responses),
      opened_count: s.opened,
      closed_count: s.closed,
      answered_count: s.responses.length,
    }
  }
  return out
}
