

import { parseReportTolerant as parseReport } from './timestamp.js'

import { normalizeLocation as surfaceKey } from './location-normalize.js'
import { ENQUIRY_HEADLINE_FIELDS, APPEND_FIELDS, REPORT_FIELD_DEFS, fieldLabel } from './store/report-shape.js'

export const KNOWN_VALUE_FIELDS = ENQUIRY_HEADLINE_FIELDS
  .filter(k => REPORT_FIELD_DEFS.some(f => f.key === k))
  .filter(k => !APPEND_FIELDS.has(k))

export function isKnownValueField(field) { return KNOWN_VALUE_FIELDS.includes(field) }

const MAX_VALUES = 60
const MAX_VALUES_FOR_MODEL = 40

export function knownValues(cases, field) {
  const byKey = new Map()
  for (const c of (cases || [])) {
    if (!c) continue
    const raw = parseReport(c)[field]
    if (raw == null) continue
    const value = String(raw).trim()
    if (!value) continue
    const key = surfaceKey(value)
    if (!key) continue
    const slot = byKey.get(key) || { count: 0, forms: new Map() }
    slot.count++
    slot.forms.set(value, (slot.forms.get(value) || 0) + 1)
    byKey.set(key, slot)
  }
  const out = []
  for (const [, slot] of byKey) {
    const display = [...slot.forms.entries()].sort((a, b) => b[1] - a[1])[0][0]
    out.push({ value: display, count: slot.count })
  }
  return out
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_VALUES)
}

const TTL_MS = 30_000
const memo = new Map()

export function invalidateKnownValues(field = null) {
  if (field == null) memo.clear()
  else memo.delete(field)
}

export async function readKnownValues(store, field, { now = Date.now() } = {}) {
  const hit = memo.get(field)
  if (hit && now - hit.at < TTL_MS) return hit.values

  const cases = await store.listCases({}, { limit: 10000 })
  const values = knownValues(cases, field)
  memo.set(field, { at: now, values })
  return values
}

export function matchKnownValue(value, known) {
  const v = String(value == null ? '' : value).trim()
  if (!v) return null
  const list = (known || []).map(k => (typeof k === 'string' ? k : k.value)).filter(Boolean)
  const exact = list.find(k => k === v)
  if (exact) return { value: exact, how: 'exact' }
  const key = surfaceKey(v)
  if (!key) return null
  const norm = list.find(k => surfaceKey(k) === key)
  if (norm) return { value: norm, how: 'normalized' }
  return null
}

export function canonPrompt(field, value, known) {
  const label = fieldLabel(field)
  const list = (known || []).slice(0, MAX_VALUES_FOR_MODEL)
    .map(k => '- ' + (typeof k === 'string' ? k : k.value))
    .join('\n')
  return [
    `An operator is filling in the "${label}" field (${field}) of an animal-health report by hand.`,
    '',
    'These values are already on record for that field in this deployment:',
    list,
    '',
    `They have just typed: ${JSON.stringify(String(value))}`,
    '',
    'Is what they typed the SAME real-world thing as one of the values already on record, only written differently -- a different capitalisation, a spelling mistake, singular instead of plural, a synonym, or the same place or animal named in another language?',
    'A different animal, a different place, a narrower or wider thing, or anything you are not sure about is NOT the same thing. When in doubt answer NEW.',
    '',
    'Answer with ONE line and nothing else:',
    'SAME: <copy the matching value from the list exactly>',
    'or',
    'NEW',
  ].join('\n')
}

export function parseCanonReply(text, known) {
  const first = String(text || '').split('\n').map(s => s.trim()).filter(Boolean)[0] || ''
  const m = first.match(/^SAME\s*[::]\s*(.+)$/i)
  if (!m) return null
  const named = m[1].trim().replace(/^["']|["']$/g, '')
  return matchKnownValue(named, known)
}

const CANON_TIMEOUT_MS = Number(process.env.CASEY_CANON_TIMEOUT_MS) || 5000

const CANON_MODEL = process.env.CASEY_CANON_MODEL || null

export async function canonicalizeFieldValue({ field, value, known, callLLM, timeoutMs = CANON_TIMEOUT_MS }) {
  const input = String(value == null ? '' : value).trim()
  const base = { input, canonical: input, matched: false, how: 'new', reason: null }
  if (!input) return { ...base, reason: 'empty' }

  const local = matchKnownValue(input, known)
  if (local) return { input, canonical: local.value, matched: true, how: local.how, reason: null }
  if (!(known || []).length) return { ...base, reason: 'no_known_values' }
  if (typeof callLLM !== 'function') return { ...base, reason: 'llm_unwired' }

  let reply
  try {
    reply = await Promise.race([

      callLLM({
        ...(CANON_MODEL ? { model: CANON_MODEL } : {}),
        messages: [{ role: 'user', content: canonPrompt(field, input, known) }],
        max_tokens: 64,
      }, { recordHealth: false }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('canon timeout')), timeoutMs)),
    ])
  } catch (e) {
    return { ...base, reason: /timeout/i.test(String(e && e.message)) ? 'llm_timeout' : 'llm_error' }
  }
  const hit = parseCanonReply(reply && reply.content, known)
  if (!hit) return { ...base, reason: 'llm_no_match' }
  return { input, canonical: hit.value, matched: true, how: 'llm', reason: null }
}
