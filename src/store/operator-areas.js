// store/operator-areas.js  --  the working-area profile casey learns per
// operator. Pure: the read-modify-write around it (the per-operator lock, the
// expectedVersion guard, the toStorable coercion) stays in case-store.js's
// learnOperatorActivity, because all three need the live store; the fold itself
// is an array in, an array out.

// Cap on the area list so a long-lived operator's record does not grow
// unbounded -- foldAreas keeps the most-frequent areas, a bounded working-area
// profile rather than a full history.
export const OPERATOR_AREA_CAP = 40

// operator_identity.areas is stored as a JSON array string. A corrupt or
// non-array value resolves to an empty list rather than throwing: this whole
// subsystem is best-effort learning layered on the real roster, so a bad row
// must degrade to "nothing learned yet", never break the dashboard action it
// rides on.
export function parseJsonArray(raw) {
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : [] }
  catch { return [] }
}

// Fold this case's location tokens into the operator's running area counts and
// return the bounded, most-frequent-first list. `areas` is mutated in place (it
// is always the freshly-parsed array from the row read inside the retry loop,
// never shared state) and the bounded slice is returned.
export function foldAreas(areas, locationTokens, cap = OPERATOR_AREA_CAP) {
  for (const t of locationTokens) {
    const i = areas.findIndex(a => a.token === t)
    if (i >= 0) areas[i].count = (areas[i].count || 0) + 1
    else areas.push({ token: t, count: 1 })
  }
  areas.sort((a, b) => (b.count || 0) - (a.count || 0))
  return areas.slice(0, cap)
}
