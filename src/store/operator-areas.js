
export const OPERATOR_AREA_CAP = 40

export function parseJsonArray(raw) {
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : [] }
  catch { return [] }
}

export function foldAreas(areas, locationTokens, cap = OPERATOR_AREA_CAP) {
  for (const t of locationTokens) {
    const i = areas.findIndex(a => a.token === t)
    if (i >= 0) areas[i].count = (areas[i].count || 0) + 1
    else areas.push({ token: t, count: 1 })
  }
  areas.sort((a, b) => (b.count || 0) - (a.count || 0))
  return areas.slice(0, cap)
}
