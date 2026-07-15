// thresholds.js  --  validate + clamp + merge operator-tunable health thresholds.
//
// case-health.js owns DEFAULT_THRESHOLDS (the shipped defaults). This module is
// the PURE boundary between an untrusted PUT body and the live thresholds the
// sweep and /api/attention read: it accepts only known keys, clamps every value
// to a sane range, and merges a partial patch over the defaults so a caller can
// tune one knob without resupplying the whole set. No clock, no I/O -- so every
// rule here is testable to the millisecond.
//
// Invalid state is unrepresentable downstream: classifyCaseHealth only ever sees
// a fully-populated, in-range thresholds object, never a half-set or out-of-band
// one, because mergeThresholds always starts from the defaults and drops anything
// it cannot validate.

import { DEFAULT_THRESHOLDS } from './case-health.js'

// Scalar duration knobs, in ms, each clamped to [min, max]. Bounds are wide
// enough for real operator tuning yet refuse nonsense (zero, negative, a century).
const ONE_MIN = 60e3
const HOUR = 3600e3
const DAY = 24 * HOUR
const SCALAR_BOUNDS = {
  staleMs: [HOUR, 30 * DAY],
  handoffMs: [5 * ONE_MIN, 7 * DAY],
  escalateHandoffMs: [5 * ONE_MIN, 14 * DAY],
  abandonMs: [HOUR, 30 * DAY],
  neverClosedMs: [HOUR, 60 * DAY],
  incompleteCriticalMs: [HOUR, 30 * DAY],
  unsentDraftMs: [ONE_MIN, 7 * DAY],
  workerLocationStaleMs: [ONE_MIN, 7 * DAY],
}
// Per-stage dwell ceilings (the nested stageMaxDwellMs map). A stage key is
// accepted whenever it is a non-empty string -- NOT restricted to the shipped
// default's 4 stage names, so a deployment that renames/adds a workflow stage
// in thatcher.config.yml can tune its dwell ceiling with no code change here.
// (Previously a fixed 4-item allowlist silently dropped any other stage name.)
const STAGE_BOUNDS = [HOUR, 60 * DAY]
const MAX_STAGE_KEY_LEN = 64

// Fields whose values are on-site-critical report keys (see case-health.js
// VISIT_CRITICAL) -- an array of short field-name strings, not a duration.
const LIST_KEYS = { visitCritical: { maxItems: 32, maxItemLen: 64 } }

// Per-case_type SLA overrides: byCaseType.<case_type>.<scalarKey> = ms, so an
// 'outbreak' can carry a tighter handoffMs than the deployment-wide default
// while 'follow_up' stays on the looser global one. Only SCALAR_BOUNDS keys
// are eligible (never stageMaxDwellMs/visitCritical -- those are not
// meaningfully "per category"); each value is clamped with the SAME bounds
// as its global counterpart, so a per-type override can never smuggle in an
// out-of-range value the global knob itself would reject. A case_type key is
// accepted whenever it is a non-empty string (not restricted to the shipped
// default enum) so a deployment's own custom case_type values just work.
const MAX_CASE_TYPE_KEY_LEN = 40

export const SCALAR_KEYS = Object.keys(SCALAR_BOUNDS)
export const THRESHOLD_KEYS = [...SCALAR_KEYS, 'stageMaxDwellMs', 'byCaseType', ...Object.keys(LIST_KEYS)]

// Resolve the effective scalar threshold for a specific case_type: a
// byCaseType override for that key wins, otherwise the deployment-wide
// value. `thresholds` is a resolved thresholds object (mergeThresholds'
// output, or DEFAULT_THRESHOLDS). Pure lookup, no clamping (already clamped
// at merge time).
export function resolveScalarForType(thresholds, caseType, key) {
  const perType = thresholds?.byCaseType?.[caseType]?.[key]
  return Number.isFinite(perType) ? perType : thresholds?.[key]
}

function clampInt(v, [min, max]) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  const i = Math.round(n)
  return Math.min(Math.max(i, min), max)
}

// Validate + clamp a raw patch. Returns { thresholds, applied, rejected }:
// thresholds is DEFAULT_THRESHOLDS with every accepted key overlaid; applied lists
// the keys that took effect; rejected lists keys that were unknown or unparseable.
export function mergeThresholds(patch, base = DEFAULT_THRESHOLDS) {
  const out = {
    ...base,
    stageMaxDwellMs: { ...(base.stageMaxDwellMs || {}) },
    byCaseType: { ...(base.byCaseType || {}) },
  }
  const applied = []
  const rejected = []
  const src = patch && typeof patch === 'object' ? patch : {}
  for (const key of Object.keys(src)) {
    if (key === 'byCaseType') {
      const byType = src.byCaseType
      if (!byType || typeof byType !== 'object') { rejected.push(key); continue }
      const outByType = { ...(base.byCaseType || {}) }
      for (const ct of Object.keys(byType)) {
        if (typeof ct !== 'string' || !ct || ct.length > MAX_CASE_TYPE_KEY_LEN) { rejected.push(`byCaseType.${ct}`); continue }
        const overrides = byType[ct]
        if (!overrides || typeof overrides !== 'object') { rejected.push(`byCaseType.${ct}`); continue }
        const outOverrides = { ...(outByType[ct] || {}) }
        for (const sk of Object.keys(overrides)) {
          if (!(sk in SCALAR_BOUNDS)) { rejected.push(`byCaseType.${ct}.${sk}`); continue }
          const c = clampInt(overrides[sk], SCALAR_BOUNDS[sk])
          if (c === null) { rejected.push(`byCaseType.${ct}.${sk}`); continue }
          outOverrides[sk] = c
          applied.push(`byCaseType.${ct}.${sk}`)
        }
        outByType[ct] = outOverrides
      }
      out.byCaseType = outByType
      continue
    }
    if (key === 'stageMaxDwellMs') {
      const stages = src.stageMaxDwellMs
      if (!stages || typeof stages !== 'object') { rejected.push(key); continue }
      for (const sk of Object.keys(stages)) {
        if (typeof sk !== 'string' || !sk || sk.length > MAX_STAGE_KEY_LEN) { rejected.push(`stageMaxDwellMs.${sk}`); continue }
        const c = clampInt(stages[sk], STAGE_BOUNDS)
        if (c === null) { rejected.push(`stageMaxDwellMs.${sk}`); continue }
        out.stageMaxDwellMs[sk] = c
        applied.push(`stageMaxDwellMs.${sk}`)
      }
      continue
    }
    if (key in LIST_KEYS) {
      const { maxItems, maxItemLen } = LIST_KEYS[key]
      const list = src[key]
      if (!Array.isArray(list) || !list.length || list.length > maxItems
        || !list.every(v => typeof v === 'string' && v.length > 0 && v.length <= maxItemLen)) {
        rejected.push(key); continue
      }
      out[key] = [...list]
      applied.push(key)
      continue
    }
    if (!(key in SCALAR_BOUNDS)) { rejected.push(key); continue }
    const c = clampInt(src[key], SCALAR_BOUNDS[key])
    if (c === null) { rejected.push(key); continue }
    out[key] = c
    applied.push(key)
  }
  return { thresholds: out, applied, rejected }
}
