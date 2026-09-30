// config-loader.js -- resolves and loads casey's domain config package.
//
// CASEY_CONFIG_DIR (set by a deployer, e.g. the uhh package's bin script)
// points at a directory holding report-fields.yml, persona.js, and
// dashboard.yml. Absent, casey falls back to its own bundled generic-demo
// config under config/default/ -- so a bare `casey up` with no external
// config package always boots into a real, working (if generic) persona
// rather than failing closed.
//
// Deployer-controlled only: CASEY_CONFIG_DIR is an environment variable set
// by whoever starts the process, never a value a contact/end-user can
// influence through the conversation -- there is no contact-facing tool or
// code path that reads or writes this variable.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { load as yamlLoadRaw, YAML11_SCHEMA } from 'js-yaml'
// js-yaml v5 dropped YAML 1.1 merge-key (<<) resolution from its default
// schema -- thatcher.config.yml's entity fields rely on <<: *system_fields
// to inject id/created_at/created_by/updated_at, so every config load must
// opt back into YAML11_SCHEMA or those fields silently vanish.
const yamlLoad = (text) => yamlLoadRaw(text, { schema: YAML11_SCHEMA })

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_CONFIG_DIR = path.resolve(__dirname, '..', 'config', 'default')
// persona.cjs is loaded via createRequire (CJS-style synchronous require) so
// this whole loader can stay synchronous -- REPORT_KEYS/REPORT_KEY_ORDER in
// store/report-shape.js are consumed as module-level constants at import
// time by 6 other files, and a real dynamic `import()` cannot be awaited at
// that point without turning every one of those 6 files' own imports async.
// The .cjs extension (not .js) is required: this project's package.json sets
// "type": "module", so a bare .js file in a config dir with no package.json
// of its own would be parsed as ESM and createRequire's synchronous require
// would fail on the `export` syntax.
const require = createRequire(import.meta.url)

function resolveConfigDir() {
  const dir = process.env.CASEY_CONFIG_DIR
    ? path.resolve(process.env.CASEY_CONFIG_DIR)
    : DEFAULT_CONFIG_DIR
  if (!fs.existsSync(dir)) throw new Error(`casey config dir not found: ${dir}`)
  return dir
}

let cached = null

// Loads report-fields.yml + persona.js from the resolved config dir. Cached
// per-process (module-level singleton) -- config is deployer-set at process
// start, never changes mid-run, matching every other module-level env-derived
// constant in this codebase (see hooks/prompt.js's LOCATION_STALE_MS).
export function loadDomainConfig() {
  if (cached) return cached
  const dir = resolveConfigDir()

  const reportFieldsPath = path.join(dir, 'report-fields.yml')
  if (!fs.existsSync(reportFieldsPath)) throw new Error(`report-fields.yml not found in config dir: ${dir}`)
  const reportFields = yamlLoad(fs.readFileSync(reportFieldsPath, 'utf8'))
  if (!reportFields || !Array.isArray(reportFields.fields)) throw new Error(`report-fields.yml malformed: missing fields[] array (${reportFieldsPath})`)

  const personaPath = path.join(dir, 'persona.cjs')
  if (!fs.existsSync(personaPath)) throw new Error(`persona.cjs not found in config dir: ${dir}`)
  delete require.cache[require.resolve(personaPath)]
  const personaMod = require(personaPath)
  if (!personaMod.persona) throw new Error(`persona.cjs must export persona via module.exports (${personaPath})`)

  // The words: vocabulary.yml overlays labels, tier names, nav labels and the
  // bot's notice/nudge texts onto the two files above (see loadVocabulary).
  const vocabulary = loadVocabulary(dir, { reportFields, persona: personaMod.persona })
  const applied = applyVocabulary(reportFields, personaMod.persona, vocabulary)

  cached = { dir, reportFields: applied.reportFields, persona: applied.persona, vocabulary }
  return cached
}

// ---------------------------------------------------------------------------
// VOCABULARY -- one deployment-editable file of the words people read.
//
// <config dir>/vocabulary.yml is layered OVER casey's bundled defaults
// (config/default/vocabulary.yml). Every leaf is a flat dotted key ("ui.offline_title",
// "fields.species.label") holding a string, or a list of strings for a multi-line
// bot text. A key the deployment file lacks (or leaves blank, or gives a value of
// the wrong kind) falls back, per key, to: the bundled default, and for a report
// field's label or a tier name to what report-fields.yml already says. Nothing
// throws on a missing key -- `casey doctor` lists them via vocabularyReport().
//
// Sections that carry code-owned keys (the client sections below) are served to the
// dashboard; the rest are applied server-side by applyVocabulary().
//
//   ui, glossary, stages, legend, form   words the dashboard and the public form show
//   fields.<key>.label|form_label|form_hint   a report field's name on the dashboard,
//                                        and its question + example on the form
//   sections.<slug>                      the headings the report fields are grouped under
//   tiers.<tier>                         what each access level is called
//   nav.<item>                           relabelled sidebar items
//   app.brand, app.leaf                  the product name and what it lists
//   bot.<text>                           the bot's notice, staff note and nudges
// ---------------------------------------------------------------------------
const VOCAB_FILE = 'vocabulary.yml'
export const VOCAB_CLIENT_SECTIONS = ['ui', 'glossary', 'stages', 'legend', 'form']
// Persona texts a deployment may set from vocabulary.yml as bot.<name>. photoNudge is
// an object in persona.cjs; its wording is bot.photo_nudge and only `text` is replaced.
export const VOCAB_BOT_KEYS = {
  notice: 'noticeText',
  consent: 'consentText',
  staff_notice: 'staffNoticeText',
  new_person_notice: 'newPersonNoticeText',
  photo_nudge: 'photoNudge.text',
  location_confirm: 'locationConfirmNudge',
  worker_catch_up: 'workerCatchUpText',
  casual_enquiry_blocked: 'casualReporterEnquiryBlockedText',
  returned_after_gap: 'returnedAfterGapText',
}

// The sidebar items a deployment may rename (nav.<key>). Optional: an item with no line
// keeps its built-in name, so these are known keys but never "missing".
export const VOCAB_NAV_KEYS = ['activity', 'areas', 'clusters', 'contacts', 'disease_reports', 'distribution', 'export', 'external_links', 'feedback', 'focus', 'geo', 'handover', 'home_cases', 'home_map', 'metrics', 'new_case', 'nudges', 'offline', 'refresh', 'resolved_map', 'secretary', 'settings', 'stats', 'sweep', 'team']

const slug = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
const isWord = (v) => typeof v === 'string' ? v.trim() !== '' : (Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string' && x.trim() !== ''))

// { a: { b: 'x', c: ['y'] } } -> { 'a.b': 'x', 'a.c': ['y'] }; anything else is dropped into `bad`.
function flatten(tree, prefix = '', out = {}, bad = []) {
  if (tree == null) return { out, bad }
  if (typeof tree !== 'object' || Array.isArray(tree)) { bad.push(prefix || '(root)'); return { out, bad } }
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? prefix + '.' + k : String(k)
    if (key === 'version') continue
    if (v != null && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out, bad)
    else if (isWord(v)) out[key] = v
    else bad.push(key)
  }
  return { out, bad }
}

function readVocabFile(file) {
  if (!fs.existsSync(file)) return { exists: false, words: {}, bad: [] }
  const tree = yamlLoad(fs.readFileSync(file, 'utf8'))
  const { out, bad } = flatten(tree)
  return { exists: true, words: out, bad }
}

// The keys a deployment is EXPECTED to set, given its own report fields and persona.
// The bundled defaults always count; a deployment package (config dir other than the
// bundled one) also owes a label + form question + example per field, a name per tier,
// its nav relabels and the bot texts it actually declares.
function expectedKeys(defaultsWords, { reportFields, persona }, isDeploymentDir) {
  const keys = new Set(Object.keys(defaultsWords))
  if (!isDeploymentDir) return keys
  for (const f of reportFields.fields || []) {
    keys.add('fields.' + f.key + '.label')
    if (f.public !== false && !f.append) { keys.add('fields.' + f.key + '.form_label'); keys.add('fields.' + f.key + '.form_hint') }
  }
  for (const t of ['reporter', 'field_worker', 'animal_health_technician', 'operator']) keys.add('tiers.' + t)
  keys.add('app.brand'); keys.add('app.leaf')
  for (const s of new Set((reportFields.fields || []).map(f => f.section).filter(Boolean))) keys.add('sections.' + slug(s))
  for (const [name, path_] of Object.entries(VOCAB_BOT_KEYS)) {
    const [a, b] = path_.split('.')
    if (b ? persona?.[a]?.[b] != null : persona?.[a] != null) keys.add('bot.' + name)
  }
  return keys
}

// Loads and merges. Returns { file, defaultsFile, hasFile, words, missing, unknown, invalid }.
//   words    every key -> the string (or string list) in force
//   missing  expected keys the deployment's own file does not set (they use the fallback)
//   unknown  keys in the deployment file that nothing reads (a typo, usually)
//   invalid  keys present but blank or the wrong kind (ignored)
export function loadVocabulary(dir, domain = null) {
  const defaultsFile = path.join(DEFAULT_CONFIG_DIR, VOCAB_FILE)
  const file = path.join(dir, VOCAB_FILE)
  const isDeploymentDir = path.resolve(dir) !== path.resolve(DEFAULT_CONFIG_DIR)
  const defaults = readVocabFile(defaultsFile)
  const own = isDeploymentDir ? readVocabFile(file) : defaults
  const words = { ...defaults.words, ...own.words }
  const expected = expectedKeys(defaults.words, domain || { reportFields: { fields: [] }, persona: {} }, isDeploymentDir)
  const missing = [...expected].filter(k => !(k in own.words))
  const unknown = Object.keys(own.words).filter(k => !expected.has(k) && !(k.startsWith('nav.') && VOCAB_NAV_KEYS.includes(k.slice(4))))
  return { file, defaultsFile, hasFile: own.exists, words, missing, unknown, invalid: own.bad }
}

function clone(o) { return JSON.parse(JSON.stringify(o)) }

// Lays the words over the two config files. Pure: returns copies, so the cached raw
// files are never edited. Only keys the vocabulary actually holds are applied, which
// is why casey's bundled default (no fields./tiers./bot. keys) changes nothing.
export function applyVocabulary(reportFields, persona, vocab) {
  const w = vocab.words
  const rf = clone(reportFields)
  for (const f of rf.fields || []) {
    if (w['fields.' + f.key + '.label']) f.display_label = w['fields.' + f.key + '.label']
    if (w['fields.' + f.key + '.form_label']) f.public_label = w['fields.' + f.key + '.form_label']
    if (w['fields.' + f.key + '.form_hint']) f.public_hint = w['fields.' + f.key + '.form_hint']
    if (f.section && w['sections.' + slug(f.section)]) f.section = w['sections.' + slug(f.section)]
  }
  const ui = { ...(rf.dashboard_ui || {}) }
  let touchedUi = false
  const tiers = {}
  for (const t of ['reporter', 'field_worker', 'animal_health_technician', 'operator']) if (w['tiers.' + t]) tiers[t] = w['tiers.' + t]
  if (Object.keys(tiers).length) { ui.tier_labels = { ...(ui.tier_labels || {}), ...tiers }; touchedUi = true }
  const relabel = {}
  for (const [k, v] of Object.entries(w)) if (k.startsWith('nav.')) relabel[k.slice(4)] = v
  if (Object.keys(relabel).length) { ui.nav = { ...(ui.nav || {}), relabel: { ...(ui.nav?.relabel || {}), ...relabel } }; touchedUi = true }
  if (w['app.brand']) { ui.brand = w['app.brand']; touchedUi = true }
  if (w['app.leaf']) { ui.leaf = w['app.leaf']; touchedUi = true }
  if (touchedUi) rf.dashboard_ui = ui
  const ps = clone(persona)
  for (const [name, target] of Object.entries(VOCAB_BOT_KEYS)) {
    const v = w['bot.' + name]
    if (!v) continue
    const [a, b] = target.split('.')
    if (b) { if (ps[a] && typeof ps[a] === 'object') ps[a][b] = v } else ps[a] = v
  }
  return { reportFields: rf, persona: ps }
}

// One word for server-side code (the public form's group headings). Falls back to
// the caller's literal only if the bundled defaults are somehow unreadable.
export function vocabWord(key, fallback = '') {
  const v = loadDomainConfig().vocabulary.words[key]
  return typeof v === 'string' ? v : (Array.isArray(v) ? v.join(' ') : fallback)
}

// The subset of words the dashboard shell needs, as a flat object. Handed to the
// browser inside the served index.html (no login needed: none of it is case data).
export function clientVocabulary() {
  const out = {}
  for (const [k, v] of Object.entries(loadDomainConfig().vocabulary.words)) {
    if (VOCAB_CLIENT_SECTIONS.includes(k.split('.')[0])) out[k] = v
  }
  return out
}

let thatcherEnumCache = null

// Reads a thatcher.config.yml entity.field enum's options[] -- used to seed
// case-tools.js's tool-schema `enum` hints (case_type, priority) so the
// model is shown the ACTIVE domain's real values instead of a hardcoded
// literal that only matched one prior domain. Same CASEY_CONFIG_DIR > cwd
// precedence as case-store.js's own CaseStore constructor default (see
// there for why) -- this must resolve the SAME thatcher.config.yml the live
// store will load, or the tool-schema hint and the write-time enforcement
// (store().getFieldEnum(), the actual authority) would silently diverge.
// Best-effort: returns null on any read/parse failure so a caller can fall
// back to its own hardcoded default rather than crashing plugin load.
export function readThatcherFieldEnum(entity, field) {
  if (!thatcherEnumCache) {
    try {
      const dir = process.env.CASEY_CONFIG_DIR ? path.resolve(process.env.CASEY_CONFIG_DIR) : process.cwd()
      const cfgPath = path.join(dir, 'thatcher.config.yml')
      thatcherEnumCache = fs.existsSync(cfgPath) ? yamlLoad(fs.readFileSync(cfgPath, 'utf8')) : {}
    } catch { thatcherEnumCache = {} }
  }
  const options = thatcherEnumCache?.entities?.[entity]?.fields?.[field]?.options
  return Array.isArray(options) ? options : null
}
