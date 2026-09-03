// core/quality-flags.js -- explicit data-quality flags on an Observation,
// derived (never hidden in ad hoc conditionals scattered across dashboard
// code) so "why is this row flagged" is always answerable from one place.

import { isUnknown } from './provenance.js'

const STALE_MS_DEFAULT = 1000 * 60 * 60 * 24 * 3   // 3 days, tunable per call

// Pure function: given an Observation and the current raw log for its
// subject, compute the explicit quality flags. Never mutates the
// observation -- flags are always computed fresh (tier 3, like every other
// aggregate), never stored as a hidden mutable field on the record itself.
export function computeQualityFlags(observation, { nowMs, siblingObservations = [], staleMs = STALE_MS_DEFAULT } = {}) {
  const flags = []

  if (!observation.location || isUnknown(observation.location)) {
    flags.push({ flag: 'missing_gps', detail: 'no location value recorded, or explicitly unknown' })
  }

  if (nowMs != null && observation.syncedAt) {
    const age = nowMs - Date.parse(observation.syncedAt)
    if (age > staleMs) flags.push({ flag: 'stale', detail: `synced ${Math.round(age / (1000 * 60 * 60))}h ago, exceeds ${Math.round(staleMs / (1000 * 60 * 60))}h freshness window` })
  }

  if (observation.verificationTier === 'unverified') {
    flags.push({ flag: 'unverified', detail: 'no field-worker or lab confirmation on record' })
  }

  // Conflicting: a sibling observation on the same subject disagrees on the
  // SAME field at a similar/higher provenance rank -- surfaced for human
  // review, never auto-resolved.
  for (const sibling of siblingObservations) {
    if (sibling.id === observation.id) continue
    for (const [field, val] of Object.entries(observation.findings || {})) {
      const other = sibling.findings?.[field]
      if (!other || isUnknown(val) || isUnknown(other)) continue
      if (String(other.value) !== String(val.value)) {
        flags.push({ flag: 'conflicting', detail: `field "${field}" disagrees with observation ${sibling.id} ("${val.value}" vs "${other.value}")`, conflictsWith: sibling.id })
      }
    }
  }

  return flags
}
