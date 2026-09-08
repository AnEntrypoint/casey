// privacy.js -- the one small-cell suppression floor every aggregate in the app
// shares.
//
// Why this file exists at all, given it holds two constants: the floor is a
// PRIVACY control, and it was previously declared twice -- once in
// report-analytics.js for its channel/case_type rollups and once in geo.js for
// its place rollups -- each reading the same env var with its own copy of the
// `|| 5` default. geo.js's own comment stated the intent exactly ("Shares the
// identical env var so one knob tunes every aggregate-suppression floor in the
// app"), but two independent declarations only HAPPEN to agree: raising the
// default in one place would have silently left the other at 5, and the half
// that stayed lower is the half that leaks. This is the same move casey already
// made for tsMs (timestamp.js) after that was reimplemented three times -- a
// shared derivation gets one home, and this one guards re-identification rather
// than formatting.
//
// The threat, stated once here rather than half-stated in two places: on a small
// rural deployment a bucket of size 1 is effectively "this one specific case",
// re-identifiable by anyone who knows roughly when and what was reported, even
// with external_id already stripped. A place name is the sharpest version of
// this -- naming a rare place identifies which case is there -- which is why the
// floor applies to place rollups as well as to the coarser channel/case_type
// enums. The floor matches CDC's published review standard for public
// case-surveillance aggregates, and is tunable upward since a larger deployment
// may reasonably want a higher one.

// Below this count, a NAMED bucket is folded away rather than rendered by name.
export const MIN_AGGREGATE_CELL = Number(process.env.CASEY_MIN_AGGREGATE_CELL) || 5

// The single bucket every under-floor row is folded into. One spelling, so a
// consumer rendering aggregates from two different modules cannot end up with
// two differently-named "everything too small to name" rows in one table.
export const SPARSE_BUCKET_KEY = 'other/sparse'

// An 'unknown' bucket is exempt from suppression: it names nothing specific to
// fold away, so suppressing it would hide volume while protecting nobody. This
// is a rule about the DATA, not about any one rollup, so it lives beside the
// floor rather than being re-decided per module.
export const UNSUPPRESSED_BUCKET_KEYS = new Set(['unknown'])
