

export function parseJsonArraySafe(raw) {
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : [] }
  catch { return [] }
}

export function evData(e) {
  const d = e?.data
  if (d == null) return {}
  if (typeof d === 'object') return d
  if (typeof d === 'string') { try { return JSON.parse(d) || {} } catch { return {} } }
  return {}
}

export function rowInt(v, fallback = 0) {
  if (v == null || v === '') return fallback
  const n = Number(v)
  return Number.isSafeInteger(n) ? n : fallback
}

export function parseEventData(events) {
  return (events || []).map(e => ({ ...e, data: evData(e) }))
}

