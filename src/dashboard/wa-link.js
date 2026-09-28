// dashboard/wa-link.js -- the ONE builder for a click-to-chat WhatsApp link.
// Built from already-normalised digits and percent-encoded text, so nothing a
// contact typed can reach an href unescaped: the number must be 9-15 digits or
// there is no link, and the text is stripped of control characters, capped, and
// passed through encodeURIComponent.
const MAX_TEXT = 900

export function waLink(digits, text) {
  const d = String(digits == null ? '' : digits)
  if (!/^\d{9,15}$/.test(d)) return null
  const clean = String(text == null ? '' : text).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
  return `https://wa.me/${d}${clean ? `?text=${encodeURIComponent(clean)}` : ''}`
}
