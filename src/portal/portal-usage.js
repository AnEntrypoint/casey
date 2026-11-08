import { TABLE, ACTOR, isoOrNull, normaliseMac, validRouterId } from './portal-store.js'

export const DAY_MS = 24 * 3600e3
export const USAGE_SAMPLES_MAX = 500
export const USAGE_ROWS_MAX = 50000
export const BUCKETS = Object.freeze(['hour', 'day'])
const SAMPLE_EPOCH_MAX_CHARS = 64
const SAMPLE_IP_MAX_CHARS = 64

const isCounter = (value) => Number.isSafeInteger(value) && value >= 0

export function parseUsageSamples(samples) {
  if (!Array.isArray(samples)) return { error: 'samples must be an array', field: 'samples' }
  const out = []
  for (const sample of samples) {
    if (!sample || typeof sample !== 'object' || Array.isArray(sample)) return { error: 'each sample must be an object', field: 'samples' }
    const mac = normaliseMac(sample.mac)
    if (!mac) return { error: 'mac must be AA:BB:CC:DD:EE:FF', field: 'mac' }
    if (!isCounter(sample.up_bytes) || !isCounter(sample.down_bytes)) return { error: 'up_bytes and down_bytes must be non-negative integers', field: 'up_bytes' }
    const epoch = typeof sample.epoch === 'string' ? sample.epoch.trim().slice(0, SAMPLE_EPOCH_MAX_CHARS) : ''
    if (!epoch) return { error: 'epoch is required', field: 'epoch' }
    const ip = typeof sample.ip === 'string' ? sample.ip.slice(0, SAMPLE_IP_MAX_CHARS) : ''
    out.push({ mac, ip, epoch, up_bytes: sample.up_bytes, down_bytes: sample.down_bytes })
  }
  return { samples: out }
}

export async function ingestUsage(store, router, samples, now = Date.now()) {
  for (const [index, sample] of samples.entries()) {
    await store.t.create(TABLE.usage, {
      router_id: router.router_id,
      mac: sample.mac,
      ip: sample.ip,
      epoch: sample.epoch,
      up_bytes: sample.up_bytes,
      down_bytes: sample.down_bytes,
      received_at: new Date(now + index).toISOString(),
    }, ACTOR)
  }
  if (samples.length) await store.t.update(TABLE.routers, router.id, { last_seen: new Date(now).toISOString() }, ACTOR)
  return samples.length
}

export function parseWindow(query = {}, now = Date.now()) {
  const hasValue = (value) => value !== undefined && value !== null && value !== ''
  const until = hasValue(query.until) ? isoOrNull(query.until) : new Date(now).toISOString()
  if (!until) return { error: 'until must be ISO 8601', field: 'until' }
  const since = hasValue(query.since) ? isoOrNull(query.since) : new Date(Date.parse(until) - DAY_MS).toISOString()
  if (!since) return { error: 'since must be ISO 8601', field: 'since' }
  if (Date.parse(since) >= Date.parse(until)) return { error: 'since must be before until', field: 'since' }
  return { since, until }
}

export function parseUsageFilter(query = {}) {
  const routerId = query.router_id === undefined || query.router_id === '' ? null : query.router_id
  if (routerId !== null && !validRouterId(routerId)) return { error: 'router_id is not valid', field: 'router_id' }
  const mac = query.mac === undefined || query.mac === '' ? null : normaliseMac(query.mac)
  if (query.mac !== undefined && query.mac !== '' && !mac) return { error: 'mac must be AA:BB:CC:DD:EE:FF', field: 'mac' }
  return { routerId, mac }
}

export const bucketStart = (iso, bucket) => {
  const at = new Date(Date.parse(iso))
  if (bucket === 'day') at.setUTCHours(0, 0, 0, 0)
  else at.setUTCMinutes(0, 0, 0)
  return at.toISOString()
}

const groupKey = (row) => `${row.router_id}|${row.mac}`

const counterDelta = (previous, current, field) => {
  const now = Number(current[field])
  if (!previous || previous.epoch !== current.epoch) return now
  const before = Number(previous[field])
  return now < before ? now : now - before
}

export function attributeDeltas(rows, baselines = new Map()) {
  const previous = new Map(baselines)
  return rows.map(row => {
    const key = groupKey(row)
    const before = previous.get(key) ?? null
    previous.set(key, row)
    return { row, up: counterDelta(before, row, 'up_bytes'), down: counterDelta(before, row, 'down_bytes') }
  })
}

export function bucketSeries(deltas, bucket) {
  const buckets = new Map()
  for (const { row, up, down } of deltas) {
    const t = bucketStart(row.received_at, bucket)
    const key = `${t}|${row.router_id}|${row.mac}`
    const entry = buckets.get(key) ?? { t, mac: row.mac, router_id: row.router_id, up_bytes: 0, down_bytes: 0 }
    entry.up_bytes += up
    entry.down_bytes += down
    buckets.set(key, entry)
  }
  return [...buckets.values()].sort((a, b) =>
    a.t.localeCompare(b.t) || a.router_id.localeCompare(b.router_id) || a.mac.localeCompare(b.mac))
}

export function deviceTotals(deltas) {
  const devices = new Map()
  for (const { row, up, down } of deltas) {
    const key = groupKey(row)
    const seen = isoOrNull(row.received_at)
    const device = devices.get(key) ?? { mac: row.mac, router_id: row.router_id, first_seen: seen, last_seen: seen, up_bytes: 0, down_bytes: 0 }
    device.first_seen = seen < device.first_seen ? seen : device.first_seen
    device.last_seen = seen > device.last_seen ? seen : device.last_seen
    device.up_bytes += up
    device.down_bytes += down
    devices.set(key, device)
  }
  return [...devices.values()].sort((a, b) => a.router_id.localeCompare(b.router_id) || a.mac.localeCompare(b.mac))
}

async function baselinesBefore(store, rows, since) {
  const baselines = new Map()
  const groups = new Map(rows.map(row => [groupKey(row), row]))
  for (const [key, sample] of groups) {
    const [prior] = await store.t.list(TABLE.usage, { router_id: sample.router_id, mac: sample.mac, received_at: { $lt: since } }, { limit: 1, sort: [{ field: 'received_at', dir: 'DESC' }] })
    if (prior) baselines.set(key, prior)
  }
  return baselines
}

export async function usageDeltas(store, { routerId = null, mac = null, since, until }) {
  const where = { received_at: { $gte: since, $lte: until } }
  if (routerId) where.router_id = routerId
  if (mac) where.mac = mac
  const rows = await store.t.list(TABLE.usage, where, { limit: USAGE_ROWS_MAX, sort: [{ field: 'received_at', dir: 'ASC' }] })
  const baselines = await baselinesBefore(store, rows, since)
  return attributeDeltas(rows, baselines)
}

export async function usageReport(store, { routerId = null, mac = null, since, until, bucket = 'hour' }) {
  const deltas = await usageDeltas(store, { routerId, mac, since, until })
  return { series: bucketSeries(deltas, bucket), devices: deviceTotals(deltas) }
}

export async function registeredPhone(store, routerId, mac) {
  const [registration] = await store.t.list(TABLE.registrations, { router_id: routerId, mac }, { limit: 1, sort: [{ field: 'registered_at', dir: 'DESC' }] })
  return registration?.phone_e164 || null
}
