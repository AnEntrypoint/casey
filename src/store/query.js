// store/query.js  --  pure sort/paging helpers over event rows. Extracted from
// case-store.js (structural split only; logic is byte-identical to the
// original inline definitions).

// Event ordering: created_at is a unix-SECONDS integer (coarse -- a whole turn's
// events routinely share one second), and thatcher's id is a time-prefixed string
// with a RANDOM suffix, so the id is NOT a reliable insertion-order tiebreaker:
// within one second, two events sort by their random suffixes, scrambling order.
// What IS reliable is thatcher's raw list order, which preserves insertion order
// (witnessed). So we sort by created_at with a STABLE sort that breaks ties by the
// row's original index in the input -- insertion order is preserved exactly on a
// tie, and positional logic (resume completed-after, timeline replay) is
// deterministic. ordered(rows, dir) is the only sort entry point; it never tie-
// breaks on the id. (A prior version tie-broke on id assuming monotonic integer
// ids -- false for thatcher's random-suffix ids -- and made the resume sweep flaky.)
const ca = (r) => (r?.created_at || 0)
function sortByCreatedStable(rows, dir) {
  // Decorate with the input index, sort by (created_at, index), undecorate. The
  // index tiebreak keeps same-second events in arrival order regardless of the
  // engine's sort stability or the id's unsortable suffix.
  return rows
    .map((row, idx) => ({ row, idx }))
    .sort((a, b) => dir * (ca(a.row) - ca(b.row)) || (a.idx - b.idx))
    .map(x => x.row)
}
export function byCreatedAscList(rows) { return sortByCreatedStable(rows, 1) }
export function byCreatedDescList(rows) { return sortByCreatedStable(rows, -1) }
