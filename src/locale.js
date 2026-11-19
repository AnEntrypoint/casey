import { loadDomainConfig } from './config-loader.js'

const env = process.env
const cfg = loadDomainConfig().domain.locale || {}
const text = (v, d) => (typeof v === 'string' ? v : d)
const digits = (v) => String(v ?? '').replace(/\D/g, '')
const groups = (v) => (Array.isArray(v) && v.length && v.every((n) => Number.isInteger(n) && n > 0) ? v : null)

const TIMEZONE = env.CASEY_TZ || text(cfg.timezone, 'UTC')
try { new Intl.DateTimeFormat('en', { timeZone: TIMEZONE }) } catch { throw new Error('domain.yml locale.timezone is not a time zone') }

export const SAST_TZ = TIMEZONE
export const TZ_LABEL = env.CASEY_TZ_LABEL || (env.CASEY_TZ ? '' : text(cfg.timezone_label, 'UTC'))
export const UTC_OFFSET_HOURS = Number.isInteger(cfg.utc_offset_hours) ? cfg.utc_offset_hours : 0
export const LOCALE = text(cfg.locale, 'en')
export const COUNTRY_CODE = digits(env.CASEY_COUNTRY_CODE || text(cfg.country_code, ''))
export const TRUNK_PREFIX = digits(text(cfg.trunk_prefix, ''))
export const NATIONAL_LENGTH = Number.isInteger(cfg.national_length) && cfg.national_length > 0 ? cfg.national_length : null
export const INTERNATIONAL_GROUPS = groups(cfg.format_international)
export const LOCAL_GROUPS = groups(cfg.format_local)

export const LOCAL_NUMBER_RE = TRUNK_PREFIX && NATIONAL_LENGTH ? new RegExp(`^${TRUNK_PREFIX}[0-9]{${NATIONAL_LENGTH}}$`) : null
export const INTERNATIONAL_DIGITS_RE = COUNTRY_CODE && NATIONAL_LENGTH ? new RegExp(`^${COUNTRY_CODE}[0-9]{${NATIONAL_LENGTH}}$`) : null
export const INTERNATIONAL_PLUS_RE = COUNTRY_CODE && NATIONAL_LENGTH ? new RegExp(`^\\+${COUNTRY_CODE}[0-9]{${NATIONAL_LENGTH}}$`) : null

export function spaced(s, sizes) {
  if (!sizes) return s
  const parts = []
  let at = 0
  for (const n of sizes) { parts.push(s.slice(at, at + n)); at += n }
  if (at < s.length) parts.push(s.slice(at))
  return parts.join(' ')
}

export const EXAMPLE_LOCAL = text(cfg.examples?.local, '')
export const EXAMPLE_INTERNATIONAL = text(cfg.examples?.international, '')

export function phoneDigitsOk(d) {
  if (LOCAL_NUMBER_RE || INTERNATIONAL_PLUS_RE) return Boolean((LOCAL_NUMBER_RE && LOCAL_NUMBER_RE.test(d)) || (INTERNATIONAL_PLUS_RE && INTERNATIONAL_PLUS_RE.test(d)))
  return /^\+?[0-9]{7,15}$/.test(d)
}

export function jsSingle(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export function clientPhoneRuleLines() {
  const lines = []
  if (LOCAL_NUMBER_RE) lines.push(`      if (/${LOCAL_NUMBER_RE.source}/.test(d)) { phoneEl.value = '+${COUNTRY_CODE}' + d.slice(${TRUNK_PREFIX.length}); errEl.className = 'field-err'; phoneEl.removeAttribute('aria-invalid'); return }`)
  if (INTERNATIONAL_DIGITS_RE) lines.push(`      if (/${INTERNATIONAL_DIGITS_RE.source}/.test(d)) { phoneEl.value = '+' + d; errEl.className = 'field-err'; phoneEl.removeAttribute('aria-invalid'); return }`)
  if (INTERNATIONAL_PLUS_RE) lines.push(`      if (/${INTERNATIONAL_PLUS_RE.source}/.test(d)) { errEl.className = 'field-err'; phoneEl.removeAttribute('aria-invalid'); return }`)
  return lines.map((l) => l + '\n').join('')
}
