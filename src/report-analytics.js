

import { buildOverview, firstResponseMs, median, evData } from './overview.js'
import { isOpenCase } from './format.js'
import { tsMs } from './timestamp.js'

const DAY = 24 * 3600 * 1000

export function buildSLAReport(cases, eventsByCaseId, slaTargetMs, now = Date.now()) {
  const target = Number.isFinite(slaTargetMs) && slaTargetMs > 0 ? slaTargetMs : 30 * 60 * 1000
  let met = 0, late = 0, neverAnswered = 0, considered = 0
  for (const c of cases || []) {
    const events = eventsByCaseId.get?.(c.id) || eventsByCaseId[c.id] || []
    const hasInbound = events.some(e => e.kind === 'inbound')
    if (!hasInbound) continue
    considered++
    const r = firstResponseMs(events)
    if (r == null) { neverAnswered++; continue }
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

      response_time_delta_pct: pctDelta(curMed, priMed),
      opened_delta: curOpened - priOpened,
      closed_delta: curClosed - priClosed,
    },
  }
}

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

import { MIN_AGGREGATE_CELL, SPARSE_BUCKET_KEY } from './privacy.js'

export function buildChannelMetrics(cases, eventsByCaseId) {
  return rollupByKey(cases, eventsByCaseId, (c) => c.channel || 'other')
}

export function buildCaseTypeMetrics(cases, eventsByCaseId) {
  return rollupByKey(cases, eventsByCaseId, (c) => c.case_type || 'unset')
}

function rollupByKey(cases, eventsByCaseId, keyOf) {
  const byKey = {}
  for (const c of cases || []) {
    const k = keyOf(c)
    const slot = byKey[k] || (byKey[k] = { responses: [], opened: 0, closed: 0, reopens: 0 })
    slot.opened++
    if (!isOpenCase(c)) slot.closed++
    const events = eventsByCaseId.get?.(c.id) || eventsByCaseId[c.id] || []
    const r = firstResponseMs(events)
    if (r != null) slot.responses.push(r)
    slot.reopens += reopenCount(events)
  }
  return suppressSmallCells(byKey)
}

function suppressSmallCells(byKey) {
  const out = {}
  let sparse = null
  for (const [k, s] of Object.entries(byKey)) {
    const row = {
      first_response_ms_median: median(s.responses),
      opened_count: s.opened,
      closed_count: s.closed,
      answered_count: s.responses.length,
      closed_pct: s.opened ? Math.round((s.closed / s.opened) * 1000) / 10 : 0,
      reopen_count: s.reopens,
    }
    if (s.opened < MIN_AGGREGATE_CELL) {
      if (!sparse) sparse = { responses: [], opened: 0, closed: 0, reopens: 0 }
      sparse.responses.push(...s.responses)
      sparse.opened += s.opened
      sparse.closed += s.closed
      sparse.reopens += s.reopens
      continue
    }
    out[k] = row
  }
  if (sparse) {
    out[SPARSE_BUCKET_KEY] = {
      first_response_ms_median: median(sparse.responses),
      opened_count: sparse.opened,
      closed_count: sparse.closed,
      answered_count: sparse.responses.length,
      closed_pct: sparse.opened ? Math.round((sparse.closed / sparse.opened) * 1000) / 10 : 0,
      reopen_count: sparse.reopens,
    }
  }
  return out
}

export function buildClosureCompleteness(cases, eventsByCaseId, now = Date.now(), windowDays = 7) {
  const windowMs = windowDays * DAY
  let resolvedTotal = 0, closedWithinWindow = 0, closedLate = 0, stillOpen = 0
  for (const c of cases || []) {
    const events = eventsByCaseId.get?.(c.id) || eventsByCaseId[c.id] || []
    let resolvedAt = null, closedAt = null
    for (const e of events) {
      if (e.kind !== 'transition') continue
      const d = evData(e)
      const to = String(d.to || '')

      const ts = tsMs(e.created_at)
      if (!Number.isFinite(ts)) continue
      if (to === 'resolved' && resolvedAt == null) resolvedAt = ts
      if (to === 'closed' && resolvedAt != null && closedAt == null && ts >= resolvedAt) closedAt = ts
    }
    if (resolvedAt == null) continue
    resolvedTotal++
    if (closedAt != null) {
      if (closedAt - resolvedAt <= windowMs) closedWithinWindow++
      else closedLate++
    } else {
      stillOpen++
    }
  }
  const pct = resolvedTotal ? Math.round((closedWithinWindow / resolvedTotal) * 1000) / 10 : 0
  return {
    window_days: windowDays,
    resolved_total: resolvedTotal,
    closed_within_window: closedWithinWindow,
    closed_late: closedLate,
    never_closed: stillOpen,
    closure_completeness_pct: pct,
  }
}

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
