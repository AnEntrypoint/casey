

const BOLD = /(\*{2,3}|__)(?=\S)([^\n]*?\S)\1/g

const LIST_LINE = /^\s{0,6}(?:[-*\u2022\u2013]|\d{1,2}[.)])\s+(\S.*)$/
const ENDS_SENTENCE = /[.!?;:,\u2026]["')\]\u201d\u2019]*$/

export function replyShape(input) {
  const text = String(input ?? '')
  const questions = (text.match(/[?\uff1f\u061f](?=\s|$|["')\]\u201d\u2019])/g) || []).length
  const listLines = text.split('\n').filter(l => LIST_LINE.test(l)).length
  return { questions, listLines }
}

const Q_END = /[?\uff1f\u061f](?=\s|$|["')\]\u201d\u2019])/g
const SENTENCE_END = /[.!\u2026?\uff1f\u061f\n]/
export function singleAsk(input) {
  let text = String(input ?? '')
  const ends = [...text.matchAll(Q_END)].map(m => m.index)
  if (ends.length < 2) return text
  const cuts = ends.slice(0, -1).map(e => {
    let from = e
    while (from > 0 && !SENTENCE_END.test(text[from - 1])) from--
    let to = e + 1
    while (to < text.length && /["')\]\u201d\u2019]/.test(text[to])) to++
    return [from, to]
  })
  for (const [from, to] of cuts.reverse()) text = text.slice(0, from) + text.slice(to)
  return text.replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

const JARGON = /\b(cases?|tickets?|triag(?:e|ed|ing)|workflows?|status(?:es)?|priorit(?:y|ies)|escalat(?:e|es|ed|ing|ion)|transition(?:s|ed|ing)?|autonomy)\b/gi
export function jargonIn(input) {
  const s = String(input ?? '').replace(REF_TOKEN_ANY, ' ').replace(/\b(?:in|just in|in that|in which|in this|in any|in either) case\b/gi, ' ')
  return [...new Set((s.match(JARGON) || []).map(w => w.toLowerCase()))]
}
const REF_TOKEN_ANY = /CASE-\d+-[a-z0-9]+/gi

function flattenLists(lines) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (!LIST_LINE.test(lines[i])) { out.push(lines[i]); continue }
    const items = []
    while (i < lines.length) {
      const m = LIST_LINE.exec(lines[i])
      if (m) { items.push(m[1].trim()); i++; continue }

      if (!lines[i].trim() && i + 1 < lines.length && LIST_LINE.test(lines[i + 1])) { i++; continue }
      break
    }
    i--
    const joined = items.map((t, k) => ENDS_SENTENCE.test(t) ? t : (k === items.length - 1 ? `${t}.` : `${t},`)).join(' ')

    if (out.length > 1 && !out[out.length - 1].trim() && /:\s*$/.test(out[out.length - 2])) out.pop()
    if (out.length && out[out.length - 1].trim()) out[out.length - 1] = `${out[out.length - 1].replace(/\s+$/, '')} ${joined}`
    else out.push(joined)
  }
  return out
}

export function toPlainChat(input, { keepLists = false } = {}) {
  const text = String(input ?? '')
  if (!text) return text
  const lines = text.split('\n')
  const out = []
  let fenced = false
  for (let line of lines) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue }
    if (!fenced) {

      if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('|')) continue

      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue

      if (/^\s*\|.*\|\s*$/.test(line)) line = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()).filter(Boolean).join(' - ')

      line = line.replace(/^\s{0,3}#{1,6}\s+/, '')
    }
    out.push(line)
  }
  let s = (keepLists ? out.map(l => l.replace(/^\s{0,6}[*\u2022\u2013]\s+/, '- ')) : flattenLists(out)).join('\n')
  s = s.replace(BOLD, '*$2*')
  s = s.replace(/~~(?=\S)([^\n]*?\S)~~/g, '~$1~')
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)')
  s = s.replace(/`+/g, '')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s
}

export function normaliseReply(text, { keepLists = false } = {}) {
  const before = String(text ?? '')
  const after = toPlainChat(before, { keepLists }).trim()
  return { text: after, changed: after !== before.trim() }
}

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
