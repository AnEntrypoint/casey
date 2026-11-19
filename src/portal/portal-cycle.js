import { unpack } from 'msgpackr'
import { ACTOR, TABLE, normaliseMac, parseEvents, recordEvents, routerStatus } from './portal-store.js'
import { parseHealth, recordHealth, latestHealth } from './portal-health.js'
import { parseUsageSamples, ingestUsage, USAGE_SAMPLES_MAX } from './portal-usage.js'
import { validWgKey } from './portal-admin.js'
import { caseyText } from '../deployment-text.js';

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

const LTE_NUMBER_FIELDS = Object.freeze(['rssi_dbm', 'rsrp_dbm', 'rsrq_db', 'sinr_db'])
const LTE_TEXT_FIELDS = Object.freeze(['registration', 'access_technology', 'operator'])

export function lteFromCycle(a) {
  const lte = { running: a[0] === 1 }
  LTE_NUMBER_FIELDS.forEach((key, i) => {
    const n = Number(a[i + 1])
    if (a[i + 1] !== undefined && a[i + 1] !== '' && Number.isFinite(n)) lte[key] = n
  })
  LTE_TEXT_FIELDS.forEach((key, i) => {
    const v = a[i + 1 + LTE_NUMBER_FIELDS.length]
    if (typeof v === 'string' && v !== '') lte[key] = v.slice(0, 64)
  })
  return lte
}

export function healthFromCycle(h) {
  if (!isArray(h) || h.length < HEALTH_MIN_ITEMS) return fail(caseyText("src/portal/portal-cycle.js#w0"), 'h')
  const raw = {}
  HEALTH_POSITIONS.forEach((key, i) => { if (h[i] !== undefined && h[i] !== null) raw[key] = h[i] })
  try {
    if (isArray(h[10])) raw.wifi = h[10].map(([name, running, clients]) => ({ name, running: running === 1, clients }))
    if (isArray(h[11])) raw.ether = h[11].map(([name, running]) => ({ name, running: running === 1 }))
    if (isArray(h[12])) raw.lte = lteFromCycle(h[12])
    else if (h[12] !== undefined) raw.lte = { running: h[12] === 1 }
    if (isArray(h[14])) raw.wan = { interface: 'wifi1', address: h[14][0], up: h[14][1] === 1 }
  } catch { return fail(caseyText("src/portal/portal-cycle.js#w1"), 'h') }
  if (!isArray(h[16])) delete raw.log_errors
  return parseHealth(raw)
}

export function parseCycle(body) {
  if (!body || typeof body !== 'object' || isArray(body)) return fail(caseyText("src/portal/portal-cycle.js#w2"), 'body')
  if (body.v !== 2) return fail(caseyText("src/portal/portal-cycle.js#w3"), 'v')
  if (typeof body.r !== 'string' || !body.r) return fail(caseyText("src/portal/portal-cycle.js#w4"), 'r')
  const cv = body.cv === undefined ? '' : body.cv
  if (typeof cv !== 'string' || cv.length > 64) return fail(caseyText("src/portal/portal-cycle.js#w5"), 'cv')
  const rows = body.u === undefined ? [] : body.u
  if (!isArray(rows)) return fail(caseyText("src/portal/portal-cycle.js#w6"), 'u')
  if (rows.length > USAGE_SAMPLES_MAX) return { ...fail(caseyText("src/portal/portal-cycle.js#w7", [USAGE_SAMPLES_MAX]), 'u'), tooLarge: true }
  if (!rows.every((row) => isArray(row) && row.length === 5)) return fail(caseyText("src/portal/portal-cycle.js#w8"), 'u')
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
    if (!validWgKey(body.p)) return fail(caseyText("src/portal/portal-cycle.js#w9"), 'p')
    pub = body.p
  }
  let sync = null
  if (body.q !== undefined) {
    if (!isArray(body.q) || body.q.length !== 3) return fail(caseyText("src/portal/portal-cycle.js#w10"), 'q')
    const [since, resumeOk, tlsPath] = body.q
    if (since !== '' && (typeof since !== 'string' || since.length > 40 || !Number.isFinite(Date.parse(since)))) return fail(caseyText("src/portal/portal-cycle.js#w11"), 'q')
    if (typeof resumeOk !== 'boolean') return fail(caseyText("src/portal/portal-cycle.js#w12"), 'q')
    if (tlsPath !== 'full' && tlsPath !== 'resume') return fail(caseyText("src/portal/portal-cycle.js#w13"), 'q')
    sync = { since: since || null, resumeOk, tlsPath }
  }
  const eventRows = body.e === undefined ? [] : body.e
  if (!isArray(eventRows)) return fail(caseyText("src/portal/portal-cycle.js#w14"), 'e')
  if (eventRows.length > CYCLE_EVENTS_MAX) return { ...fail(caseyText("src/portal/portal-cycle.js#w15", [CYCLE_EVENTS_MAX]), 'e'), tooLarge: true }
  const events = []
  for (const row of eventRows) {
    if (!isArray(row) || row.length !== 4) return fail(caseyText("src/portal/portal-cycle.js#w16"), 'e')
    const [ts, type, mac, detail] = row
    let parsedDetail = {}
    if (typeof detail === 'string' && detail.length) {
      try { parsedDetail = JSON.parse(detail) } catch { return fail(caseyText("src/portal/portal-cycle.js#w17"), 'e') }
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
  if (!body || typeof body !== 'object' || isArray(body)) return fail(caseyText("src/portal/portal-cycle.js#w18"), 'body')
  if (typeof body.r !== 'string' || !body.r) return fail(caseyText("src/portal/portal-cycle.js#w19"), 'r')
  if (!isArray(body.m)) return fail(caseyText("src/portal/portal-cycle.js#w20"), 'm')
  if (body.m.length > STATUS_BATCH_MAX) return fail(caseyText("src/portal/portal-cycle.js#w21", [STATUS_BATCH_MAX]), 'm')
  const macs = body.m.map((mac) => normaliseMac(mac))
  if (macs.some((mac) => !mac)) return fail(caseyText("src/portal/portal-cycle.js#w22"), 'm')
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
