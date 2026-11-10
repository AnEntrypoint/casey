import { TABLE, ACTOR, isoOrNull } from './portal-store.js'
import { effectiveSettings } from './portal-config.js'
import { recordOutages } from './portal-outages.js'

export const HEARTBEAT_BYTES_MAX = 8192
export const HEALTH_ROWS_MAX = 500
const LOG_ERRORS_MAX = 10
const LOG_LINE_MAX_CHARS = 200
const HEALTH_KEYS = Object.freeze([
  'uptime_s', 'version', 'board', 'cpu_load_pct', 'free_mem_bytes', 'total_mem_bytes', 'temperature_c',
  'active_clients', 'registered_devices', 'bypassed_devices', 'wifi', 'ether', 'lte', 'dhcp_leases',
  'wan', 'config_version', 'log_errors',
])
const TRIM_ORDER = Object.freeze(['log_errors', 'wifi', 'ether', 'wan', 'lte', 'dhcp_leases'])

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export function shapeHealth(raw) {
  const shaped = {}
  for (const key of HEALTH_KEYS) if (raw[key] !== undefined) shaped[key] = raw[key]
  if (Array.isArray(shaped.log_errors)) shaped.log_errors = shaped.log_errors.slice(0, LOG_ERRORS_MAX).map(line => String(line).slice(0, LOG_LINE_MAX_CHARS))
  else delete shaped.log_errors
  for (const key of TRIM_ORDER) {
    if (Buffer.byteLength(JSON.stringify(shaped)) <= HEARTBEAT_BYTES_MAX) break
    delete shaped[key]
  }
  return shaped
}

export function parseHealth(raw) {
  if (raw === undefined || raw === null) return { health: {} }
  if (!isPlainObject(raw)) return { error: 'health must be a JSON object', field: 'health' }
  return { health: shapeHealth(raw) }
}

const parseHealthJson = (json) => {
  try { return JSON.parse(json || '{}') } catch { return {} }
}

export async function recordHealth(store, router, health, now = new Date().toISOString()) {
  const prev = await latestHealthRow(store, router.router_id)
  await store.t.create(TABLE.health, { router_id: router.router_id, ts: now, health_json: JSON.stringify(health) }, ACTOR)
  await store.t.update(TABLE.routers, router.id, { last_seen: now }, ACTOR)
  if (prev) {
    const settings = await effectiveSettings(store, router.router_id)
    await recordOutages(store, router, prev, { ts: now, health }, { idleHeartbeatS: settings.idle_heartbeat_interval_s })
  }
  return now
}

export async function latestHealthRow(store, routerId) {
  const [row] = await store.t.list(TABLE.health, { router_id: routerId }, { limit: 1, sort: [{ field: 'ts', dir: 'DESC' }] })
  return row ? { ts: isoOrNull(row.ts), health: parseHealthJson(row.health_json) } : null
}

export async function latestHealth(store, routerId) {
  const row = await latestHealthRow(store, routerId)
  return row ? row.health : null
}

export async function healthRows(store, routerId, { since, until }) {
  const rows = await store.t.list(
    TABLE.health,
    { router_id: routerId, ts: { $gte: since, $lte: until } },
    { limit: HEALTH_ROWS_MAX, sort: [{ field: 'ts', dir: 'DESC' }] },
  )
  return rows.map(row => ({ ts: isoOrNull(row.ts), health: parseHealthJson(row.health_json) }))
}
