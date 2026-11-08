

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { load as yamlLoadRaw, YAML11_SCHEMA } from 'js-yaml'

const yamlLoad = (text) => yamlLoadRaw(text, { schema: YAML11_SCHEMA })

const require = createRequire(import.meta.url)

function resolveConfigDir() {
  if (!process.env.CASEY_CONFIG_DIR) throw new Error('CASEY_CONFIG_DIR is required: it holds domain.yml, thatcher.config.yml, report-fields.yml, persona.cjs, vocabulary.yml and portal-defaults.yml')
  const dir = path.resolve(process.env.CASEY_CONFIG_DIR)
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

  const domain = loadDomain(dir)
  const tierIds = Object.values(domain.tiers)
  const vocabulary = loadVocabulary(dir, { reportFields, persona: personaMod.persona, tierIds })
  const applied = applyVocabulary(reportFields, personaMod.persona, vocabulary, tierIds)

  cached = {
    dir,
    domain,
    reportFields: applied.reportFields,
    persona: applied.persona,
    vocabulary,
    pack: loadOptionalCjs(dir, 'pack.cjs'),
    externalSchema: loadOptionalCjs(dir, 'external-schema.cjs'),
    dashboard: loadOptionalYaml(dir, 'dashboard.yml'),
  }
  return cached
}

const TIER_KEYS = ['reporter', 'field', 'specialist', 'operator']

function validateDomain(domain, file) {
  const fail = (why) => { throw new Error(`domain.yml ${why} (${file})`) }
  const tiers = domain?.tiers
  if (!tiers || typeof tiers !== 'object' || Object.keys(tiers).join() !== TIER_KEYS.join()) fail(`tiers must list ${TIER_KEYS.join(', ')} in ladder order`)
  if (new Set(Object.values(tiers)).size !== TIER_KEYS.length || Object.values(tiers).some(v => typeof v !== 'string' || !v.trim())) fail('tiers must map each key to a distinct tier id')
  const labels = domain.tier_labels
  if (!labels || TIER_KEYS.some(k => typeof labels[k] !== 'string' || !labels[k].trim())) fail('tier_labels must label each tier key')
  if (!Array.isArray(domain.admin_only_tiers) || domain.admin_only_tiers.some(k => !TIER_KEYS.includes(k))) fail('admin_only_tiers must list tier keys')
  if (typeof domain.observation_form !== 'string' || !domain.observation_form) fail('observation_form must name the pack form')
  if (!domain.tool_names || typeof domain.tool_names !== 'object') fail('tool_names must map generic tool names to visible names')
  return domain
}

function loadDomain(dir) {
  const file = path.join(dir, 'domain.yml')
  if (!fs.existsSync(file)) throw new Error(`domain.yml not found in config dir: ${dir}`)
  return validateDomain(yamlLoad(fs.readFileSync(file, 'utf8')), file)
}

function loadOptionalCjs(dir, name) {
  const file = path.join(dir, name)
  if (!fs.existsSync(file)) return null
  delete require.cache[require.resolve(file)]
  return require(file)
}

function loadOptionalYaml(dir, name) {
  const file = path.join(dir, name)
  if (!fs.existsSync(file)) return {}
  return yamlLoad(fs.readFileSync(file, 'utf8')) || {}
}

export function visibleToolName(name) {
  return loadDomainConfig().domain.tool_names[name] ?? name
}

const VOCAB_FILE = 'vocabulary.yml'

export const VOCAB_CLIENT_SECTIONS = ['ui', 'glossary', 'stages', 'legend', 'form']

export const VOCAB_BOT_KEYS = {
  notice: 'noticeText',
  consent: 'consentText',
  staff_notice: 'staffNoticeText',
  new_person_notice: 'newPersonNoticeText',
  photo_nudge: 'photoNudge.text',
  stop_confirm: 'stopConfirmText',
  help_ranger: 'helpRanger',
  help_technician: 'helpTechnician',
  help_onboarding: 'helpOnboarding',
  area_question: 'areaQuestion',
  visit_mode: 'visitModeText',
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

function expectedKeys(defaultsWords, { reportFields, persona, tierIds = [] }, isDeploymentDir) {
  const keys = new Set(Object.keys(defaultsWords))
  if (!isDeploymentDir) return keys
  for (const f of reportFields.fields || []) {
    keys.add('fields.' + f.key + '.label')
    if (f.public !== false && !f.append) { keys.add('fields.' + f.key + '.form_label'); keys.add('fields.' + f.key + '.form_hint') }
  }
  for (const t of tierIds) keys.add('tiers.' + t)
  keys.add('app.brand'); keys.add('app.leaf')
  for (const s of new Set((reportFields.fields || []).map(f => f.section).filter(Boolean))) keys.add('sections.' + slug(s))
  for (const [name, path_] of Object.entries(VOCAB_BOT_KEYS)) {
    const [a, b] = path_.split('.')
    if (b ? persona?.[a]?.[b] != null : persona?.[a] != null) keys.add('bot.' + name)
  }
  return keys
}

export function loadVocabulary(dir, domain = null) {
  const file = path.join(dir, VOCAB_FILE)
  const own = readVocabFile(file)
  const words = { ...own.words }
  const expected = expectedKeys(words, domain || { reportFields: { fields: [] }, persona: {} }, true)
  const missing = [...expected].filter(k => !(k in own.words))
  const unknown = Object.keys(own.words).filter(k => !expected.has(k) && !(k.startsWith('nav.') && VOCAB_NAV_KEYS.includes(k.slice(4))))
  return { file, defaultsFile: file, hasFile: own.exists, words, missing, unknown, invalid: own.bad }
}

function clone(o) { return JSON.parse(JSON.stringify(o)) }

export function applyVocabulary(reportFields, persona, vocab, tierIds = []) {
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
  for (const t of tierIds) if (w['tiers.' + t]) tiers[t] = w['tiers.' + t]
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

export function vocabText(key, fallback, vars = {}) {
  return vocabWord(key, fallback).replace(/\{([a-z_]+)\}/g, (m, name) => (vars[name] != null ? String(vars[name]) : m))
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
      const dir = process.env.CASEY_CONFIG_DIR ? path.resolve(process.env.CASEY_CONFIG_DIR) : null
      const cfgPath = dir ? path.join(dir, 'thatcher.config.yml') : null
      thatcherEnumCache = cfgPath && fs.existsSync(cfgPath) ? yamlLoad(fs.readFileSync(cfgPath, 'utf8')) : {}
    } catch { thatcherEnumCache = {} }
  }
  const options = thatcherEnumCache?.entities?.[entity]?.fields?.[field]?.options
  return Array.isArray(options) ? options : null
}
