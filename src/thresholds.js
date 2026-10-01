

import { DEFAULT_THRESHOLDS } from './case-health.js'

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

const STAGE_BOUNDS = [HOUR, 60 * DAY]
const MAX_STAGE_KEY_LEN = 64

const LIST_KEYS = { visitCritical: { maxItems: 32, maxItemLen: 64 } }

const MAX_CASE_TYPE_KEY_LEN = 40

const SCALAR_KEYS = Object.keys(SCALAR_BOUNDS)
export const THRESHOLD_KEYS = [...SCALAR_KEYS, 'stageMaxDwellMs', 'byCaseType', ...Object.keys(LIST_KEYS)]

function clampInt(v, [min, max]) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  const i = Math.round(n)
  return Math.min(Math.max(i, min), max)
}

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
