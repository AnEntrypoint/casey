// progress-line.js -- the form-progress block that closes every reply to a member of the public
// who has something on record:
//
//   Done:
//   - Animals: goat
//   - Where: Lambasi
//
//   Still needed:
//   - Signs
//
// It is RENDERED IN CODE from two lists the system already holds (what is written down; what is
// still missing), with no model call, so it costs no time, is always present and is always true to
// the record. The lists are STATE, not text classification: recorded fields are the non-blank report
// fields (values exactly as the person gave them), still-needed is the mandatory minimum then the
// on-site-critical facts, both under the deployment's own labels (store/report-shape.js). Team
// members are not given this block: their prompt already reports the reference and gaps.
//
// LANGUAGE. Values stay verbatim. The fixed words (the two line headings and the field labels)
// come from, in order: (1) `form-progress.yml` in the config dir, a complete set per language that a
// native speaker has checked; (2) a set the model translated ONCE for that language and cached under
// data/form-labels/ (one call the first time a language appears, never per message; marked
// `verified: false`, and a file in (1) replaces it); (3) English. The language is whatever the model
// recorded in the report's `language_detected`, compared as a normalised slug; nothing here detects a
// language. A set is used whole or not at all, so one line never mixes languages.
//
// The block is appended after the reply has been judged (hooks/inbound-turn.js), so a recorded value
// such as a number is never scanned by the stray-contact-detail check.

import fs from 'node:fs'
import path from 'node:path'
import { load as yamlLoad } from 'js-yaml'
import { parseReport } from './timestamp.js'
import { CRITICAL_FIELDS, FIELD_LABELS, REPORT_FIELD_DEFS, missingMandatoryMinimum, fieldLabel } from './store/report-shape.js'

// Fields that describe the conversation or the record's plumbing, not the animals.
const SKIP = new Set(['photos', 'audio', 'language_detected', 'association', 'lat', 'lon', 'sites', 'reported_by', 'owner_contact'])
const MAX_FACTS = 8
const MAX_NEEDED = 5
const MAX_VALUE = 90
const MAX_LABEL = 60

export const ENGLISH = Object.freeze({ done: 'Done', needed: 'Still needed', complete: 'The form is complete' })

const clip = (v) => {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim()
  return t.length > MAX_VALUE ? `${t.slice(0, MAX_VALUE - 3).trimEnd()}...` : t
}
const plainLabel = (k, fields) => String((fields && fields[k]) || fieldLabel(k)).replace(/\?+$/, '').trim()

// { recorded: [{key, label, value}], more: n, stillNeeded: [key] } for one case row. Critical facts are
// listed first so the cap never hides the ones that matter on site.
export function progressFacts(caseRow) {
  const r = parseReport(caseRow) || {}
  const critical = new Set(CRITICAL_FIELDS)
  // A shared location pin (or any stored position) IS where the animals are, even with no place written: it counts
  // as the location, shown as its coordinates so the line stays language-neutral.
  const lat = Number(caseRow?.lat), lon = Number(caseRow?.lon)
  const pinned = caseRow?.lat != null && caseRow?.lon != null && Number.isFinite(lat) && Number.isFinite(lon)
  if (pinned && !clip(r.location)) r.location = `${lat.toFixed(3)}, ${lon.toFixed(3)}`
  const filled = Object.keys(r).filter(k => !SKIP.has(k) && clip(r[k]))
  filled.sort((a, b) => (critical.has(b) ? 1 : 0) - (critical.has(a) ? 1 : 0))
  const have = new Set(Object.keys(r).filter(k => clip(r[k])))
  // Field KEYS first (the floor, then the on-site-critical facts), each once: the same fact must not appear
  // under two names.
  const needed = [...new Set([...missingMandatoryMinimum(r), ...CRITICAL_FIELDS.filter(k => !have.has(k))])].filter(k => !SKIP.has(k))
  return {
    recorded: filled.slice(0, MAX_FACTS).map(k => ({ key: k, value: clip(r[k]) })),
    more: Math.max(0, filled.length - MAX_FACTS),
    stillNeeded: needed.slice(0, MAX_NEEDED),
  }
}

// `labels` is { done, needed, complete, fields?: { key: label } }. One item per line, because several items run
// together on a single line are hard to read on a phone:
//
//   Done:
//   - Animals: goat
//   - Where: Lambasi
//
//   Still needed:
//   - Signs
//   - How to find the place
export function renderFormProgress(caseRow, labels = ENGLISH) {
  if (!caseRow) return ''
  const L = { ...ENGLISH, ...(labels || {}) }
  const f = L.fields || {}
  const { recorded, more, stillNeeded } = progressFacts(caseRow)
  if (!recorded.length && !stillNeeded.length) return ''
  const done = recorded.length
    ? [`${L.done}:`, ...recorded.map(x => `- ${plainLabel(x.key, f)}: ${x.value}`), ...(more ? [`- +${more}`] : [])].join('\n')
    : ''
  const needed = stillNeeded.length ? [`${L.needed}:`, ...stillNeeded.map(k => `- ${plainLabel(k, f)}`)].join('\n') : L.complete
  return [done, needed].filter(Boolean).join('\n\n')
}

// ---- the words, per language --------------------------------------------------------------------------

const slugOf = (language) => String(language || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').slice(0, 2).join('-').slice(0, 30)
const isEnglish = (slug) => slug === '' || slug === 'en' || slug.startsWith('english')

const FIELD_KEYS = () => [...new Set(REPORT_FIELD_DEFS.map(d => d.key).filter(k => !SKIP.has(k)))]
const wanted = () => ({ done: ENGLISH.done, needed: ENGLISH.needed, complete: ENGLISH.complete, fields: Object.fromEntries(FIELD_KEYS().map(k => [k, plainLabel(k, FIELD_LABELS)])) })

const sane = (s) => typeof s === 'string' && s.trim() !== '' && s.length <= MAX_LABEL && !/\d{3,}|https?:|www\./i.test(s)
function complete(set) {
  if (!set || !sane(set.done) || !sane(set.needed) || !sane(set.complete)) return null
  const fields = {}
  for (const k of FIELD_KEYS()) { if (!sane(set.fields?.[k])) return null; fields[k] = set.fields[k].replace(/\s+/g, ' ').trim() }
  return { done: set.done.trim(), needed: set.needed.trim(), complete: set.complete.trim(), fields }
}

let overridesCache = null
function overrides() {
  if (overridesCache) return overridesCache
  overridesCache = {}
  const dir = process.env.CASEY_CONFIG_DIR
  if (!dir) return overridesCache
  try { overridesCache = yamlLoad(fs.readFileSync(path.join(dir, 'form-progress.yml'), 'utf8')) || {} } catch { /* none: the cache and English apply */ }
  return overridesCache
}

const cacheFile = (slug) => path.resolve(process.cwd(), 'data', 'form-labels', `${slug}.json`)
const failedAt = new Map()
const RETRY_AFTER_MS = 10 * 60e3
const inflight = new Map()

async function translateOnce(callLLM, language, slug) {
  const en = wanted()
  const prompt = [
    `Translate these short labels for a form into ${String(language).slice(0, 40)}, as a native speaker would write them on a phone form.`,
    `Reply with ONLY a JSON object with exactly the same keys and structure, every value a short plain string (under ${MAX_LABEL} characters), no markdown, nothing else.`,
    JSON.stringify(en),
  ].join('\n')
  const out = String((await callLLM({ messages: [{ role: 'user', content: prompt }], tools: [] }))?.content || '')
  const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)
  const set = complete(JSON.parse(json))
  if (!set) return null
  fs.mkdirSync(path.dirname(cacheFile(slug)), { recursive: true })
  fs.writeFileSync(cacheFile(slug), JSON.stringify({ language: String(language).slice(0, 40), verified: false, made_at: new Date().toISOString(), ...set }, null, 1))
  return set
}

// The words for this language, always a whole usable set. Only a language the model recorded and that has
// neither a checked set nor a cached one costs a call, once.
export async function formLabelsFor(callLLM, language) {
  const slug = slugOf(language)
  if (isEnglish(slug)) return complete(overrides().en) || { ...ENGLISH, fields: Object.fromEntries(FIELD_KEYS().map(k => [k, plainLabel(k, FIELD_LABELS)])) }
  const checked = complete(overrides()[slug])
  if (checked) return checked
  try { const cached = complete(JSON.parse(fs.readFileSync(cacheFile(slug), 'utf8'))); if (cached) return cached } catch { /* not cached yet */ }
  const english = () => ({ ...ENGLISH, fields: Object.fromEntries(FIELD_KEYS().map(k => [k, plainLabel(k, FIELD_LABELS)])) })
  if (typeof callLLM !== 'function' || Date.now() - (failedAt.get(slug) || 0) < RETRY_AFTER_MS) return english()
  if (!inflight.has(slug)) {
    inflight.set(slug, translateOnce(callLLM, language, slug).catch(() => null).finally(() => inflight.delete(slug)))
  }
  const made = await inflight.get(slug)
  if (made) return made
  failedAt.set(slug, Date.now())
  return english()
}
