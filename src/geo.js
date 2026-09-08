// geo.js -- "Hotspots by area". correlate.js already tokenizes and weights the
// location field for pairwise grouping; this re-aggregates that same stored
// location BY place so the team sees where reports concentrate, ranked. Pure, no
// I/O: the store hands in the open case rows, this returns per-place rollups.
//
// A case can name more than one place token ("near Musina, Limpopo"); it counts
// toward each meaningful token it carries, so a hotspot surfaces whether the team
// wrote the town or the district. No new data is created -- only stored location
// is re-grouped.

import { tokens } from './correlate.js'
// parseReport (tolerant-of-already-parsed variant) moved to timestamp.js --
// was independently duplicated here/clusters.js/correlate.js.
import { parseReportTolerant as parseReport } from './timestamp.js'

// The k-anonymity floor is shared with report-analytics.js's rollups and now
// lives in one place (privacy.js) rather than being declared here and there
// with two copies of the same default -- "one knob tunes every
// aggregate-suppression floor" is what this comment already claimed, and the
// import is what makes it true. A named place below the floor is the sharpest
// de-anonymization vector of the three rollups, since a rare place name
// identifies which case is there far more directly than a channel or
// case_type enum does.
import { MIN_AGGREGATE_CELL, SPARSE_BUCKET_KEY as SPARSE_PLACE_KEY, UNSUPPRESSED_BUCKET_KEYS } from './privacy.js'

// Group open cases by location token. Returns places ranked by case count, each
// with the count, the species mix (token -> count), and the most-recent report
// time (unix-seconds, SAST-rendered by the caller). Cases with no location token
// fall into a single 'unknown' bucket so they are never silently dropped.
// Places below MIN_AGGREGATE_CELL are folded into a single 'other/sparse' row
// rather than each rendered by name -- a hotspot list revealing there WERE a
// couple of rare-place reports is fine; revealing exactly WHICH rare place is
// the leak. 'unknown' (no location token at all) is exempt from suppression:
// it names nothing specific to fold away.
export function buildGeo(cases) {
  const places = new Map()
  const bump = (place, c, rep) => {
    let g = places.get(place)
    if (!g) { g = { place, count: 0, species: {}, latest: null }; places.set(place, g) }
    g.count++
    for (const sp of tokens(rep.species)) g.species[sp] = (g.species[sp] || 0) + 1
    const t = Number(c.created_at)
    if (Number.isFinite(t) && (g.latest == null || t > g.latest)) g.latest = t
  }
  for (const c of cases || []) {
    if (!c) continue
    const rep = parseReport(c)
    const locTokens = [...tokens(rep.location)]
    if (locTokens.length) for (const p of locTokens) bump(p, c, rep)
    else bump('unknown', c, rep)
  }
  const merged = new Map()
  let sparse = null
  for (const g of places.values()) {
    if (!UNSUPPRESSED_BUCKET_KEYS.has(g.place) && g.count < MIN_AGGREGATE_CELL) {
      if (!sparse) sparse = { place: SPARSE_PLACE_KEY, count: 0, species: {}, latest: null }
      sparse.count += g.count
      for (const [sp, n] of Object.entries(g.species)) sparse.species[sp] = (sparse.species[sp] || 0) + n
      if (g.latest != null && (sparse.latest == null || g.latest > sparse.latest)) sparse.latest = g.latest
      continue
    }
    merged.set(g.place, g)
  }
  if (sparse) merged.set(SPARSE_PLACE_KEY, sparse)
  return [...merged.values()].sort((a, b) => b.count - a.count || (b.latest || 0) - (a.latest || 0))
}
