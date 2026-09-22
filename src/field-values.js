// field-values.js -- the vocabulary an operator picks from when they fill a
// report field in by hand, read from what is ALREADY in the store, plus the
// check that decides whether a value they just typed is one of those values
// spelled differently.
//
// Why this exists: species and location are free text, and the same real-world
// thing kept arriving spelled several ways -- live in this deployment's own
// store, "cattle" / "cow" / "cows" / "cattle?" / "cattle (14 head)" are five
// rows of the same animal, and "donkey"/"donkeys" two more. Every cross-case
// answer that groups by these fields (clusters.js, geo.js, distribution.js) is
// weaker for each split, and an operator typing into a plain text box has no
// way to see what the rest of the team already calls the thing in front of them.
//
// Two halves, deliberately separate:
//   - the KNOWN VALUES: a distinct rollup over the real report blobs, so the
//     dropdown an operator sees is the deployment's own live vocabulary and
//     never a hardcoded list somebody has to maintain.
//   - the CANONICALIZATION CHECK: exact match, then normalized match, then ONE
//     short real LLM call, in that order. The first two need no model at all
//     and answer instantly; the model is asked only about a surface form this
//     store has genuinely never seen.
//
// The model half fails OPEN, the same discipline hooks/media.js's opt-in
// enrichment uses: any error, any timeout, no backend wired at all, and the
// answer is "accept it as a new value". Data entry is never blocked on a
// provider, and nothing here ever fabricates a match.

import { parseReportTolerant as parseReport } from './timestamp.js'
// The same narrow surface-form rule the derived normalized_location column
// already uses (lowercase, trim, collapse whitespace, drop , . ; noise). Reused
// rather than re-stated so the dropdown, the location filter and thatcher's own
// derived column can never hold two different ideas of "the same value". It is
// deliberately NOT a gazetteer or an alias table (AGENTS.md's no-lookup-table
// principle) -- knowing that "eLambasi" and "Lambasi" are one place is the
// model's job below, not a table's.
import { normalizeLocation as surfaceKey } from './location-normalize.js'
import { ENQUIRY_HEADLINE_FIELDS, APPEND_FIELDS, REPORT_FIELD_DEFS, fieldLabel } from './store/report-shape.js'

// WHICH FIELDS GET A KNOWN-VALUE DROPDOWN, and why this set rather than "every
// free-text field".
//
// A dropdown of a field's values is, by construction, a cross-case disclosure:
// it shows one operator every value every other reporter has given for that
// field, detached from the case it came from. `enquiry_headline_fields` is the
// config's own declaration of exactly which fields are safe to show that way
// (report-shape.js: "the report fields safe to show in a cross-worker PII-free
// enquiry list"), so it is the right gate and not a convenience -- a
// contact_fallback or a notes field pooled into a picklist would leak a person's
// words into a control every operator can open.
//
// Append fields are excluded on top of that: their stored value accumulates
// (photo/audio/site rows), so a "distinct value" of one is a growing
// concatenation nobody would ever pick from a list.
export const KNOWN_VALUE_FIELDS = ENQUIRY_HEADLINE_FIELDS
  .filter(k => REPORT_FIELD_DEFS.some(f => f.key === k))
  .filter(k => !APPEND_FIELDS.has(k))

export function isKnownValueField(field) { return KNOWN_VALUE_FIELDS.includes(field) }

// How many distinct values the endpoint returns, and how many of them the model
// is shown. The first bounds a picklist a human reads; the second bounds the
// prompt so the call stays one short round trip.
const MAX_VALUES = 60
const MAX_VALUES_FOR_MODEL = 40

// Distinct values of one report field across the given case rows, most-used
// first. Values equal under surfaceKey are ONE entry whose displayed spelling is
// the most-used of them, with the counts added together -- an operator picking
// from this list should be offered "cattle", not "cattle" and "Cattle" and
// "cattle?" as three separate choices.
//
// A TIE between two spellings is broken by whichever the team used most
// recently, not alphabetically: the caller hands rows in last-activity order and
// both sorts here are stable, so first-seen wins. Alphabetically was actively
// wrong on place names -- "Winterton" and "winterton" one case each resolved to
// the lower-case one, and a picklist of South African districts in lower case
// reads as a database dump rather than as the places somebody typed.
//
// Pure: the caller hands in the rows. Same shape as distribution.js/geo.js, and
// deliberately NOT tokenized like those -- this is the value as somebody would
// pick it off a list, so "sheep and goats" is one option and not two.
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

// The one place the store is read for this. Memoized for a short window because
// every open of a case detail asks for it and the read is a full listCases pass;
// invalidated outright the moment a write lands on one of these fields
// (routes/cases.js's intake handler), so an operator who has just added a new
// species sees it in the next case they open rather than up to TTL_MS later.
const TTL_MS = 30_000
const memo = new Map()   // field -> { at, values }

export function invalidateKnownValues(field = null) {
  if (field == null) memo.clear()
  else memo.delete(field)
}

export async function readKnownValues(store, field, { now = Date.now() } = {}) {
  const hit = memo.get(field)
  if (hit && now - hit.at < TTL_MS) return hit.values
  // EVERY case, not only the open ones: a species recorded on a case that has
  // since been closed is still part of this deployment's vocabulary, and
  // offering it is exactly how a later report gets spelled the same way.
  const cases = await store.listCases({}, { limit: 10000 })
  const values = knownValues(cases, field)
  memo.set(field, { at: now, values })
  return values
}

// Exact first, then same-under-surfaceKey. Returns the KNOWN value (its stored
// spelling, which is the whole point) or null. No model, no I/O, no latency --
// this is what answers "Cattle" when "cattle" is already on record.
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

// The prompt. ONE short question, one line back -- no tool call, no
// conversation, nothing to parse but a verdict, because this sits between an
// operator's keystroke and their save.
//
// It asks the narrow question on purpose. "Which of these is closest" invites a
// match for anything; "is it the same real-world thing, only written
// differently" is answerable wrongly only by a model that thinks a goat is a
// sheep. The instruction to prefer NEW when unsure is load-bearing: a wrong NEW
// costs one duplicate row an operator can see and fix, a wrong SAME silently
// files this report under a different animal or a different place.
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

// Read the verdict. A SAME whose named value is not actually in the list (a
// model paraphrasing, or inventing one) is NOT a match -- it is exactly the case
// where accepting the model's own spelling would create the duplicate this whole
// path exists to prevent.
export function parseCanonReply(text, known) {
  const first = String(text || '').split('\n').map(s => s.trim()).filter(Boolean)[0] || ''
  const m = first.match(/^SAME\s*[::]\s*(.+)$/i)
  if (!m) return null
  const named = m[1].trim().replace(/^["']|["']$/g, '')
  return matchKnownValue(named, known)
}

// The per-call ceiling. Past it the value is accepted as new and the save goes
// through. Deliberately orders of magnitude tighter than the live-turn deadlines
// in llm.js -- nothing here is a reply to a contact, and a slow provider must
// cost an operator a moment, not a minute.
//
// MEASURED, not guessed. Against a real provider chain this one-line question
// came back in 1.9s / 2.3s / 2.5s / 2.6s / 3.0s / 3.2s / 3.8s / 6.6s over
// repeated live calls, and 22s once on a rate-limited link -- the spread is the
// provider's queueing, not the work, and pinning a single fast model with
// CASEY_CANON_MODEL did not narrow it. So no ceiling here buys both "always
// answers" and "always fast", and the tradeoff is made deliberately: 5s catches
// the large majority, and every call past it costs a duplicate value an operator
// can see rather than a wait they cannot escape.
//
// What makes that bearable is that the ceiling is NOT the operator's wait. The
// client starts this check on a pause in typing (known-values.js
// prefetchResolve), so by the time a hand has reached Save the answer has
// usually already landed; the ceiling bounds the tail of that, not the common
// path. Lower it for a deployment that would rather never wait than ever match.
const CANON_TIMEOUT_MS = Number(process.env.CASEY_CANON_TIMEOUT_MS) || 5000

// Per-call model override, unset by default (the call uses whatever backend the
// process resolved -- CASEY_LLM_MODEL). This is the exact per-call reason
// llm.js's own `req.model` passthrough documents: a one-line classification
// outside the conversational turn, where a deployment may legitimately want one
// cheap fast link instead of the full auto-chain it answers contacts with.
const CANON_MODEL = process.env.CASEY_CANON_MODEL || null

// The whole check. Returns the same shape whichever branch answered, so the
// caller never has to know which one did:
//   { input, canonical, matched, how, reason }
// `canonical` is always a value safe to store -- the existing spelling on a
// match, the operator's own text otherwise.
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
      // recordHealth:false -- this is not a live inbound turn, and a slow
      // canonicalization must never poison the rolling window that decides
      // whether a real contact's next message gets queued instead of answered
      // (see llm.js's recordHealth note).
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
