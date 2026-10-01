

export function tsMs(raw) {
  if (raw == null || raw === '') return NaN
  const n = typeof raw === 'number' ? raw : (/^\d+$/.test(String(raw)) ? Number(raw) : NaN)
  if (!Number.isNaN(n)) return n < 1e12 ? n * 1000 : n
  const t = Date.parse(raw)
  return Number.isNaN(t) ? NaN : t
}

export function tagList(c) {
  return String(c?.tags || '').split(',').map(s => s.trim()).filter(Boolean)
}

export function parseReport(c) {
  try { return c && c.report ? JSON.parse(c.report) : {} } catch { return {} }
}

export function parseReportTolerant(c) {
  if (c && typeof c.report === 'object' && c.report) return c.report
  try { return c && c.report ? JSON.parse(c.report) : {} } catch { return {} }
}
