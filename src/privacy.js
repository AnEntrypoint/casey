// privacy.js -- the one small-cell suppression floor every aggregate in the app
// shares.
//
// Declared ONCE, here. A second declaration of this floor diverges silently:
// two copies only HAPPEN to agree, raising the default in one leaves the other
// lower, and the lower copy is the leak.
//
// The threat: on a small rural deployment a bucket of size 1 is effectively
// "this one specific case", re-identifiable by anyone who knows roughly when and
// what was reported, even with external_id already stripped. A place name is the
// sharpest version of this -- naming a rare place identifies which case is there
// -- which is why the floor applies to place rollups as well as to the coarser
// channel/case_type enums. The floor matches CDC's published review standard for
// public case-surveillance aggregates, and is tunable upward since a larger
// deployment may reasonably want a higher one.

// Below this count, a NAMED bucket is folded away rather than rendered by name.
export const MIN_AGGREGATE_CELL = Number(process.env.CASEY_MIN_AGGREGATE_CELL) || 5

// The single bucket every under-floor row is folded into. One spelling, so a
// consumer rendering aggregates from two different modules cannot end up with
// two differently-named "everything too small to name" rows in one table.
export const SPARSE_BUCKET_KEY = 'other/sparse'

// An 'unknown' bucket is exempt from suppression: it names nothing specific to
// fold away, so suppressing it would hide volume while protecting nobody. This
// is a rule about the DATA, not about any one rollup, so it lives beside the
// floor and is not re-decided per module.
export const UNSUPPRESSED_BUCKET_KEYS = new Set(['unknown'])
