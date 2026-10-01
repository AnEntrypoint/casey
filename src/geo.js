

import { tokens, nameTokens } from './correlate.js'

import { parseReportTolerant as parseReport } from './timestamp.js'

import { MIN_AGGREGATE_CELL, SPARSE_BUCKET_KEY as SPARSE_PLACE_KEY, UNSUPPRESSED_BUCKET_KEYS } from './privacy.js'

export function buildGeo(cases) {
  const places = new Map()
  const bump = (place, c, rep) => {
    let g = places.get(place)
    if (!g) { g = { place, count: 0, species: {}, latest: null }; places.set(place, g) }
    g.count++
    for (const sp of nameTokens(rep.species)) g.species[sp] = (g.species[sp] || 0) + 1
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
