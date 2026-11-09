import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { load as yamlLoadRaw, YAML11_SCHEMA } from 'js-yaml'
import { TABLE, ACTOR, isE164 } from './portal-store.js'

export const GLOBAL_ROUTER_ID = '_global'

export function loadTcBody(env = process.env) {
  const deployed = env.CASEY_CONFIG_DIR ? path.join(path.resolve(env.CASEY_CONFIG_DIR), 'portal', 'tc-body.txt') : null
  const file = deployed && fs.existsSync(deployed) ? deployed : new URL('./defaults/tc-body.txt', import.meta.url)
  return fs.readFileSync(file, 'utf8').trim()
}

const TEXT_PLACEHOLDERS = Object.freeze(['bot_number', 'contact_minutes', 'block_hours'])
const PLACEHOLDER = /\{\{(\w+)\}\}/g
const DOMAIN = /^(\*\.)?([a-z0-9-]+\.)*[a-z0-9-]+$/
const ASN = /^AS\d{1,10}$/
const DOMAIN_MAX_CHARS = 253

const SCHEMA = Object.freeze({
  bot_number: { type: 'e164', label: 'Bot number', help: 'WhatsApp number guests message to keep access, in E.164 form.' },
  registration_enabled: { type: 'bool', label: 'Registration open', help: 'When off, guests cannot register and the register endpoint answers 503.' },
  contact_window_s: { type: 'int', min: 60, max: 3600, label: 'Contact window (seconds)', help: 'How long a guest has to message the bot after registering.' },
  block_s: { type: 'int', min: 60, max: 604800, label: 'Block time (seconds)', help: 'How long a device stays blocked after a cut-off.' },
  idle_timeout_s: { type: 'int', min: 60, max: 86400, label: 'Idle timeout (seconds)', help: 'Inactivity before the router ends a session.' },
  usage_interval_s: { type: 'int', min: 60, max: 3600, label: 'Usage interval (seconds)', help: 'How often routers report per-device counters.' },
  heartbeat_interval_s: { type: 'int', min: 60, max: 3600, label: 'Heartbeat interval (seconds)', help: 'How often routers report health.' },
  idle_usage_interval_s: { type: 'int', min: 60, max: 86400, label: 'Idle usage interval (seconds)', help: 'How often a router reports counters while no client is connected. Equal to the usage interval changes nothing.' },
  idle_heartbeat_interval_s: { type: 'int', min: 60, max: 86400, label: 'Idle heartbeat interval (seconds)', help: 'How often a router reports health while no client is connected. Equal to the heartbeat interval changes nothing.' },
  idle_sync_interval_s: { type: 'int', min: 60, max: 86400, label: 'Idle sync interval (seconds)', help: 'How often a router on the fallback protocol fetches settings while no client is connected. Equal to the usage interval changes nothing.' },
  daily_cap_mb: { type: 'int', min: 1, max: 1000, serverOnly: true, label: 'Daily data cap (MB)', help: 'Data one guest device may use per day, up and down together, in MB of 1,048,576 bytes. The day resets at midnight in Johannesburg, and the cap is enforced while the device is in use.' },
  guest_ssid: { type: 'ssid', maxBytes: 32, label: 'Guest Wi-Fi name', help: 'The network name guests see, up to 32 bytes.' },
  walled_garden: { type: 'domains', maxItems: 100, label: 'Walled garden', help: 'Domains reachable before registration, one per line. Wildcards such as *.example.com are allowed.' },
  wa_asn: { type: 'asn', label: 'WhatsApp ASN', help: 'Autonomous system number that carries WhatsApp traffic, for example AS32934.' },
  login_title: { type: 'text', maxLength: 200, label: 'Login title', help: 'Heading of the registration page.' },
  login_intro: { type: 'text', maxLength: 2000, label: 'Login intro', help: 'Paragraph under the login title.' },
  login_checkbox: { type: 'text', maxLength: 1000, label: 'Terms checkbox', help: 'Text next to the terms checkbox.' },
  done_title: { type: 'text', maxLength: 200, label: 'Done title', help: 'Heading shown after registering.' },
  done_text: { type: 'text', maxLength: 2000, label: 'Done text', help: 'Paragraph after registering. May use {{bot_number}}, {{contact_minutes}} and {{block_hours}}.' },
  blocked_title: { type: 'text', maxLength: 200, label: 'Blocked title', help: 'Heading of the blocked page.' },
  blocked_text: { type: 'text', maxLength: 2000, label: 'Blocked text', help: 'Paragraph of the blocked page. May use {{bot_number}}, {{contact_minutes}} and {{block_hours}}.' },
  tc_title: { type: 'text', maxLength: 200, label: 'Terms title', help: 'Heading of the terms page.' },
  tc_version: { type: 'text', maxLength: 40, label: 'Terms version', help: 'Version label shown on the terms page.' },
  tc_body: { type: 'text', maxLength: 30000, label: 'Terms body', help: 'Terms text. Blank lines start a new paragraph. May use {{bot_number}}, {{contact_minutes}} and {{block_hours}}.' },
})

const DEFAULTS_FILE = 'portal-defaults.yml'
const DEPLOYER_KEYS = Object.freeze(['admin_router_cookie', 'phone_storage_key'])
let defaultsCache = null

export function loadDefaults(env = process.env) {
  if (defaultsCache) return defaultsCache
  const dir = env.CASEY_CONFIG_DIR ? path.resolve(env.CASEY_CONFIG_DIR) : null
  const file = dir ? path.join(dir, DEFAULTS_FILE) : null
  if (!file || !fs.existsSync(file)) throw new Error(`portal defaults not found: set CASEY_CONFIG_DIR to a directory holding ${DEFAULTS_FILE}`)
  const raw = yamlLoadRaw(fs.readFileSync(file, 'utf8'), { schema: YAML11_SCHEMA }) || {}
  const values = { ...raw }
  for (const key of [...SETTING_KEYS.filter(key => key !== 'tc_body'), ...DEPLOYER_KEYS]) {
    if (values[key] === undefined) throw new Error(`${DEFAULTS_FILE} is missing ${key}`)
  }
  values.tc_body = raw.tc_body || loadTcBody(env)
  defaultsCache = Object.freeze(values)
  return defaultsCache
}

const SETTING_KEYS = Object.freeze(Object.keys(SCHEMA))
const ROUTER_KEYS = Object.freeze(SETTING_KEYS.filter(key => SCHEMA[key].type !== 'text' && !SCHEMA[key].serverOnly))

const describe = (spec) => {
  if (spec.type === 'int') return `a whole number from ${spec.min} to ${spec.max}`
  if (spec.type === 'bool') return 'true or false'
  if (spec.type === 'e164') return 'a phone number in E.164 form, for example +27821234567'
  if (spec.type === 'ssid') return `text of 1 to ${spec.maxBytes} bytes`
  if (spec.type === 'asn') return 'an AS number, for example AS32934'
  if (spec.type === 'domains') return `a list of 1 to ${spec.maxItems} domains`
  return `text of 1 to ${spec.maxLength} characters`
}

const COERCE = {
  int: (spec, raw) => {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN
    return Number.isSafeInteger(n) && n >= spec.min && n <= spec.max ? n : null
  },
  bool: (spec, raw) => {
    if (raw === true || raw === 'true') return true
    if (raw === false || raw === 'false') return false
    return null
  },
  e164: (spec, raw) => {
    const phone = typeof raw === 'string' ? raw.replace(/[\s-]/g, '') : ''
    return isE164(phone) ? phone : null
  },
  ssid: (spec, raw) => {
    const name = typeof raw === 'string' ? raw.trim() : ''
    return name && Buffer.byteLength(name) <= spec.maxBytes ? name : null
  },
  asn: (spec, raw) => {
    const asn = typeof raw === 'string' ? raw.trim().toUpperCase() : ''
    return ASN.test(asn) ? asn : null
  },
  domains: (spec, raw) => {
    const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\n,]/) : null
    if (!items || items.some(item => typeof item !== 'string')) return null
    const domains = [...new Set(items.map(item => item.trim().toLowerCase()).filter(Boolean))]
    const valid = domains.length > 0 && domains.length <= spec.maxItems
      && domains.every(domain => domain.length <= DOMAIN_MAX_CHARS && DOMAIN.test(domain))
    return valid ? domains : null
  },
  text: (spec, raw) => {
    const text = typeof raw === 'string' ? raw.trim() : ''
    return text && text.length <= spec.maxLength ? text : null
  },
}

const placeholdersIn = (text) => [...text.matchAll(PLACEHOLDER)].map(match => match[1])

export function coerceSetting(key, raw) {
  const spec = SCHEMA[key]
  if (!spec) return { error: 'unknown setting', field: key }
  if (raw === null) return { value: null }
  const value = COERCE[spec.type](spec, raw)
  if (value === null) return { error: `${key} must be ${describe(spec)}`, field: key }
  if (spec.type === 'text' && placeholdersIn(value).some(name => !TEXT_PLACEHOLDERS.includes(name))) {
    return { error: `${key} may use only the placeholders ${TEXT_PLACEHOLDERS.map(name => `{{${name}}}`).join(', ')}`, field: key }
  }
  return { value }
}

export function checkSettingsPatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'settings must be an object', field: 'settings' }
  const values = {}
  for (const [key, raw] of Object.entries(input)) {
    const checked = coerceSetting(key, raw)
    if (checked.error) return { error: checked.error, field: checked.field }
    values[key] = checked.value
  }
  return { values }
}

const parseStored = (json) => {
  try { return JSON.parse(json) } catch { return null }
}

export async function loadOverrides(store, routerId) {
  const rows = await store.t.list(TABLE.settings, { router_id: routerId }, { limit: SETTING_KEYS.length * 2 })
  const overrides = {}
  for (const row of rows) {
    const raw = parseStored(row.value_json)
    if (raw === null) continue
    const checked = coerceSetting(row.key, raw)
    if (!checked.error && checked.value !== null) overrides[row.key] = checked.value
  }
  return overrides
}

export async function saveSettings(store, routerId, values, now = new Date().toISOString()) {
  for (const [key, value] of Object.entries(values)) {
    const valueJson = JSON.stringify(value)
    const [row] = await store.t.list(TABLE.settings, { router_id: routerId, key }, { limit: 1 })
    if (row) await store.t.update(TABLE.settings, row.id, { value_json: valueJson, updated_at: now }, ACTOR)
    else await store.t.create(TABLE.settings, { router_id: routerId, key, value_json: valueJson, updated_at: now }, ACTOR)
  }
}

export async function settingsChangedSince(store, routerId, since) {
  if (!since) return true
  for (const owner of [GLOBAL_ROUTER_ID, routerId]) {
    const rows = await store.t.list(TABLE.settings, { router_id: owner, updated_at: { $gt: since } }, { limit: 1 })
    if (rows.length) return true
  }
  return false
}

export function resolveSettings(globalOverrides = {}, routerOverrides = {}) {
  const defaults = loadDefaults()
  return Object.fromEntries(SETTING_KEYS.map(key => [key, routerOverrides[key] ?? globalOverrides[key] ?? defaults[key]]))
}

export async function effectiveSettings(store, routerId = null) {
  const globalOverrides = await loadOverrides(store, GLOBAL_ROUTER_ID)
  const routerOverrides = routerId ? await loadOverrides(store, routerId) : {}
  return resolveSettings(globalOverrides, routerOverrides)
}

export function routerSettings(settings) {
  return Object.fromEntries(ROUTER_KEYS.map(key => [key, settings[key]]))
}

const sortKeysDeep = (value) => {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeysDeep(value[key])]))
  return value
}

export const ASSET_REVISION = 'redirect-page-1'

export function configVersion(settings) {
  return crypto.createHash('sha256').update(JSON.stringify(sortKeysDeep({ settings, assets: ASSET_REVISION }))).digest('hex').slice(0, 16)
}

export const publicBase = (env = process.env) => {
  const base = env.PUBLIC_BASE || loadDefaults(env).public_base
  if (!base) throw new Error('PUBLIC_BASE is not set and portal-defaults.yml has no public_base')
  return String(base).replace(/\/+$/, '')
}

export function retentionDays(env = process.env) {
  const days = Number(env.PORTAL_RETENTION_DAYS)
  return Number.isFinite(days) && days > 0 ? days : 90
}

export { SCHEMA, SETTING_KEYS, ROUTER_KEYS, TEXT_PLACEHOLDERS }
