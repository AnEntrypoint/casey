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

function parseReport(c) {
  if (c && typeof c.report === 'object' && c.report) return c.report
  try { return c && c.report ? JSON.parse(c.report) : {} } catch { return {} }
}

// Group open cases by location token. Returns places ranked by case count, each
// with the count, the species mix (token -> count), and the most-recent report
// time (unix-seconds, SAST-rendered by the caller). Cases with no location token
// fall into a single 'unknown' bucket so they are never silently dropped.
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
  return [...places.values()].sort((a, b) => b.count - a.count || (b.latest || 0) - (a.latest || 0))
}
