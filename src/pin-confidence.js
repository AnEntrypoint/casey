

export function pinConfidence(source, given) {
  if (source === 'gps') return 100
  const n = Math.round(Number(given))
  const have = Number.isFinite(n)
  if (source === 'confirmed') return have ? Math.min(100, Math.max(80, n)) : 90
  return have ? Math.min(99, Math.max(1, n)) : 30
}

