import { unpack } from 'msgpackr'
import { ACTOR, TABLE, normaliseMac, parseEvents, recordEvents, routerStatus } from './portal-store.js'
import { parseHealth, recordHealth, latestHealth } from './portal-health.js'
import { parseUsageSamples, ingestUsage, USAGE_SAMPLES_MAX } from './portal-usage.js'
import { validWgKey } from './portal-admin.js'

export const CYCLE_EVENTS_MAX = 200
export const STATUS_BATCH_MAX = 50
const HEALTH_POSITIONS = ['uptime_s', 'version', 'board', 'cpu_load_pct', 'free_mem_bytes', 'total_mem_bytes', 'temperature_c',
  'active_clients', 'registered_devices', 'bypassed_devices', 'wifi', 'ether', 'lte', 'dhcp_leases', 'wan', 'config_version', 'log_errors']
const HEALTH_MIN_ITEMS = 16

const isArray = Array.isArray
const fail = (error, field) => ({ error, field })

const isPlainObject = (value) => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))

export function decodeBody(body) {
  if (!Buffer.isBuffer(body)) return isPlainObject(body) ? body : {}
  try {
    const value = unpack(body)
    return isPlainObject(value) ? value : null
  } catch {
    return null
  }
}

export function healthFromCycle(h) {
  if (!isArray(h) || h.length < HEALTH_MIN_ITEMS) return fail('h must be an array of at least 16 items', 'h')
  const raw = {}
  HEALTH_POSITIONS.forEach((key, i) => { if (h[i] !== undefined && h[i] !== null) raw[key] = h[i] })
  try {
    if (isArray(h[10])) raw.wifi = h[10].map(([name, running, clients]) => ({ name, running: running === 1, clients }))
    if (isArray(h[11])) raw.ether = h[11].map(([name, running]) => ({ name, running: running === 1 }))
    if (h[12] !== undefined) raw.lte = { running: h[12] === 1 }
    if (isArray(h[14])) raw.wan = { interface: 'wifi1', address: h[14][0], up: h[14][1] === 1 }
  } catch { return fail('h has a malformed nested item', 'h') }
  if (!isArray(h[16])) delete raw.log_errors
  return parseHealth(raw)
}

export function parseCycle(body) {
  if (!body || typeof body !== 'object' || isArray(body)) return fail('body must be an object', 'body')
  if (body.v !== 2) return fail('v must be 2', 'v')
  if (typeof body.r !== 'string' || !body.r) return fail('r is required', 'r')
  const cv = body.cv === undefined ? '' : body.cv
  if (typeof cv !== 'string' || cv.length > 64) return fail('cv must be a short string', 'cv')
  const rows = body.u === undefined ? [] : body.u
  if (!isArray(rows)) return fail('u must be an array', 'u')
  if (rows.length > USAGE_SAMPLES_MAX) return { ...fail(`at most ${USAGE_SAMPLES_MAX} usage entries`, 'u'), tooLarge: true }
  if (!rows.every((row) => isArray(row) && row.length === 5)) return fail('each u entry is [mac, ip, up_bytes, down_bytes, epoch]', 'u')
  const usage = parseUsageSamples(rows.map(([mac, ip, up_bytes, down_bytes, epoch]) => ({ mac, ip, up_bytes, down_bytes, epoch })))
  if (usage.error) return fail(usage.error, usage.field)
  let health
  if (body.h !== undefined) {
    const shaped = healthFromCycle(body.h)
    if (shaped.error) return fail(shaped.error, shaped.field)
    health = shaped.health
  }
  let pub
  if (body.p !== undefined) {
    if (!validWgKey(body.p)) return fail('p must be a WireGuard public key', 'p')
    pub = body.p
  }
  let sync = null
  if (body.q !== undefined) {
    if (!isArray(body.q) || body.q.length !== 3) return fail('q must be [since, resume_ok, tls_path]', 'q')
    const [since, resumeOk, tlsPath] = body.q
    if (since !== '' && (typeof since !== 'string' || since.length > 40 || !Number.isFinite(Date.parse(since)))) return fail('q since must be an ISO time or empty', 'q')
    if (typeof resumeOk !== 'boolean') return fail('q resume_ok must be a boolean', 'q')
    if (tlsPath !== 'full' && tlsPath !== 'resume') return fail('q tls_path must be full or resume', 'q')
    sync = { since: since || null, resumeOk, tlsPath }
  }
  const eventRows = body.e === undefined ? [] : body.e
  if (!isArray(eventRows)) return fail('e must be an array', 'e')
  if (eventRows.length > CYCLE_EVENTS_MAX) return { ...fail(`at most ${CYCLE_EVENTS_MAX} events per request`, 'e'), tooLarge: true }
  const events = []
  for (const row of eventRows) {
    if (!isArray(row) || row.length !== 4) return fail('each e entry is [ts, type, mac, detail]', 'e')
    const [ts, type, mac, detail] = row
    let parsedDetail = {}
    if (typeof detail === 'string' && detail.length) {
      try { parsedDetail = JSON.parse(detail) } catch { return fail('event detail must be JSON', 'e') }
    }
    events.push({ ts, type, mac: typeof mac === 'string' ? mac : '', detail: parsedDetail })
  }
  const checkedEvents = parseEvents(events)
  if (checkedEvents.error) return fail(checkedEvents.error, 'e')
  return { cycle: { cv, samples: usage.samples, health, events: checkedEvents.events, pub, sync } }
}

export async function applyCycle(store, router, cycle, now = new Date().toISOString()) {
  if (cycle.sync) await store.t.update(TABLE.routers, router.id, { resume_ok: cycle.sync.resumeOk, tls_path: cycle.sync.tlsPath }, ACTOR)
  const usage = await ingestUsage(store, router, cycle.samples)
  const events = cycle.events.length ? await recordEvents(store, router, cycle.events, now) : 0
  let heartbeat = false
  if (cycle.health) {
    if (cycle.health.log_errors === undefined) {
      const previous = await latestHealth(store, router.router_id)
      if (previous && previous.log_errors !== undefined) cycle.health.log_errors = previous.log_errors
    }
    await recordHealth(store, router, cycle.health, now)
    heartbeat = true
  }
  return { usage, events, heartbeat }
}

export function parseStatusBatch(body) {
  if (!body || typeof body !== 'object' || isArray(body)) return fail('body must be an object', 'body')
  if (typeof body.r !== 'string' || !body.r) return fail('r is required', 'r')
  if (!isArray(body.m)) return fail('m must be an array of MACs', 'm')
  if (body.m.length > STATUS_BATCH_MAX) return fail(`at most ${STATUS_BATCH_MAX} MACs per request`, 'm')
  const macs = body.m.map((mac) => normaliseMac(mac))
  if (macs.some((mac) => !mac)) return fail('mac must be AA:BB:CC:DD:EE:FF', 'm')
  return { macs: [...new Set(macs)] }
}

export async function statusBatch(store, routerId, macs) {
  const out = {}
  for (const mac of macs) {
    const status = await routerStatus(store, routerId, mac)
    out[mac] = [status.registered ? 1 : 0, status.contacted ? 1 : 0]
  }
  return out
}
