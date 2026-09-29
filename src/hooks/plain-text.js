// hooks/plain-text.js -- the last character-level pass over a reply before it leaves.
//
// WhatsApp renders its own light markup (*bold*, _italic_, ~strike~) and shows
// everything else literally: a model's **bold**, `# headings`, pipe tables,
// backticks and [text](url) links arrive as stray punctuation. This rewrites those
// to what a phone shows well. It is character-level normalisation of syntax
// markers only: it reads no words, guesses no language and classifies nothing about
// what the reply means. Plain sentences pass through byte for byte.

const BOLD = /(\*{2,3}|__)(?=\S)([^\n]*?\S)\1/g

export function toPlainChat(input) {
  const text = String(input ?? '')
  if (!text) return text
  const lines = text.split('\n')
  const out = []
  let fenced = false
  for (let line of lines) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue }
    if (!fenced) {
      // A table separator row (|---|:--:|) carries no content.
      if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('|')) continue
      // A horizontal rule.
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue
      // A table row: cells joined with " - ".
      if (/^\s*\|.*\|\s*$/.test(line)) line = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()).filter(Boolean).join(' - ')
      // Heading markers.
      line = line.replace(/^\s{0,3}#{1,6}\s+/, '')
    }
    out.push(line)
  }
  let s = out.join('\n')
  s = s.replace(BOLD, '*$2*')
  s = s.replace(/~~(?=\S)([^\n]*?\S)~~/g, '~$1~')
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)')
  s = s.replace(/`+/g, '')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s
}

// The normalised reply and whether anything changed (for the audit line).
export function normaliseReply(text) {
  const before = String(text ?? '')
  const after = toPlainChat(before).trim()
  return { text: after, changed: after !== before.trim() }
}
