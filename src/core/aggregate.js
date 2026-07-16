// core/aggregate.js -- TIER 3: aggregates as PURE functions of the raw log
// (tier 1). No aggregate here is ever hand-edited or independently stored as
// a source of truth -- every function in this module takes a RawLog (or its
// .all() snapshot) and DERIVES its answer fresh. Dropping every aggregate
// and recomputing from raw must always be a no-op on the answer -- that is
// the test this module is built to pass (item 30).
//
// Interpretation/estimation (TIER 4) never lives in this module. If a value
// here were to blend in a model estimate, it would contaminate the
// ground-truth tier -- see core/interpretation.js for where estimates are
// allowed to live, always on a separately labeled surface.

import { isUnknown } from './provenance.js'

// Every aggregate that reports a rate/count must also report its coverage
// denominator (item 41/57): how many EXPECTED reporters/subjects this
// number is really drawn from, distinct from how many actually reported.
// `expectedTotal` is caller-supplied (the roster), not fabricated here --
// when the caller genuinely does not know it, they must pass null, which
// this module renders as an explicit "denominator unknown" rather than
// treating the observed count as if it were the whole population.
export function withCoverage(observedCount, expectedTotal) {
  return {
    observedCount,
    expectedTotal: expectedTotal ?? null,
    coverageKnown: expectedTotal != null,
    coverageRatio: expectedTotal != null && expectedTotal > 0 ? observedCount / expectedTotal : null,
  }
}

// Count observations per findings[fieldKey].value, distinguishing an
// explicit "unknown" answer from a real value -- so "12 goats reported
// sick" and "4 reports where species was unknown" are two different, both
// honestly-labeled, bars, never blended into one bucket.
export function countByFinding(observations, fieldKey) {
  const buckets = new Map()
  let unknownCount = 0
  for (const obs of observations) {
    const v = obs.findings?.[fieldKey]
    if (!v) continue
    if (isUnknown(v)) { unknownCount++; continue }
    const key = String(v.value)
    buckets.set(key, (buckets.get(key) || 0) + 1)
  }
  return { buckets: Object.fromEntries(buckets), unknownCount, totalConsidered: observations.length }
}

// Drilldown: given a bucket key, return the exact source observations that
// produced it (aggregation-drillable). An empty bucket returns an explicit
// empty array, distinguishable from a thrown error (expansion-aggregation-
// drilldown-empty-case): the caller can render "0 observations" honestly
// rather than a query failure.
export function drilldown(observations, fieldKey, bucketKey) {
  if (bucketKey === '__unknown__') {
    return observations.filter(o => isUnknown(o.findings?.[fieldKey]))
  }
  return observations.filter(o => {
    const v = o.findings?.[fieldKey]
    return v && !isUnknown(v) && String(v.value) === String(bucketKey)
  })
}

// Recency: how long ago the most recent observation for a subject/scope
// synced, so a dashboard can show "last synced X ago" rather than implying
// the aggregate is complete/live (sync-recency-display).
export function recency(observations, nowMs) {
  if (!observations.length) return { mostRecentSyncedAt: null, ageMs: null }
  const times = observations.map(o => (o.syncedAt ? Date.parse(o.syncedAt) : null)).filter(t => t != null && !Number.isNaN(t))
  if (!times.length) return { mostRecentSyncedAt: null, ageMs: null }
  const mostRecent = Math.max(...times)
  return { mostRecentSyncedAt: new Date(mostRecent).toISOString(), ageMs: nowMs - mostRecent }
}

// Sparse-marking for a map/time bucket: an area/period with zero
// observations is explicitly "sparse" (no reports received), never rendered
// identically to an area with observations that all say "no cases" -- the
// caller must supply expectedReporters (roster size for that area) to make
// this distinction; when it cannot, sparse is reported with
// coverageKnown:false rather than guessed.
export function sparseMark(observedCount, expectedReporters) {
  const cov = withCoverage(observedCount, expectedReporters)
  return {
    ...cov,
    sparse: cov.coverageKnown ? cov.coverageRatio < 0.1 : null,   // null = cannot determine, never assume not-sparse
  }
}

// The rebuild-from-scratch proof: recomputing an aggregate twice from the
// same raw snapshot must be byte-identical -- if it is not, something in the
// aggregate function has hidden non-determinism (a Date.now(), a random
// tie-break) that would make "delete and rebuild" unsafe.
export function assertPureRebuild(observations, fieldKey) {
  const a = JSON.stringify(countByFinding(observations, fieldKey))
  const b = JSON.stringify(countByFinding(observations, fieldKey))
  if (a !== b) throw new Error('aggregate.assertPureRebuild: countByFinding is non-deterministic -- this violates the pure-aggregate invariant')
  return true
}
