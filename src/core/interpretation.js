// core/interpretation.js -- TIER 4: the ONLY place a model-estimated /
// interpolated value may be rendered, ALWAYS on a surface visibly and
// structurally separate from the ground-truth view (core/aggregate.js).
//
// This module never writes into the raw log or the ground-truth aggregate
// tier -- it only reads observations and produces a clearly-labeled overlay
// object a caller can choose to render as a distinct layer (e.g. a
// "modeled estimate" map overlay toggle, off by default). Nothing here
// mutates or is joined silently into a ground-truth query -- there is no
// function in this module that returns something aggregate.js's shape could
// be mistaken for.

import { isUnknown } from './provenance.js'

// An estimate is ALWAYS explicitly tagged and MUST carry a method + input
// count, so a viewer never mistakes a modeled surface for a raw count.
export function mkEstimate({ kind, value, method, basedOnCount, confidence = null }) {
  if (!kind || !method) throw new Error('interpretation: mkEstimate requires kind and method')
  if (basedOnCount == null) throw new Error('interpretation: mkEstimate requires basedOnCount (how many raw observations this was derived from)')
  return Object.freeze({
    __interpretation: true,
    __estimate: true,
    kind,
    value,
    method,
    basedOnCount,
    confidence,
    label: `ESTIMATED (${method}) -- not a ground-truth count`,
  })
}

export function isEstimate(v) {
  return !!v && typeof v === 'object' && v.__interpretation === true && v.__estimate === true
}

// A trivial, honestly-labeled example estimator: naive linear trend over a
// field's known (non-unknown) numeric values, useful ONLY as an overlay
// hint, never substituted into a ground-truth count. Returns null (not a
// fabricated number) when there is nothing to extrapolate from.
export function estimateTrend(observations, fieldKey) {
  const points = observations
    .map(o => o.findings?.[fieldKey])
    .filter(v => v && !isUnknown(v) && typeof v.value === 'number')
    .map(v => v.value)
  if (points.length < 2) return null
  const avg = points.reduce((a, b) => a + b, 0) / points.length
  return mkEstimate({ kind: `trend:${fieldKey}`, value: avg, method: 'naive-average', basedOnCount: points.length })
}
