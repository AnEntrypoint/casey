import crypto from 'node:crypto'
import { TABLE, ACTOR, RouterRefusal } from './portal-store.js'

export const ADMIN_WINDOW_DEFAULT_MIN = 30
export const ADMIN_WINDOW_MAX_MIN = 120
export const ADMIN_TUNNEL_PREFIX = '10.200.1.'
const TUNNEL_SLOTS = 253
const WG_KEY = /^[A-Za-z0-9+/]{43}=$/

export const validWgKey = (v) => typeof v === 'string' && WG_KEY.test(v)
const TUNNEL_IP = /^10\.200\.1\.(\d{1,3})$/

export const validTunnelIp = (v) => {
  const m = TUNNEL_IP.exec(String(v ?? ''))
  return !!m && Number(m[1]) >= 2 && Number(m[1]) < TUNNEL_SLOTS + 2
}

export function newWgKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519')
  const raw = (der) => der.subarray(der.length - 32).toString('base64')
  return {
    priv: raw(privateKey.export({ format: 'der', type: 'pkcs8' })),
    pub: raw(publicKey.export({ format: 'der', type: 'spki' })),
  }
}

export async function allocateTunnelIp(store) {
  const used = new Set([
    ...(await store.t.list(TABLE.admin, {}, { limit: 1000 })).map(r => r.tunnel_ip),
    ...(await store.t.list(TABLE.routers, {}, { limit: 1000 })).map(r => r.tunnel_ip),
  ])
  for (let n = 2; n < TUNNEL_SLOTS + 2; n++) {
    const ip = ADMIN_TUNNEL_PREFIX + n
    if (!used.has(ip)) return ip
  }
  throw new Error('no tunnel address left')
}

export function windowMinutes(v) {
  if (v === undefined || v === null || v === '') return ADMIN_WINDOW_DEFAULT_MIN
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= ADMIN_WINDOW_MAX_MIN ? n : null
}

export function windowRemainingS(row, now = Date.now()) {
  if (!row || !row.admin_until) return 0
  const left = Date.parse(row.admin_until) - now
  return Number.isFinite(left) && left > 0 ? Math.min(ADMIN_WINDOW_MAX_MIN * 60, Math.floor(left / 1000)) : 0
}

export async function adminRow(store, routerId) {
  const [row] = await store.t.list(TABLE.admin, { router_id: routerId }, { limit: 1 })
  return row || null
}

export async function ensureAdminRow(store, routerId, pub, now = new Date().toISOString()) {
  const existing = await adminRow(store, routerId)
  if (existing) {
    if (existing.wg_public_key !== pub) await store.t.update(TABLE.admin, existing.id, { wg_public_key: pub, updated_at: now }, ACTOR)
    return { ...existing, wg_public_key: pub }
  }
  const [router] = await store.t.list(TABLE.routers, { router_id: routerId }, { limit: 1 })
  const tunnelIp = router && validTunnelIp(router.tunnel_ip) ? router.tunnel_ip : await allocateTunnelIp(store)
  return store.t.create(TABLE.admin, { router_id: routerId, wg_public_key: pub, tunnel_ip: tunnelIp, admin_until: '', updated_at: now }, ACTOR)
}

export async function setAdminWindow(store, routerId, minutes, actor, now = Date.now()) {
  const row = await adminRow(store, routerId)
  if (!row) throw new RouterRefusal('the router has not checked in yet, so it has no admin key to open', 409)
  const until = new Date(now + minutes * 60e3).toISOString()
  await store.t.update(TABLE.admin, row.id, { admin_until: until, updated_at: new Date(now).toISOString() }, ACTOR)
  await store.t.create(TABLE.adminLog, { router_id: routerId, action: 'open', minutes, actor: actor.id, at: new Date(now).toISOString() }, ACTOR)
  return until
}

export async function closeAdminWindow(store, routerId, actor, now = Date.now()) {
  const row = await adminRow(store, routerId)
  if (!row) throw new RouterRefusal('the router has not checked in yet, so it has no admin key to close', 409)
  await store.t.update(TABLE.admin, row.id, { admin_until: '', updated_at: new Date(now).toISOString() }, ACTOR)
  await store.t.create(TABLE.adminLog, { router_id: routerId, action: 'close', minutes: 0, actor: actor.id, at: new Date(now).toISOString() }, ACTOR)
}

export async function adminPoll(store, routerId, pub, { endpoint, hubPub }, now = Date.now()) {
  const row = await ensureAdminRow(store, routerId, pub, new Date(now).toISOString())
  const ttl = windowRemainingS(row, now)
  const open = ttl > 0 && Boolean(endpoint) && Boolean(hubPub)
  return {
    ttl_s: open ? ttl : 0,
    endpoint: endpoint || '',
    hub_pub: hubPub || '',
    tunnel_ip: row.tunnel_ip,
    max_s: ADMIN_WINDOW_MAX_MIN * 60,
  }
}

export async function hubPeers(store) {
  const admins = await store.t.list(TABLE.admin, {}, { limit: 1000 })
  const routers = await store.t.list(TABLE.routers, {}, { limit: 1000 })
  const adminIds = new Set(admins.map(r => r.router_id))
  const fromAdmin = admins.filter(r => validWgKey(r.wg_public_key)).map(r => ({ public_key: r.wg_public_key, ip: r.tunnel_ip }))
  const provisioned = routers
    .filter(r => !adminIds.has(r.router_id) && validWgKey(r.wg_public_key) && validTunnelIp(r.tunnel_ip))
    .map(r => ({ public_key: r.wg_public_key, ip: r.tunnel_ip }))
  return [...fromAdmin, ...provisioned]
}

export function hubTokenOk(raw, expected) {
  if (!expected || typeof raw !== 'string') return false
  const a = Buffer.from(raw)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
