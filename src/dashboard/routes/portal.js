import { mountRoutes } from './register.js'
import * as portal from '../../portal/portal-store.js'
import * as portalSettings from '../../portal/portal-settings.js'
import { ASSET_NAMES, renderAsset } from '../../portal/portal-render.js'
import { HEARTBEAT_BYTES_MAX, parseHealth, recordHealth, healthRows, latestHealth } from '../../portal/portal-health.js'
import { DAY_MS, BUCKETS, USAGE_SAMPLES_MAX, parseUsageSamples, ingestUsage, parseWindow, parseUsageFilter, usageReport, registeredPhone } from '../../portal/portal-usage.js'
import { purgeIfDue } from '../../portal/portal-retention.js'
import { createWaPrefixSource, waPrefixesText } from '../../portal/portal-wa-prefixes.js'

const BAD_MAC = 'mac must be AA:BB:CC:DD:EE:FF'
const RATE_WINDOW_MS = 60e3
const RATE_KEYS_MAX = 10000
const ROUTER_LIST_MAX = 500
const REGISTRATION_CLOSED = 'registration is closed for this router'

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

function adminDenied(req, res, authed) {
  if (!authed(req)) { res.status(401).json({ error: 'unauthorized' }); return true }
  if (req.caseyAccount?.role !== 'admin') { res.status(403).json({ error: 'This is not available for your login.', code: 'role_forbidden' }); return true }
  return false
}

const finiteOrNull = (value) => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value)

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
    const effective = await portalSettings.effectiveSettings(store, router.router_id)
    if (!effective.registration_enabled) return res.status(503).json({ error: REGISTRATION_CLOSED })
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

export function getRouterConfig({ store }) {
  return async (req, res) => {
    const router = await routerFromBearer(store, req, res)
    if (!router) return
    const effective = await portalSettings.effectiveSettings(store, router.router_id)
    res.json({
      router_id: router.router_id,
      version: portalSettings.configVersion(effective),
      server_time: new Date().toISOString(),
      settings: portalSettings.routerSettings(effective),
      assets: ASSET_NAMES,
    })
  }
}

export function getRouterAsset({ store }) {
  return async (req, res) => {
    const router = await routerFromBearer(store, req, res)
    if (!router) return
    const name = String(req.params?.name ?? '')
    if (!ASSET_NAMES.includes(name)) return res.status(404).json({ error: 'not found' })
    const settings = await portalSettings.effectiveSettings(store, router.router_id)
    res.set('Content-Type', 'text/html; charset=utf-8')
    res.set('Cache-Control', 'no-store')
    res.status(200).send(renderAsset(name, { settings, routerId: router.router_id, apiBase: portalSettings.publicBase() }))
  }
}

export function postRouterHeartbeat({ store }) {
  return async (req, res) => {
    const router = await routerFromBearer(store, req, res)
    if (!router) return
    const b = req.body || {}
    if (b.router_id !== router.router_id) return res.status(403).json({ error: 'router_id does not match the token' })
    const parsed = parseHealth(b.health)
    if (parsed.error) return res.status(400).json({ error: parsed.error, field: parsed.field })
    await purgeIfDue(store).catch(e => { console.error('[portal] retention purge failed', String(e?.message || e)); return 0 })
    await recordHealth(store, router, parsed.health)
    res.status(202).json({ ok: true })
  }
}

export function postRouterUsage({ store }) {
  return async (req, res) => {
    const router = await routerFromBearer(store, req, res)
    if (!router) return
    const b = req.body || {}
    if (b.router_id !== router.router_id) return res.status(403).json({ error: 'router_id does not match the token' })
    if (Array.isArray(b.samples) && b.samples.length > USAGE_SAMPLES_MAX) return res.status(413).json({ error: `at most ${USAGE_SAMPLES_MAX} samples per request` })
    const parsed = parseUsageSamples(b.samples)
    if (parsed.error) return res.status(400).json({ error: parsed.error, field: parsed.field })
    await purgeIfDue(store).catch(e => { console.error('[portal] retention purge failed', String(e?.message || e)); return 0 })
    const accepted = await ingestUsage(store, router, parsed.samples)
    res.status(202).json({ ok: true, accepted })
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
    if (adminDenied(req, res, authed)) return
    const now = Date.now()
    const since = new Date(now - DAY_MS).toISOString()
    const until = new Date(now).toISOString()
    const overview = await portal.routerOverview(store, now)
    const routers = await Promise.all(overview.map(async (row) => {
      const lastHealth = await latestHealth(store, row.router_id)
      const usage = await usageReport(store, { routerId: row.router_id, since, until, bucket: 'day' })
      const usage24h = usage.devices.reduce((sum, d) => ({ up_bytes: sum.up_bytes + d.up_bytes, down_bytes: sum.down_bytes + d.down_bytes }), { up_bytes: 0, down_bytes: 0 })
      return { ...row, active_clients: finiteOrNull(lastHealth?.active_clients) ?? row.active_clients, last_health: lastHealth, usage_24h: usage24h }
    }))
    res.json({ routers, generated_at: new Date(now).toISOString() })
  }
}

async function globalView(store) {
  const overrides = await portalSettings.loadOverrides(store, portalSettings.GLOBAL_ROUTER_ID)
  return { overrides, effective: portalSettings.resolveSettings(overrides) }
}

export function getPortalConfig({ store, authed }) {
  return async (req, res) => {
    if (adminDenied(req, res, authed)) return
    const { overrides, effective } = await globalView(store)
    const routerRows = await store.t.list(portal.TABLE.routers, {}, { limit: ROUTER_LIST_MAX, sort: [{ field: 'created_at', dir: 'ASC' }] })
    const routers = await Promise.all(routerRows.map(async (r) => {
      const own = await portalSettings.loadOverrides(store, r.router_id)
      const merged = portalSettings.resolveSettings(overrides, own)
      return { router_id: r.router_id, name: r.name, overrides: own, version: portalSettings.configVersion(merged) }
    }))
    res.json({ settings: effective, overrides, schema: portalSettings.SCHEMA, defaults: portalSettings.DEFAULTS, routers })
  }
}

export function putPortalConfig({ store, authed }) {
  return async (req, res) => {
    if (adminDenied(req, res, authed)) return
    const checked = portalSettings.checkSettingsPatch((req.body || {}).settings)
    if (checked.error) return res.status(400).json({ error: checked.error, field: checked.field })
    await portalSettings.saveSettings(store, portalSettings.GLOBAL_ROUTER_ID, checked.values)
    const { effective } = await globalView(store)
    res.json({ settings: effective, version: portalSettings.configVersion(effective) })
  }
}

export function putRouterPortalConfig({ store, authed }) {
  return async (req, res) => {
    if (adminDenied(req, res, authed)) return
    const routerId = String(req.params?.router_id ?? '')
    const router = portal.validRouterId(routerId) ? await portal.findRouter(store, routerId) : null
    if (!router) return res.status(404).json({ error: 'unknown router_id' })
    const checked = portalSettings.checkSettingsPatch((req.body || {}).settings)
    if (checked.error) return res.status(400).json({ error: checked.error, field: checked.field })
    await portalSettings.saveSettings(store, router.router_id, checked.values)
    const effective = await portalSettings.effectiveSettings(store, router.router_id)
    res.json({ settings: effective, version: portalSettings.configVersion(effective) })
  }
}

export function getPortalUsage({ store, authed }) {
  return async (req, res) => {
    if (adminDenied(req, res, authed)) return
    const query = req.query || {}
    const range = parseWindow(query)
    if (range.error) return res.status(400).json({ error: range.error, field: range.field })
    const filter = parseUsageFilter(query)
    if (filter.error) return res.status(400).json({ error: filter.error, field: filter.field })
    const bucket = query.bucket === undefined || query.bucket === '' ? 'hour' : query.bucket
    if (!BUCKETS.includes(bucket)) return res.status(400).json({ error: 'bucket must be hour or day', field: 'bucket' })
    const report = await usageReport(store, { ...filter, ...range, bucket })
    const devices = await Promise.all(report.devices.map(async (device) => ({
      ...device,
      phone_e164: await registeredPhone(store, device.router_id, device.mac),
    })))
    res.json({ bucket, series: report.series, devices })
  }
}

export function getPortalHealth({ store, authed }) {
  return async (req, res) => {
    if (adminDenied(req, res, authed)) return
    const query = req.query || {}
    if (!portal.validRouterId(query.router_id)) return res.status(400).json({ error: 'router_id is required', field: 'router_id' })
    const range = parseWindow(query)
    if (range.error) return res.status(400).json({ error: range.error, field: range.field })
    const router = await portal.findRouter(store, query.router_id)
    if (!router) return res.status(404).json({ error: 'unknown router_id' })
    res.json({ rows: await healthRows(store, router.router_id, range) })
  }
}

const defaultWaPrefixSource = createWaPrefixSource()

export function getRouterWaPrefixes({ store, waPrefixSource = defaultWaPrefixSource }) {
  return async (req, res) => {
    const router = await routerFromBearer(store, req, res)
    if (!router) return
    const settings = await portalSettings.effectiveSettings(store, router.router_id)
    try {
      const prefixes = await waPrefixSource(settings.wa_asn)
      res.set('Content-Type', 'text/plain; charset=utf-8')
      res.set('Cache-Control', 'no-store')
      res.status(200).send(waPrefixesText(prefixes))
    } catch {
      res.status(503).json({ error: 'WhatsApp prefix list is unavailable' })
    }
  }
}

const ROUTES = [
  ['options', '/api/portal/register', preflightPortalRegister, { raw: true }],
  ['post', '/api/portal/register', postPortalRegister],
  ['get', '/api/router/status', getRouterStatus],
  ['get', '/api/router/config', getRouterConfig],
  ['get', '/api/router/assets/:name', getRouterAsset],
  ['get', '/api/router/wa-prefixes', getRouterWaPrefixes],
  ['post', '/api/router/heartbeat', postRouterHeartbeat],
  ['post', '/api/router/usage', postRouterUsage],
  ['post', '/api/router/events', postRouterEvents],
  ['get', '/api/routers', getRouters],
  ['get', '/api/portal/config', getPortalConfig],
  ['put', '/api/portal/config', putPortalConfig],
  ['put', '/api/portal/config/:router_id', putRouterPortalConfig],
  ['get', '/api/portal/usage', getPortalUsage],
  ['get', '/api/portal/health', getPortalHealth],
]

export function registerPortal(app, deps) {
  mountRoutes(app, deps, ROUTES)
}
