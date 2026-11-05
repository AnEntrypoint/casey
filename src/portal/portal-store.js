import crypto from 'node:crypto'

export const TABLE = Object.freeze({
  routers: 'routers',
  registrations: 'portal_registrations',
  contacts: 'portal_contacts',
  events: 'router_events',
  settings: 'router_settings',
  health: 'router_health',
  usage: 'router_usage',
  admin: 'router_admin',
  adminLog: 'router_admin_log',
})

export const EVENT_TYPES = Object.freeze(['login', 'check_pass', 'cutoff', 'block', 'heartbeat', 'other'])

export const EVENT_BATCH_MAX = 200
export const EVENT_DETAIL_MAX_CHARS = 4000
export const RECENT_EVENTS = 20
const DAY_MS = 24 * 3600e3
export const ACTOR = Object.freeze({ id: 'casey-portal', role: 'agent' })
const E164 = /^\+[1-9]\d{7,14}$/
const MAC = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/
const ROUTER_ID = /^(?!_)[A-Za-z0-9_-]{1,64}$/

export const isE164 = (v) => typeof v === 'string' && E164.test(v)
export const validRouterId = (v) => typeof v === 'string' && ROUTER_ID.test(v)

export function normaliseMac(v) {
  if (typeof v !== 'string') return null
  const m = v.trim().toUpperCase()
  return MAC.test(m) ? m : null
}

export function isoOrNull(v) {
  if (v == null || v === '') return null
  const t = typeof v === 'number' ? v : Date.parse(String(v))
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

export function e164FromWhatsapp(from) {
  const digits = String(from ?? '').replace(/\D/g, '')
  const phone = digits ? '+' + digits : ''
  return isE164(phone) ? phone : null
}

export function normalisePhone(v) {
  if (typeof v !== 'string') return null
  const s = v.replace(/[\s\-()]/g, '')
  const e164 = /^0\d{9}$/.test(s) ? '+27' + s.slice(1) : s
  return isE164(e164) ? e164 : null
}

export function waTimestampIso(raw) {
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null
}

export const hashToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex')
export const newToken = () => crypto.randomBytes(32).toString('base64url')
export const newRouterId = () => 'rtr-' + crypto.randomBytes(6).toString('hex')

export async function createRouter(store, { name, routerId = newRouterId() }) {
  const label = String(name || '').trim().slice(0, 120)
  if (!label) throw new Error('name is required')
  if (!validRouterId(routerId)) throw new Error('router_id may hold only letters, digits, - and _ (max 64)')
  const [dup] = await store.t.list(TABLE.routers, { router_id: routerId }, { limit: 1 })
  if (dup) throw new Error(`router_id ${routerId} already exists`)
  const token = newToken()
  const row = await store.t.create(TABLE.routers, {
    router_id: routerId, token_hash: hashToken(token), name: label, last_seen: '', created_at: new Date().toISOString(),
  }, ACTOR)
  return { row, token }
}

export async function findRouterByToken(store, raw) {
  if (typeof raw !== 'string' || !raw) return null
  const [row] = await store.t.list(TABLE.routers, { token_hash: hashToken(raw) }, { limit: 1 })
  return row || null
}

export async function findRouter(store, routerId) {
  const [row] = await store.t.list(TABLE.routers, { router_id: routerId }, { limit: 1 })
  return row || null
}

export function parseEvents(events) {
  if (!Array.isArray(events)) return { error: 'events must be an array' }
  if (events.length > EVENT_BATCH_MAX) return { error: `at most ${EVENT_BATCH_MAX} events per request` }
  const out = []
  for (const e of events) {
    if (!e || typeof e !== 'object') return { error: 'each event must be an object' }
    const ts = isoOrNull(e.ts)
    if (!ts) return { error: 'each event needs a valid ts (ISO 8601)' }
    if (!EVENT_TYPES.includes(e.type)) return { error: `type must be one of ${EVENT_TYPES.join(', ')}` }
    const mac = e.mac == null || e.mac === '' ? '' : normaliseMac(e.mac)
    if (mac === null) return { error: 'mac must be AA:BB:CC:DD:EE:FF when given' }
    const detail = e.detail == null ? {} : e.detail
    if (typeof detail !== 'object' || Array.isArray(detail)) return { error: 'detail must be a JSON object' }
    const json = JSON.stringify(detail)
    if (json.length > EVENT_DETAIL_MAX_CHARS) return { error: `detail must be at most ${EVENT_DETAIL_MAX_CHARS} characters` }
    out.push({ ts, type: e.type, mac, detail: json })
  }
  return { events: out }
}

export async function recordEvents(store, router, events, now = new Date().toISOString()) {
  for (const e of events) {
    await store.t.create(TABLE.events, { router_id: router.router_id, ts: e.ts, type: e.type, mac: e.mac, detail: e.detail, received_at: now }, ACTOR)
  }
  await store.t.update(TABLE.routers, router.id, { last_seen: now }, ACTOR)
  return events.length
}

export async function recordRegistration(store, { routerId, mac, phone }, now = new Date().toISOString()) {
  return store.t.create(TABLE.registrations, { router_id: routerId, mac, phone_e164: phone, tc_accepted: '1', registered_at: now }, ACTOR)
}

export async function upsertContact(store, phone, at) {
  const [row] = await store.t.list(TABLE.contacts, { phone_e164: phone }, { limit: 1 })
  if (row) return store.t.update(TABLE.contacts, row.id, { last_contact_at: at }, ACTOR)
  return store.t.create(TABLE.contacts, { phone_e164: phone, first_contact_at: at, last_contact_at: at }, ACTOR)
}

export async function recordInboundContact(store, event, now = new Date().toISOString()) {
  const phone = e164FromWhatsapp(event?.from)
  if (!phone) return null
  const at = waTimestampIso(event?.raw?.timestamp) || now
  return upsertContact(store, phone, at)
}

export async function routerStatus(store, routerId, mac) {
  const [reg] = await store.t.list(TABLE.registrations, { router_id: routerId, mac }, { limit: 1, sort: [{ field: 'registered_at', dir: 'DESC' }] })
  if (!reg) return { registered: false, phone_known: false, contacted: false, contacted_at: null }
  const [contact] = await store.t.list(TABLE.contacts, { phone_e164: reg.phone_e164 }, { limit: 1 })
  const lastAt = isoOrNull(contact?.last_contact_at)
  const contacted = !!lastAt && Date.parse(lastAt) >= Date.parse(reg.registered_at)
  return { registered: true, phone_known: !!contact, contacted, contacted_at: contacted ? lastAt : null }
}

function parseDetail(json) {
  try { return JSON.parse(json || '{}') } catch { return {} }
}

export async function listRouters(store) {
  return store.t.list(TABLE.routers, {}, { limit: 500, sort: [{ field: 'created_at', dir: 'ASC' }] })
}

export async function routerOverview(store, now = Date.now()) {
  const routers = await store.t.list(TABLE.routers, {}, { limit: 500, sort: [{ field: 'created_at', dir: 'ASC' }] })
  const since = new Date(now - DAY_MS).toISOString()
  return Promise.all(routers.map(async (r) => {
    const recent = await store.t.list(TABLE.events, { router_id: r.router_id }, { limit: RECENT_EVENTS, sort: [{ field: 'ts', dir: 'DESC' }] })
    const [hb] = await store.t.list(TABLE.events, { router_id: r.router_id, type: 'heartbeat' }, { limit: 1, sort: [{ field: 'ts', dir: 'DESC' }] })
    const cutoffs = await store.t.list(TABLE.events, { router_id: r.router_id, type: 'cutoff', ts: { $gte: since } }, { limit: 10000 })
    const active = hb ? Number(parseDetail(hb.detail).active_clients) : NaN
    return {
      router_id: r.router_id,
      name: r.name,
      last_seen: isoOrNull(r.last_seen),
      active_clients: Number.isFinite(active) ? active : null,
      active_clients_at: hb ? isoOrNull(hb.ts) : null,
      cutoffs_24h: cutoffs.length,
      recent_events: recent.map(e => ({ ts: isoOrNull(e.ts), type: e.type, mac: e.mac || null, detail: parseDetail(e.detail) })),
    }
  }))
}
