// store/query.js  --  pure sort/paging helpers over event rows, used by
// case-store.js's listEvents/listEventsPage.

// Event ordering: created_at is a unix-SECONDS value, coarse (a whole turn's
// events routinely share one second) and read back off a busybase row as a
// digit STRING, so it is only ever compared by numeric subtraction here.
// thatcher's id is a time-prefixed string with a RANDOM suffix, so the id is NOT
// a reliable insertion-order tiebreaker: within one second, two events sort by
// their random suffixes, scrambling order, and the resume sweep goes flaky.
// What IS reliable is thatcher's raw list order, which preserves insertion order
// (witnessed). So we sort by created_at with a STABLE sort that breaks ties by the
// row's original index in the input -- insertion order is preserved exactly on a
// tie, and positional logic (resume completed-after, timeline replay) is
// deterministic. byCreatedAscList/byCreatedDescList are the only sort entry
// points; neither may tie-break on the id.
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
