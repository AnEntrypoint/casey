import fs from 'node:fs'
import path from 'node:path'
import { load as yamlLoad } from 'js-yaml'

export const DEFAULT_LAUNCH_CUTOFF = '2026-12-01T00:00:00+02:00'
export const TEST_MARK = 'test'
export const NOT_TEST = ''
export const TEST_FILTERED_ENTITIES = Object.freeze(['case', 'event', 'contact'])
const OFFSET_RE = /(Z|[+-]\d{2}:?\d{2})$/

export function parseLaunchCutoff(value) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error('launch_cutoff is not a date and time')
    return value.getTime()
  }
  const raw = value == null || value === '' ? DEFAULT_LAUNCH_CUTOFF : String(value).trim()
  if (!OFFSET_RE.test(raw)) throw new Error(`launch_cutoff "${raw}" must carry a time zone offset (for example +02:00 for Africa/Johannesburg)`)
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) throw new Error(`launch_cutoff "${raw}" is not a date and time`)
  return ms
}

export function readDomainSettings(configDir = process.env.CASEY_CONFIG_DIR) {
  if (!configDir) return {}
  const file = path.join(path.resolve(configDir), 'domain.yml')
  if (!fs.existsSync(file)) return {}
  return yamlLoad(fs.readFileSync(file, 'utf8')) || {}
}

export function createdAtMs(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n
  const t = Date.parse(String(value))
  return Number.isFinite(t) ? t : null
}

export function isTestRecord(record, cutoffMs) {
  const at = createdAtMs(record?.created_at)
  return at != null && at < cutoffMs
}

export function testMarkFor(createdAt, cutoffMs) {
  const at = createdAtMs(createdAt)
  return at != null && at < cutoffMs ? TEST_MARK : NOT_TEST
}

export function digestMonthIsTest(month, cutoffMs) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''))
  if (!m) return false
  let y = Number(m[1]); let mo = Number(m[2]) + 1
  if (mo > 12) { mo = 1; y += 1 }
  const nextStart = Date.parse(`${y}-${String(mo).padStart(2, '0')}-01T00:00:00+02:00`)
  return nextStart <= cutoffMs
}

const isAccessContact = (row, reporterTier) => !!row && row.tier != null && row.tier !== '' && row.tier !== reporterTier

export function withTestMaterial(target, { cutoffMs, nowFn = () => Date.now(), reporterTier = 'reporter', entities = TEST_FILTERED_ENTITIES } = {}) {
  if (!Number.isFinite(cutoffMs)) throw new Error('withTestMaterial needs a launch cutoff in milliseconds')
  const filtered = new Set(entities)
  const hidingNow = () => nowFn() >= cutoffMs
  const hidden = (entity, row) => filtered.has(entity) && hidingNow() && isTestRecord(row, cutoffMs) && !(entity === 'contact' && isAccessContact(row, reporterTier))
  const label = (entity, row) => {
    if (!row || typeof row !== 'object' || !filtered.has(entity)) return row
    return { ...row, test_material: isTestRecord(row, cutoffMs) ? TEST_MARK : NOT_TEST }
  }
  const pageOf = (rows, opts) => {
    const offset = parseInt(opts?.offset || 0, 10) || 0
    const limit = opts?.limit ? parseInt(opts.limit, 10) : null
    return limit ? rows.slice(offset, offset + limit) : rows.slice(offset)
  }
  return new Proxy(target, {
    get(obj, prop, recv) {
      const orig = Reflect.get(obj, prop, recv)
      if (typeof orig !== 'function') return orig
      if (prop === 'create') {
        return async (entity, data, ...rest) => {
          const stamped = filtered.has(entity) && data && typeof data === 'object'
            ? { ...data, test_material: nowFn() < cutoffMs ? TEST_MARK : NOT_TEST }
            : data
          return orig.call(obj, entity, stamped, ...rest)
        }
      }
      if (prop === 'list') {
        return async (entity, where, opts, ...rest) => {
          if (!filtered.has(entity)) return orig.call(obj, entity, where, opts, ...rest)
          if (!hidingNow()) {
            const rows = await orig.call(obj, entity, where, opts, ...rest)
            return Array.isArray(rows) ? rows.map((r) => label(entity, r)) : rows
          }
          const { limit, offset, ...noPage } = opts || {}
          const rows = await orig.call(obj, entity, where, noPage, ...rest)
          if (!Array.isArray(rows)) return rows
          return pageOf(rows.filter((r) => !hidden(entity, r)).map((r) => label(entity, r)), { limit, offset })
        }
      }
      if (prop === 'get') {
        return async (entity, id, ...rest) => {
          const row = await orig.call(obj, entity, id, ...rest)
          if (!row || !filtered.has(entity)) return row
          if (hidden(entity, row)) return null
          return label(entity, row)
        }
      }
      if (prop === 'count') {
        return async (entity, where, ...rest) => {
          if (!filtered.has(entity) || !hidingNow()) return orig.call(obj, entity, where, ...rest)
          const rows = await obj.list(entity, where, {})
          return Array.isArray(rows) ? rows.filter((r) => !hidden(entity, r)).length : rows
        }
      }
      return orig
    },
  })
}
