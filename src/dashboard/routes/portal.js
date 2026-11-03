import { mountRoutes } from './register.js'
import * as portal from '../../portal/portal-store.js'

const BAD_MAC = 'mac must be AA:BB:CC:DD:EE:FF'
const RATE_WINDOW_MS = 60e3
const RATE_KEYS_MAX = 10000

export function makeRateLimit(max, windowMs = RATE_WINDOW_MS) {
  const buckets = new Map()
  return function hit(key, now = Date.now()) {
    if (buckets.size > RATE_KEYS_MAX) for (const [k, b] of buckets) if (now - b.start >= windowMs) buckets.delete(k)
    let b = buckets.get(key)
    if (!b || now - b.start >= windowMs) { b = { n: 0, start: now }; buckets.set(key, b) }
    b.n++
    return b.n > max ? Math.max(1, Math.ceil((b.start + windowMs - now) / 1000)) : 0
  }
}

const setCors = (res) => {
  res.set('Access-Control-Allow-Origin', '*')
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.set('Access-Control-Allow-Headers', 'Content-Type')
  res.set('Access-Control-Max-Age', '600')
}

const bearer = (req) => {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.get('authorization') || '').trim())
  return m ? m[1].trim() : ''
}

async function routerFromBearer(store, req, res) {
  const router = await portal.findRouterByToken(store, bearer(req))
  if (!router) { res.status(401).json({ error: 'unauthorized' }); return null }
  return router
}

export function preflightPortalRegister() {
  return (req, res) => {
    setCors(res)
    res.status(204).end()
  }
}

export function postPortalRegister({ store }) {
  const ipLimit = makeRateLimit(Number(process.env.CASEY_PORTAL_RATE_IP) || 120)
  const macLimit = makeRateLimit(Number(process.env.CASEY_PORTAL_RATE_MAC) || 5)
  return async (req, res) => {
    setCors(res)
    const ipRetry = ipLimit(String(req.ip || req.socket?.remoteAddress || 'unknown'))
    if (ipRetry) { res.set('Retry-After', String(ipRetry)); return res.status(429).json({ error: 'rate limited', retry_after_s: ipRetry }) }
    const b = req.body || {}
    const mac = portal.normaliseMac(b.mac)
    if (!portal.isE164(b.phone)) return res.status(400).json({ error: 'phone must be E.164, for example +27821234567' })
    if (!mac) return res.status(400).json({ error: BAD_MAC })
    if (!portal.validRouterId(b.router_id)) return res.status(400).json({ error: 'router_id is required' })
    if (b.tc_accepted !== true) return res.status(400).json({ error: 'tc_accepted must be true' })
    const macRetry = macLimit(mac)
    if (macRetry) { res.set('Retry-After', String(macRetry)); return res.status(429).json({ error: 'rate limited', retry_after_s: macRetry }) }
    const router = await portal.findRouter(store, b.router_id)
    if (!router) return res.status(400).json({ error: 'unknown router_id' })
    await portal.recordRegistration(store, { routerId: b.router_id, mac, phone: b.phone })
    res.json({ ok: true })
  }
}

export function getRouterStatus({ store }) {
  return async (req, res) => {
    const router = await routerFromBearer(store, req, res)
    if (!router) return
    const mac = portal.normaliseMac(req.query?.mac)
    if (!mac) return res.status(400).json({ error: BAD_MAC })
    res.json(await portal.routerStatus(store, router.router_id, mac))
  }
}

export function postRouterEvents({ store }) {
  return async (req, res) => {
    const router = await routerFromBearer(store, req, res)
    if (!router) return
    const b = req.body || {}
    if (b.router_id !== router.router_id) return res.status(403).json({ error: 'router_id does not match the token' })
    const parsed = portal.parseEvents(b.events)
    if (parsed.error) return res.status(400).json({ error: parsed.error })
    const accepted = await portal.recordEvents(store, router, parsed.events)
    res.status(202).json({ ok: true, accepted })
  }
}

export function getRouters({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    if (req.caseyAccount?.role !== 'admin') return res.status(403).json({ error: 'This is not available for your login.', code: 'role_forbidden' })
    res.json({ routers: await portal.routerOverview(store), generated_at: new Date().toISOString() })
  }
}

const ROUTES = [
  ['options', '/api/portal/register', preflightPortalRegister, { raw: true }],
  ['post', '/api/portal/register', postPortalRegister],
  ['get', '/api/router/status', getRouterStatus],
  ['post', '/api/router/events', postRouterEvents],
  ['get', '/api/routers', getRouters],
]

export function registerPortal(app, deps) {
  mountRoutes(app, deps, ROUTES)
}
