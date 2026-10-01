
const ca = (r) => (r?.created_at || 0)
function sortByCreatedStable(rows, dir) {
  return rows
    .map((row, idx) => ({ row, idx }))
    .sort((a, b) => dir * (ca(a.row) - ca(b.row)) || (a.idx - b.idx))
    .map(x => x.row)
}
export function byCreatedAscList(rows) { return sortByCreatedStable(rows, 1) }
export function byCreatedDescList(rows) { return sortByCreatedStable(rows, -1) }
