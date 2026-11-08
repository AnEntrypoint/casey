

import { tsMs, tagList, parseReport } from './timestamp.js'
import { fieldLabel } from './store/report-shape.js'
import { CRITICAL_FIELDS } from './store/report-shape.js'
import { canQueryCases } from './contact-tiers.js'

export const DEFAULT_THRESHOLDS = {
  staleMs: 48 * 3600e3,
  handoffMs: 4 * 3600e3,
  escalateHandoffMs: 12 * 3600e3,
  abandonMs: 24 * 3600e3,
  neverClosedMs: 7 * 24 * 3600e3,

  incompleteCriticalMs: 8 * 3600e3,

  unsentDraftMs: 1 * 3600e3,

  workerLocationStaleMs: 3 * 3600e3,

  areaNearestMaxKm: 150,

  stageMaxDwellMs: {
    new: 12 * 3600e3,
    triaging: 24 * 3600e3,
    in_progress: 5 * 24 * 3600e3,
    waiting: 7 * 24 * 3600e3,
  },
}

export const VISIT_CRITICAL = CRITICAL_FIELDS

const OPEN = new Set(['new', 'triaging', 'in_progress', 'waiting', 'resolved'])

const ACTIVE_WORK_STAGES = new Set(['in_progress', 'waiting'])

function lastTouch(c) {

  const le = tsMs(c?.last_event_at), ca = tsMs(c?.created_at)
  return Number.isNaN(le) ? ca : le
}

export function classifyCaseHealth(caseRow, now, thresholds = DEFAULT_THRESHOLDS) {
  const out = []
  if (!caseRow || !Number.isFinite(now)) return out
  const status = caseRow.status

  const openStatuses = thresholds?.openStatuses instanceof Set ? thresholds.openStatuses : OPEN
  if (status === 'closed' || !openStatuses.has(status)) return out

  const touched = lastTouch(caseRow)
  if (!Number.isFinite(touched)) {

    out.push({ breach: 'timestamp_corrupt', since_ms: 0, detail: 'case timestamps missing or corrupted; unable to assess staleness' })
    if (status === 'resolved') return out

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

  const caseType = caseRow.case_type || 'unset'
  const forType = (key) => {
    const perType = thresholds?.byCaseType?.[caseType]?.[key]
    return Number.isFinite(perType) ? perType : thresholds?.[key]
  }

  if (status === 'resolved') {
    if (Number.isFinite(touched) && idle >= forType('neverClosedMs')) {
      out.push({ breach: 'never_closed', since_ms: idle, detail: `resolved but not closed for ${hours(idle)}` })
    }

    const resolvedRep = parseReport(caseRow)
    const resolvedCritical = Array.isArray(thresholds?.visitCritical) ? thresholds.visitCritical : VISIT_CRITICAL
    const blank = resolvedCritical.filter(k => resolvedRep[k] == null || String(resolvedRep[k]).trim() === '')
    if (blank.length) {

    out.push({ breach: 'premature_complete', since_ms: Number.isFinite(touched) ? idle : 0, detail: `marked resolved with ${blank.length} of ${resolvedCritical.length} visit-critical fact(s) still blank: ${blank.map(fieldLabel).join(', ')}` })
    }
    return out
  }

  if (Number.isFinite(touched) && idle >= forType('staleMs')) {
    out.push({ breach: 'stale', since_ms: idle, detail: `no activity for ${hours(idle)}` })
  }

  const cap = thresholds.stageMaxDwellMs?.[status]
  if (cap && Number.isFinite(touched) && idle >= cap) {
    out.push({ breach: 'stuck', since_ms: idle, detail: `in "${status}" for ${hours(idle)} (max ${hours(cap)})` })
  }

  if (tagList(caseRow).includes('needs-human') && Number.isFinite(touched) && idle >= forType('handoffMs')) {
    out.push({ breach: 'unanswered_handoff', since_ms: idle, detail: `a person was asked for ${hours(idle)} ago` })

    const escMs = forType('escalateHandoffMs') ?? (12 * 3600e3)
    if (idle >= escMs) {
      out.push({ breach: 'unanswered_handoff_escalated', since_ms: idle, detail: `still no operator reply after ${hours(idle)} -- escalating` })
    }
  }

  if (tagList(caseRow).includes('draft-pending') && Number.isFinite(touched) && idle >= (forType('unsentDraftMs') ?? (1 * 3600e3))) {
    out.push({ breach: 'unsent_draft', since_ms: idle, detail: `a drafted reply has waited ${hours(idle)} for approval` })
  }

  const rep = parseReport(caseRow)
  const visitCritical = Array.isArray(thresholds?.visitCritical) ? thresholds.visitCritical : VISIT_CRITICAL
  const missingCritical = visitCritical.some(k => rep[k] == null || String(rep[k]).trim() === '')
  if (missingCritical && Number.isFinite(touched) && idle >= forType('abandonMs')) {
    out.push({ breach: 'abandoned_intake', since_ms: idle, detail: `on-site facts still missing after ${hours(idle)}` })
  }

  const activeWorkStages = thresholds?.activeWorkStatuses instanceof Set ? thresholds.activeWorkStatuses : ACTIVE_WORK_STAGES
  const icThreshold = forType('incompleteCriticalMs') ?? (8 * 3600e3)
  if (missingCritical && activeWorkStages.has(status) && Number.isFinite(touched) && idle >= icThreshold) {
    out.push({ breach: 'incomplete_critical', since_ms: idle, detail: `in ${status} for ${hours(idle)} but visit-critical facts still missing` })
  }

  return out
}

function hours(msVal) {
  const h = msVal / 3600e3
  if (h < 1) return `${Math.round(msVal / 60e3)} min`
  if (h < 48) return `${Math.round(h)}h`
  return `${Math.round(h / 24)} days`
}

export function healthTag(breach) { return 'health:' + breach }

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

export const WORKER_CHECKIN_WINDOW_MS = 7 * 24 * 3600e3
export function classifyWorkerCheckins(contacts, now = Date.now(), checkinWindowMs = WORKER_CHECKIN_WINDOW_MS) {
  const overdue = []
  for (const c of contacts) {

    if (!canQueryCases(c.tier)) continue

    const lastAt = c.last_location_at ? tsMs(c.last_location_at) : null
    const ageMs = lastAt ? now - lastAt : Infinity
    if (!Number.isFinite(ageMs) || ageMs > checkinWindowMs) {

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
