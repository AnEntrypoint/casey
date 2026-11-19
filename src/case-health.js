

import { tsMs, tagList, parseReport } from './timestamp.js'
import { fieldLabel } from './store/report-shape.js'
import { CRITICAL_FIELDS } from './store/report-shape.js'
import { canQueryCases } from './contact-tiers.js'
import { caseyText } from './deployment-text.js';

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

    out.push({ breach: 'timestamp_corrupt', since_ms: 0, detail: caseyText("src/case-health.js#w0") })
    if (status === 'resolved') return out

    const rep = parseReport(caseRow)
    const visitCritical = Array.isArray(thresholds?.visitCritical) ? thresholds.visitCritical : VISIT_CRITICAL
    const missingCritical = visitCritical.some(k => rep[k] == null || String(rep[k]).trim() === '')
    const activeWorkStages = thresholds?.activeWorkStatuses instanceof Set ? thresholds.activeWorkStatuses : ACTIVE_WORK_STAGES
    if (missingCritical && activeWorkStages.has(status)) {
      out.push({ breach: 'incomplete_critical', since_ms: 0, detail: caseyText("src/case-health.js#w1", [status]) })
    } else if (missingCritical) {
      out.push({ breach: 'abandoned_intake', since_ms: 0, detail: caseyText("src/case-health.js#w2") })
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
      out.push({ breach: 'never_closed', since_ms: idle, detail: caseyText("src/case-health.js#w3", [hours(idle)]) })
    }

    const resolvedRep = parseReport(caseRow)
    const resolvedCritical = Array.isArray(thresholds?.visitCritical) ? thresholds.visitCritical : VISIT_CRITICAL
    const blank = resolvedCritical.filter(k => resolvedRep[k] == null || String(resolvedRep[k]).trim() === '')
    if (blank.length) {

    out.push({ breach: 'premature_complete', since_ms: Number.isFinite(touched) ? idle : 0, detail: caseyText("src/case-health.js#w4", [blank.length, resolvedCritical.length, blank.map(fieldLabel).join(', ')]) })
    }
    return out
  }

  if (Number.isFinite(touched) && idle >= forType('staleMs')) {
    out.push({ breach: 'stale', since_ms: idle, detail: caseyText("src/case-health.js#w5", [hours(idle)]) })
  }

  const cap = thresholds.stageMaxDwellMs?.[status]
  if (cap && Number.isFinite(touched) && idle >= cap) {
    out.push({ breach: 'stuck', since_ms: idle, detail: `in "${status}" for ${hours(idle)} (max ${hours(cap)})` })
  }

  if (tagList(caseRow).includes('needs-human') && Number.isFinite(touched) && idle >= forType('handoffMs')) {
    out.push({ breach: 'unanswered_handoff', since_ms: idle, detail: caseyText("src/case-health.js#w6", [hours(idle)]) })

    const escMs = forType('escalateHandoffMs') ?? (12 * 3600e3)
    if (idle >= escMs) {
      out.push({ breach: 'unanswered_handoff_escalated', since_ms: idle, detail: caseyText("src/case-health.js#w7", [hours(idle)]) })
    }
  }

  if (tagList(caseRow).includes('draft-pending') && Number.isFinite(touched) && idle >= (forType('unsentDraftMs') ?? (1 * 3600e3))) {
    out.push({ breach: 'unsent_draft', since_ms: idle, detail: caseyText("src/case-health.js#w8", [hours(idle)]) })
  }

  const rep = parseReport(caseRow)
  const visitCritical = Array.isArray(thresholds?.visitCritical) ? thresholds.visitCritical : VISIT_CRITICAL
  const missingCritical = visitCritical.some(k => rep[k] == null || String(rep[k]).trim() === '')
  if (missingCritical && Number.isFinite(touched) && idle >= forType('abandonMs')) {
    out.push({ breach: 'abandoned_intake', since_ms: idle, detail: caseyText("src/case-health.js#w9", [hours(idle)]) })
  }

  const activeWorkStages = thresholds?.activeWorkStatuses instanceof Set ? thresholds.activeWorkStatuses : ACTIVE_WORK_STAGES
  const icThreshold = forType('incompleteCriticalMs') ?? (8 * 3600e3)
  if (missingCritical && activeWorkStages.has(status) && Number.isFinite(touched) && idle >= icThreshold) {
    out.push({ breach: 'incomplete_critical', since_ms: idle, detail: caseyText("src/case-health.js#w10", [status, hours(idle)]) })
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
  stale: caseyText("src/case-health.js#w11"),
  stuck: caseyText("src/case-health.js#w12"),
  unanswered_handoff: caseyText("src/case-health.js#w13"),
  unanswered_handoff_escalated: caseyText("src/case-health.js#w14"),
  unsent_draft: caseyText("src/case-health.js#w15"),
  abandoned_intake: caseyText("src/case-health.js#w16"),
  incomplete_critical: caseyText("src/case-health.js#w17"),
  never_closed: caseyText("src/case-health.js#w18"),
  timestamp_corrupt: caseyText("src/case-health.js#w19"),
  premature_complete: caseyText("src/case-health.js#w20"),
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
