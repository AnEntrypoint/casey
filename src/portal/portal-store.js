import { COUNTRY_CODE, TRUNK_PREFIX, LOCAL_NUMBER_RE } from '../locale.js'
import crypto from 'node:crypto'
import { ROUTER_STATUS_DEFAULT_HEARTBEAT_S, ROUTER_STATUS_DEFAULT_GRACE_S, routerLiveness } from '../dashboard/public/src/router-status.js'
import { caseyText } from '../deployment-text.js';

export const TABLE = Object.freeze({
  routers: 'routers',
  registrations: 'portal_registrations',
  contacts: 'portal_contacts',
  events: 'router_events',
  settings: 'router_settings',
  health: 'router_health',
  outages: 'router_outages',
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
const SERIAL = /^[A-Z0-9]{6,20}$/
const SSID = /^[\x20-\x7e]{1,32}$/
const PASSPHRASE = /^[\x20-\x7e]{8,63}$/
export const SITE_MAX = 120
export const DEFAULT_IDLE_HEARTBEAT_S = ROUTER_STATUS_DEFAULT_HEARTBEAT_S

export class RouterRefusal extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'RouterRefusal'
    this.status = status
  }
}

const refuse = (message, status = 409) => { throw new RouterRefusal(message, status) }

export const isE164 = (v) => typeof v === 'string' && E164.test(v)
export const validRouterId = (v) => typeof v === 'string' && ROUTER_ID.test(v)
export const validSsid = (v) => typeof v === 'string' && SSID.test(v)
export const validPassphrase = (v) => typeof v === 'string' && PASSPHRASE.test(v)

export function normaliseSerial(v) {
  if (typeof v !== 'string') return null
  const s = v.trim().toUpperCase()
  return SERIAL.test(s) ? s : null
}

export function liveness(lastSeen, now = Date.now(), idleHeartbeatS = DEFAULT_IDLE_HEARTBEAT_S, graceS = ROUTER_STATUS_DEFAULT_GRACE_S) {
  const seen = typeof lastSeen === 'string' && lastSeen ? Date.parse(lastSeen) : NaN
  return routerLiveness(seen, now, idleHeartbeatS, graceS)
}

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
  const e164 = LOCAL_NUMBER_RE && LOCAL_NUMBER_RE.test(s) ? '+' + COUNTRY_CODE + s.slice(TRUNK_PREFIX.length) : s
  return isE164(e164) ? e164 : null
}

export function waTimestampIso(raw) {
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null
}

export const hashToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex')
export const newToken = () => crypto.randomBytes(32).toString('base64url')
export const newRouterId = (prefix) => {
  if (typeof prefix !== 'string' || !prefix) throw new Error('router_id prefix is not configured (router-bundle.yml router_id_prefix)')
  return prefix + crypto.randomBytes(6).toString('hex')
}

export async function createRouter(store, { name, routerId, routerIdPrefix, site = '', uplinkSsid = '', wgPublicKey = '', tunnelIp = '' }) {
  const label = String(name || '').trim().slice(0, 120)
  if (!label) refuse(caseyText("src/portal/portal-store.js#w0"), 400)
  const id = routerId ?? newRouterId(routerIdPrefix)
  if (!validRouterId(id)) refuse(caseyText("src/portal/portal-store.js#w1"), 400)
  const [dup] = await store.t.list(TABLE.routers, { router_id: id }, { limit: 1 })
  if (dup) refuse(caseyText("src/portal/portal-store.js#w2", [id]))
  const token = newToken()
  const row = await store.t.create(TABLE.routers, {
    router_id: id, token_hash: hashToken(token), name: label, site: String(site).trim().slice(0, SITE_MAX),
    uplink_ssid: uplinkSsid, serial: '', serial_at: '', wg_public_key: wgPublicKey, tunnel_ip: tunnelIp,
    last_seen: '', created_at: new Date().toISOString(),
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

export async function rotateRouterToken(store, routerId, now = new Date().toISOString()) {
  const row = await findRouter(store, routerId)
  if (!row) refuse(caseyText("src/portal/portal-store.js#w3", [routerId]), 404)
  const token = newToken()
  await store.t.update(TABLE.routers, row.id, { token_hash: hashToken(token), updated_at: now }, ACTOR, { expectedVersion: row._version })
  return { token, router_id: routerId }
}

export function parseEvents(events) {
  if (!Array.isArray(events)) return { error: caseyText("src/portal/portal-store.js#w4") }
  if (events.length > EVENT_BATCH_MAX) return { error: caseyText("src/portal/portal-store.js#w5", [EVENT_BATCH_MAX]) }
  const out = []
  for (const e of events) {
    if (!e || typeof e !== 'object') return { error: caseyText("src/portal/portal-store.js#w6") }
    const ts = isoOrNull(e.ts)
    if (!ts) return { error: caseyText("src/portal/portal-store.js#w7") }
    if (!EVENT_TYPES.includes(e.type)) return { error: caseyText("src/portal/portal-store.js#w8", [EVENT_TYPES.join(', ')]) }
    const mac = e.mac == null || e.mac === '' ? '' : normaliseMac(e.mac)
    if (mac === null) return { error: caseyText("src/portal/portal-store.js#w9") }
    const detail = e.detail == null ? {} : e.detail
    if (typeof detail !== 'object' || Array.isArray(detail)) return { error: caseyText("src/portal/portal-store.js#w10") }
    const json = JSON.stringify(detail)
    if (json.length > EVENT_DETAIL_MAX_CHARS) return { error: caseyText("src/portal/portal-store.js#w11", [EVENT_DETAIL_MAX_CHARS]) }
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

export async function recordSerial(store, router, serialRaw, now = new Date().toISOString()) {
  const serial = normaliseSerial(serialRaw)
  if (!serial) refuse(caseyText("src/portal/portal-store.js#w12"), 400)
  if (router.last_seen && router.serial && router.serial !== serial) refuse(caseyText("src/portal/portal-store.js#w13"))
  const holders = await store.t.list(TABLE.routers, { serial }, { limit: 5 })
  if (holders.some(r => r.router_id !== router.router_id)) refuse(caseyText("src/portal/portal-store.js#w14"))
  await store.t.update(TABLE.routers, router.id, { serial, serial_at: now, last_seen: now }, ACTOR)
  return { router_id: router.router_id, serial }
}

export async function setRouterUplink(store, routerId, { site, uplinkSsid }, now = new Date().toISOString()) {
  const row = await findRouter(store, routerId)
  if (!row) refuse(caseyText("src/portal/portal-store.js#w15", [routerId]), 404)
  const label = String(site ?? '').trim()
  if (!label || label.length > SITE_MAX) refuse(caseyText("src/portal/portal-store.js#w16", [SITE_MAX]), 400)
  if (!validSsid(uplinkSsid)) refuse(caseyText("src/portal/portal-store.js#w17"), 400)
  await store.t.update(TABLE.routers, row.id, { site: label, uplink_ssid: uplinkSsid, updated_at: now }, ACTOR, { expectedVersion: row._version })
  return { router_id: routerId, site: label, uplink_ssid: uplinkSsid }
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

export async function routerOverview(store, now = Date.now(), settingsFor = async () => ({ idle_heartbeat_interval_s: DEFAULT_IDLE_HEARTBEAT_S, router_status_grace_s: ROUTER_STATUS_DEFAULT_GRACE_S })) {
  const routers = await store.t.list(TABLE.routers, {}, { limit: 500, sort: [{ field: 'created_at', dir: 'ASC' }] })
  const since = new Date(now - DAY_MS).toISOString()
  return Promise.all(routers.map(async (r) => {
    const { idle_heartbeat_interval_s: idleHeartbeatS, router_status_grace_s: graceS } = await settingsFor(r.router_id)
    const recent = await store.t.list(TABLE.events, { router_id: r.router_id }, { limit: RECENT_EVENTS, sort: [{ field: 'ts', dir: 'DESC' }] })
    const [hb] = await store.t.list(TABLE.events, { router_id: r.router_id, type: 'heartbeat' }, { limit: 1, sort: [{ field: 'ts', dir: 'DESC' }] })
    const cutoffs = await store.t.list(TABLE.events, { router_id: r.router_id, type: 'cutoff', ts: { $gte: since } }, { limit: 10000 })
    const active = hb ? Number(parseDetail(hb.detail).active_clients) : NaN
    return {
      router_id: r.router_id,
      name: r.name,
      site: r.site || '',
      serial: r.serial || '',
      uplink_ssid: r.uplink_ssid || '',
      status: liveness(r.last_seen, now, idleHeartbeatS, graceS),
      idle_heartbeat_s: idleHeartbeatS,
      status_grace_s: graceS,
      last_seen: isoOrNull(r.last_seen),
      active_clients: Number.isFinite(active) ? active : null,
      active_clients_at: hb ? isoOrNull(hb.ts) : null,
      cutoffs_24h: cutoffs.length,
      recent_events: recent.map(e => ({ ts: isoOrNull(e.ts), type: e.type, mac: e.mac || null, detail: parseDetail(e.detail) })),
    }
  }))
}

export async function deleteRouter(store, routerId) {
  const row = await findRouter(store, routerId)
  if (!row) refuse(caseyText("src/portal/portal-store.js#w18") + routerId, 404)
  if (row.last_seen || row.serial) refuse('router_id ' + routerId + caseyText("src/portal/portal-store.js#w19"))
  for (const table of [TABLE.admin, TABLE.adminLog, TABLE.health, TABLE.outages, TABLE.events, TABLE.usage, TABLE.settings]) {
    const [used] = await store.t.list(table, { router_id: routerId }, { limit: 1 })
    if (used) refuse('router_id ' + routerId + caseyText("src/portal/portal-store.js#w20") + table + caseyText("src/portal/portal-store.js#w21"))
  }
  await store.t.delete(TABLE.routers, row.id)
  return { router_id: routerId, name: row.name }
}
