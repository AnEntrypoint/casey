import crypto from 'node:crypto'
import fs from 'node:fs'
import { TABLE, ACTOR, isE164 } from './portal-store.js'

export const GLOBAL_ROUTER_ID = '_global'

const DEFAULT_PUBLIC_BASE = 'https://ubuntudashboard.co.za'
const DEFAULT_RETENTION_DAYS = 90

const TEXT_PLACEHOLDERS = Object.freeze(['bot_number', 'contact_minutes', 'block_hours'])
const PLACEHOLDER = /\{\{(\w+)\}\}/g
const DOMAIN = /^(\*\.)?([a-z0-9-]+\.)*[a-z0-9-]+$/
const ASN = /^AS\d{1,10}$/
const DOMAIN_MAX_CHARS = 253

const DEFAULT_WALLED_GARDEN = Object.freeze([
  'ubuntudashboard.co.za', '*.ubuntudashboard.co.za',
  'whatsapp.com', '*.whatsapp.com',
  'whatsapp.net', '*.whatsapp.net',
  'wa.me', '*.wa.me',
])

const SCHEMA = Object.freeze({
  bot_number: { type: 'e164', label: 'Bot number', help: 'WhatsApp number guests message to keep access, in E.164 form.' },
  registration_enabled: { type: 'bool', label: 'Registration open', help: 'When off, guests cannot register and the register endpoint answers 503.' },
  contact_window_s: { type: 'int', min: 60, max: 3600, label: 'Contact window (seconds)', help: 'How long a guest has to message the bot after registering.' },
  block_s: { type: 'int', min: 60, max: 604800, label: 'Block time (seconds)', help: 'How long a device stays blocked after a cut-off.' },
  idle_timeout_s: { type: 'int', min: 60, max: 86400, label: 'Idle timeout (seconds)', help: 'Inactivity before the router ends a session.' },
  usage_interval_s: { type: 'int', min: 60, max: 3600, label: 'Usage interval (seconds)', help: 'How often routers report per-device counters.' },
  heartbeat_interval_s: { type: 'int', min: 60, max: 3600, label: 'Heartbeat interval (seconds)', help: 'How often routers report health.' },
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

const DEFAULTS = Object.freeze({
  bot_number: '+27790915297',
  registration_enabled: true,
  contact_window_s: 300,
  block_s: 86400,
  idle_timeout_s: 1200,
  usage_interval_s: 300,
  heartbeat_interval_s: 300,
  guest_ssid: 'WhatsApp Free Wi-Fi',
  walled_garden: DEFAULT_WALLED_GARDEN,
  wa_asn: 'AS32934',
  login_title: 'Free WhatsApp access',
  login_intro: 'Enter your WhatsApp number, then accept the terms.',
  login_checkbox: 'I have read and accept the Terms and Conditions, and I agree that my phone number may be used as described.',
  done_title: 'You are registered',
  done_text: 'Access starts within a minute. Open WhatsApp and message the bot on {{bot_number}} within {{contact_minutes}} minutes to keep it.',
  blocked_title: 'Access paused',
  blocked_text: 'Your access ended because the WhatsApp bot did not receive a message from your number within {{contact_minutes}} minutes. This device cannot connect again for {{block_hours}} hours.',
  tc_title: 'Terms and Conditions: Free WhatsApp Access',
  tc_version: '1',
  tc_body: fs.readFileSync(new URL('./defaults/tc-body.txt', import.meta.url), 'utf8').trim(),
})

const SETTING_KEYS = Object.freeze(Object.keys(SCHEMA))
const ROUTER_KEYS = Object.freeze(SETTING_KEYS.filter(key => SCHEMA[key].type !== 'text'))

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

export function resolveSettings(globalOverrides = {}, routerOverrides = {}) {
  return Object.fromEntries(SETTING_KEYS.map(key => [key, routerOverrides[key] ?? globalOverrides[key] ?? DEFAULTS[key]]))
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

export function configVersion(settings) {
  return crypto.createHash('sha256').update(JSON.stringify(sortKeysDeep(settings))).digest('hex').slice(0, 16)
}

export const publicBase = (env = process.env) => String(env.PUBLIC_BASE || DEFAULT_PUBLIC_BASE).replace(/\/+$/, '')

export function retentionDays(env = process.env) {
  const days = Number(env.PORTAL_RETENTION_DAYS)
  return Number.isFinite(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS
}

export { SCHEMA, DEFAULTS, SETTING_KEYS, ROUTER_KEYS, TEXT_PLACEHOLDERS }
