const MAX_TEXT = 900

export function waLink(digits, text) {
  const d = String(digits == null ? '' : digits)
  if (!/^\d{9,15}$/.test(d)) return null
  const clean = String(text == null ? '' : text).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
  return `https://wa.me/${d}${clean ? `?text=${encodeURIComponent(clean)}` : ''}`
}
