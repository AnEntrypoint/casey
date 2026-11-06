

export function normalizeLocation(raw) {
  if (raw == null) return ''
  return String(raw)
    .toLowerCase()
    .trim()
    .replace(/[.,;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .trim()
}
