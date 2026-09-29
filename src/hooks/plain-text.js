// hooks/plain-text.js -- the last character-level pass over a reply before it leaves.
//
// WhatsApp renders its own light markup (*bold*, _italic_, ~strike~) and shows
// everything else literally: a model's **bold**, `# headings`, pipe tables,
// backticks and [text](url) links arrive as stray punctuation. This rewrites those
// to what a phone shows well. It is character-level normalisation of syntax
// markers only: it reads no words, guesses no language and classifies nothing about
// what the reply means. Plain sentences pass through byte for byte.
//
// Lists are handled at the same level. A line that opens with a list marker
// ('- ', '* ', a bullet, '1. ', '1) ') carries the marker and nothing else that
// this file reads; a run of such lines is folded into the sentence before it, the
// items separated by their own punctuation (or a comma when they have none). The
// same marker test feeds replyShape(), the structural count the reply judge is
// handed alongside its own reading of the reply.

const BOLD = /(\*{2,3}|__)(?=\S)([^\n]*?\S)\1/g
// A list marker at the start of a line: - * a bullet, or a one or two digit number
// with a dot or bracket, then whitespace and the item. '*bold*' and '12 goats' do not match.
const LIST_LINE = /^\s{0,6}(?:[-*\u2022\u2013]|\d{1,2}[.)])\s+(\S.*)$/
const ENDS_SENTENCE = /[.!?;:,\u2026]["')\]\u201d\u2019]*$/

// The number of question marks that end a sentence (a '?' inside a URL query is not
// one) and of list lines. Pure counts, no words are read.
export function replyShape(input) {
  const text = String(input ?? '')
  const questions = (text.match(/[?\uff1f\u061f](?=\s|$|["')\]\u201d\u2019])/g) || []).length
  const listLines = text.split('\n').filter(l => LIST_LINE.test(l)).length
  return { questions, listLines }
}

// Fold runs of list lines into the line before them.
function flattenLists(lines) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (!LIST_LINE.test(lines[i])) { out.push(lines[i]); continue }
    const items = []
    while (i < lines.length) {
      const m = LIST_LINE.exec(lines[i])
      if (m) { items.push(m[1].trim()); i++; continue }
      // One blank line between items still belongs to the same list.
      if (!lines[i].trim() && i + 1 < lines.length && LIST_LINE.test(lines[i + 1])) { i++; continue }
      break
    }
    i--
    const joined = items.map((t, k) => ENDS_SENTENCE.test(t) ? t : (k === items.length - 1 ? `${t}.` : `${t},`)).join(' ')
    // A lead-in that ends in a colon takes the list even across the blank line the model left.
    if (out.length > 1 && !out[out.length - 1].trim() && /:\s*$/.test(out[out.length - 2])) out.pop()
    if (out.length && out[out.length - 1].trim()) out[out.length - 1] = `${out[out.length - 1].replace(/\s+$/, '')} ${joined}`
    else out.push(joined)
  }
  return out
}

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
  let s = flattenLists(out).join('\n')
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

// Phone-number-like digit runs (three or more digits once separators are removed) and
// web addresses in a reply that appear in none of the texts the reply may legitimately
// draw them from. A helpline is the case that matters: the deployment writes the lines
// it stands behind, and a model that adds a number or a site of its own from memory has
// sent a stranger to a line nobody here has checked. It compares digits and address
// syntax with digits and address syntax; it reads no words and knows no language.
const REF_TOKEN = /CASE-\d+-[a-z0-9]+/gi
const DIGIT_RUN = /\+?\d(?:[ \-]?\d)+/g
const WEB_ADDRESS = /\b(?:https?:\/\/|www\.)[^\s)]+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:org|com|net|info|gov|co\.za|org\.za|gov\.za)\b[^\s)]*/gi
const digitsOf = (t) => t.replace(/\D/g, '')
const contactTokens = (text) => {
  const s = String(text ?? '').replace(REF_TOKEN, ' ')
  const nums = (s.match(DIGIT_RUN) || []).map(t => ({ shown: t.trim(), key: digitsOf(t) })).filter(x => x.key.length >= 3)
  const webs = (s.match(WEB_ADDRESS) || []).map(t => ({ shown: t.replace(/[.,;:!?]+$/, ''), key: t.replace(/[.,;:!?]+$/, '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '') }))
  return [...nums, ...webs]
}
export function strayContactDetails(reply, allowedTexts = []) {
  const allowed = new Set(allowedTexts.flatMap(t => contactTokens(t).map(x => x.key)))
  const seen = new Set()
  const stray = []
  for (const tok of contactTokens(reply)) {
    if (allowed.has(tok.key) || seen.has(tok.key)) continue
    seen.add(tok.key)
    stray.push(tok.shown)
  }
  return stray
}
