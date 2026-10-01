

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { load as yamlLoadRaw, YAML11_SCHEMA } from 'js-yaml'

const yamlLoad = (text) => yamlLoadRaw(text, { schema: YAML11_SCHEMA })

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_CONFIG_DIR = path.resolve(__dirname, '..', 'config', 'default')

const require = createRequire(import.meta.url)

function resolveConfigDir() {
  const dir = process.env.CASEY_CONFIG_DIR
    ? path.resolve(process.env.CASEY_CONFIG_DIR)
    : DEFAULT_CONFIG_DIR
  if (!fs.existsSync(dir)) throw new Error(`casey config dir not found: ${dir}`)
  return dir
}

let cached = null

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

  const vocabulary = loadVocabulary(dir, { reportFields, persona: personaMod.persona })
  const applied = applyVocabulary(reportFields, personaMod.persona, vocabulary)

  cached = { dir, reportFields: applied.reportFields, persona: applied.persona, vocabulary }
  return cached
}

const VOCAB_FILE = 'vocabulary.yml'
export const VOCAB_CLIENT_SECTIONS = ['ui', 'glossary', 'stages', 'legend', 'form']

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

export const VOCAB_NAV_KEYS = ['activity', 'areas', 'clusters', 'contacts', 'disease_reports', 'distribution', 'export', 'external_links', 'feedback', 'focus', 'geo', 'handover', 'home_cases', 'home_map', 'metrics', 'new_case', 'nudges', 'offline', 'refresh', 'resolved_map', 'secretary', 'settings', 'stats', 'sweep', 'team']

const slug = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
const isWord = (v) => typeof v === 'string' ? v.trim() !== '' : (Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string' && x.trim() !== ''))

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

export function vocabWord(key, fallback = '') {
  const v = loadDomainConfig().vocabulary.words[key]
  return typeof v === 'string' ? v : (Array.isArray(v) ? v.join(' ') : fallback)
}

export function clientVocabulary() {
  const out = {}
  for (const [k, v] of Object.entries(loadDomainConfig().vocabulary.words)) {
    if (VOCAB_CLIENT_SECTIONS.includes(k.split('.')[0])) out[k] = v
  }
  return out
}

let thatcherEnumCache = null

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
