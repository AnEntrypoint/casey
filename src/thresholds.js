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
}
// Per-stage dwell ceilings (the nested stageMaxDwellMs map). Only these stages
// are tunable; an unknown stage key is dropped.
const STAGE_KEYS = ['new', 'triaging', 'in_progress', 'waiting']
const STAGE_BOUNDS = [HOUR, 60 * DAY]

export const SCALAR_KEYS = Object.keys(SCALAR_BOUNDS)
export const THRESHOLD_KEYS = [...SCALAR_KEYS, 'stageMaxDwellMs']

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
  }
  const applied = []
  const rejected = []
  const src = patch && typeof patch === 'object' ? patch : {}
  for (const key of Object.keys(src)) {
    if (key === 'stageMaxDwellMs') {
      const stages = src.stageMaxDwellMs
      if (!stages || typeof stages !== 'object') { rejected.push(key); continue }
      let any = false
      for (const sk of Object.keys(stages)) {
        if (!STAGE_KEYS.includes(sk)) { rejected.push(`stageMaxDwellMs.${sk}`); continue }
        const c = clampInt(stages[sk], STAGE_BOUNDS)
        if (c === null) { rejected.push(`stageMaxDwellMs.${sk}`); continue }
        out.stageMaxDwellMs[sk] = c
        applied.push(`stageMaxDwellMs.${sk}`)
        any = true
      }
      if (!any && !applied.includes('stageMaxDwellMs')) { /* nothing applied for the map */ }
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
