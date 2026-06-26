// report.js -- the management briefing aggregator. Composes the same pure
// pieces the dashboard tabs use (buildOverview for response time + backlog,
// buildGeo for area rollup) plus per-stage and per-period counts, into one
// flat object the CSV and the print-friendly HTML both render. Pure, no I/O:
// the store hands in case rows + events, this returns the briefing numbers.
//
// "this period" is the same window buildOverview scopes (days), so opened/closed
// counts agree with the metrics tab. Health breaches are passed in already
// classified (the caller has the live thresholds) so this stays I/O-free.

import { buildOverview } from './overview.js'
import { buildGeo } from './geo.js'
import { buildWorkload } from './workload.js'

// breachRows: array of {breach} objects (classifyCaseHealth output) flattened
// across the open pool; counted here into a breach -> count map.
// roster ([{id,name}], may be empty) + staleMs feed the per-operator workload
// rollup so a manager's briefing names who is holding what and how responsive
// each person has been -- the same aggregate-only (no PII) cards the dashboard
// Team panel shows, composed here instead of fetched separately.
export function buildReport(cases, eventsByCaseId, breachRows, now = Date.now(), days = 14, roster = [], staleMs = 24 * 3600 * 1000) {
  const overview = buildOverview(cases, eventsByCaseId, now, days * 24 * 3600 * 1000)
  const open = (cases || []).filter(c => c.status !== 'resolved' && c.status !== 'closed')
  const geo = buildGeo(open)
  const workload = buildWorkload(cases, eventsByCaseId, roster, now, staleMs)

  const byStage = {}
  for (const c of cases || []) byStage[c.status] = (byStage[c.status] || 0) + 1

  const breaches = {}
  for (const b of breachRows || []) {
    const tag = (b && b.breach) || 'breach'
    breaches[tag] = (breaches[tag] || 0) + 1
  }

  const openedThisPeriod = Object.values(overview.opened_by_day).reduce((s, n) => s + n, 0)
  const closedThisPeriod = Object.values(overview.closed_by_day).reduce((s, n) => s + n, 0)

  return {
    generated_at: now,
    period_days: days,
    totals: { all: (cases || []).length, open: open.length, closed: overview.cases.closed },
    opened_this_period: openedThisPeriod,
    closed_this_period: closedThisPeriod,
    by_stage: byStage,
    median_first_response_ms: overview.first_response_ms.median,
    p90_first_response_ms: overview.first_response_ms.p90,
    dwell_ms_median: overview.dwell_ms_median,
    by_area: geo.map(g => ({ place: g.place, count: g.count })),
    breaches,
    // Aggregate-only worst-first per-operator cards (no external_id, no per-contact
    // rows): name + how much each holds and how responsive they have been.
    by_operator: workload.operators.map(o => ({
      name: o.name,
      open_assigned: o.open_assigned,
      stale_claims: o.stale_claims,
      replies_24h: o.replies_24h,
      first_reply_ms_median: o.first_reply_ms_median,
      oldest_waiting_ms: o.oldest_waiting_ms,
    })),
  }
}
