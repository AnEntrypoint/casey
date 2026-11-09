import http from 'node:http'
import * as portal from '../../portal/portal-store.js'
import * as admin from '../../portal/portal-admin.js'
import { loadDefaults } from '../../portal/portal-config.js'
import { mountRoutes } from './register.js'

const PROXY_DROP = new Set(['cookie', 'authorization', 'host', 'connection', 'origin', 'referer', 'accept-encoding', 'keep-alive', 'upgrade', 'proxy-authorization'])
const PROXY_TIMEOUT_MS = 30e3
const ROUTER_PAGE_MAX = 500
const routerCookieName = () => loadDefaults().admin_router_cookie
const ROUTER_ID = /^[A-Za-z0-9_-]{1,64}$/

const bearer = (req) => {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.get('authorization') || '').trim())
  return m ? m[1].trim() : ''
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const actorOf = (req) => ({ id: String(req.caseyAccount?.id ?? req.caseyAccount?.username ?? 'admin') })

function adminOnly(req, res) {
  if (req.caseyAccount?.role === 'admin') return false
  res.status(403).json({ error: 'This is not available for your login.', code: 'role_forbidden' })
  return true
}

const proxyPrefix = (routerId) => `/admin/routers/${encodeURIComponent(routerId)}`

function rewriteLocation(location, ip, prefix) {
  const absolute = `http://${ip}`
  if (location.startsWith(absolute)) return prefix + location.slice(absolute.length)
  if (location.startsWith('/')) return prefix + location
  return location
}

function rewriteCookie(cookie, prefix) {
  return cookie.replace(/;\s*Domain=[^;]*/i, '').replace(/;\s*Path=[^;]*/i, '') + `; Path=${prefix}/`
}

function routerFromCookie(req) {
  const m = new RegExp(`(?:^|;\\s*)${routerCookieName()}=([^;]+)`).exec(String(req.headers.cookie || ''))
  return m && ROUTER_ID.test(m[1]) ? m[1] : ''
}

function forwardToRouter(req, res, row, routerId, rest) {
  const prefix = proxyPrefix(routerId)
  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) if (!PROXY_DROP.has(k)) headers[k] = v
  headers.host = row.tunnel_ip
  const upstream = http.request({ host: row.tunnel_ip, port: 80, path: rest, method: req.method, headers, timeout: PROXY_TIMEOUT_MS }, (up) => {
    const out = { ...up.headers }
    if (out.location) out.location = rewriteLocation(String(out.location), row.tunnel_ip, prefix)
    out['set-cookie'] = [].concat(out['set-cookie'] || []).map(c => rewriteCookie(c, prefix))
      .concat(`${routerCookieName()}=${routerId}; Path=/; HttpOnly; SameSite=Strict${req.secure ? '; Secure' : ''}`)
    res.writeHead(up.statusCode, out)
    up.pipe(res)
  })
  upstream.on('timeout', () => upstream.destroy(new Error('router did not answer in time')))
  upstream.on('error', () => {
    if (!res.headersSent) res.status(502).json({ error: 'the router did not answer' })
    else res.destroy()
  })
  req.pipe(upstream)
}

function getRouterAdmin({ store }) {
  return async (req, res) => {
    const token = bearer(req)
    const router = await portal.findRouterByToken(store, token)
    if (!router) return res.status(401).json({ error: 'unauthorized' })
    const pub = String(req.query.pub || '').replace(/ /g, '+')
    if (!admin.validWgKey(pub)) return res.status(400).json({ error: 'pub must be a WireGuard public key' })
    const out = await admin.adminPoll(store, router.router_id, pub, {
      endpoint: process.env.CASEY_ADMIN_HUB_ENDPOINT,
      hubPub: process.env.CASEY_ADMIN_HUB_PUBKEY,
    })
    res.set('Cache-Control', 'no-store')
    res.status(200).json(out)
  }
}

function getHubPeers({ store }) {
  return async (req, res) => {
    if (!admin.hubTokenOk(bearer(req), process.env.CASEY_ADMIN_HUB_TOKEN)) return res.status(401).json({ error: 'unauthorized' })
    res.set('Cache-Control', 'no-store')
    res.status(200).json({ peers: await admin.hubPeers(store) })
  }
}

function postAdminWindow({ store }) {
  return async (req, res) => {
    if (adminOnly(req, res)) return
    const routerId = String(req.params.router_id || '')
    const minutes = admin.windowMinutes(req.body?.minutes)
    if (minutes === null) return res.status(400).json({ error: `minutes must be 1 to ${admin.ADMIN_WINDOW_MAX_MIN}` })
    try {
      const until = await admin.setAdminWindow(store, routerId, minutes, actorOf(req))
      res.status(200).json({ router_id: routerId, minutes, until })
    } catch (err) {
      res.status(409).json({ error: err.message })
    }
  }
}

function postAdminClose({ store }) {
  return async (req, res) => {
    if (adminOnly(req, res)) return
    try {
      await admin.closeAdminWindow(store, String(req.params.router_id || ''), actorOf(req))
      res.status(200).json({ closed: true })
    } catch (err) {
      res.status(409).json({ error: err.message })
    }
  }
}

function getAdminPage({ store }) {
  return async (req, res) => {
    if (adminOnly(req, res)) return
    const routers = await store.t.list(portal.TABLE.routers, {}, { limit: ROUTER_PAGE_MAX })
    const rows = await store.t.list(portal.TABLE.admin, {}, { limit: ROUTER_PAGE_MAX })
    const byRouter = new Map(rows.map(r => [r.router_id, r]))
    const lines = routers.map((r) => {
      const left = admin.windowRemainingS(byRouter.get(r.router_id))
      const open = left > 0
      const status = open ? `open, ${Math.ceil(left / 60)} min left` : 'closed'
      const actions = open
        ? `<a href="/admin/routers/${esc(encodeURIComponent(r.router_id))}/">Open router admin</a> <button data-close="${esc(r.router_id)}">Close now</button>`
        : [30, 60, 120].map(m => `<button data-open="${esc(r.router_id)}" data-minutes="${m}">${m} min</button>`).join(' ')
      return `<tr><td>${esc(r.name)}</td><td>${esc(r.router_id)}</td><td>${esc(status)}</td><td>${actions}</td></tr>`
    })
    res.set('Content-Type', 'text/html; charset=utf-8')
    res.set('Cache-Control', 'no-store')
    res.status(200).send(`<!doctype html><meta charset="utf-8"><title>Router admin</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem}table{border-collapse:collapse}td,th{padding:.4rem .8rem;border-bottom:1px solid #ddd;text-align:left}button{margin-right:.3rem}</style>
<h1>Router admin</h1>
<p>Opening a window lets the router's web admin and Winbox answer over the admin tunnel for the chosen time. Closing it, or the time running out, cuts the tunnel.</p>
<table><tr><th>Name</th><th>Router</th><th>Admin window</th><th></th></tr>${lines.join('')}</table>
<script>
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return
  const id = b.dataset.open || b.dataset.close
  const url = b.dataset.open ? '/api/admin/routers/' + encodeURIComponent(id) + '/window' : '/api/admin/routers/' + encodeURIComponent(id) + '/close'
  const body = b.dataset.open ? JSON.stringify({ minutes: Number(b.dataset.minutes) }) : '{}'
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  if (!r.ok) alert((await r.json().catch(() => ({}))).error || 'failed')
  location.reload()
})
</script>`)
  }
}

function proxyRouterAdmin({ store }) {
  const handle = async (req, res) => {
    if (adminOnly(req, res)) return
    const routerId = String(req.params.router_id || '')
    const row = await admin.adminRow(store, routerId)
    if (!row || admin.windowRemainingS(row) <= 0) return res.status(423).json({ error: 'admin window closed for this router' })
    const rest = req.originalUrl.slice(proxyPrefix(routerId).length) || '/'
    forwardToRouter(req, res, row, routerId, rest)
  }
  return (req, res) => handle(req, res).catch(() => {
    if (!res.headersSent) res.status(500).json({ error: 'admin proxy failed' })
    else res.destroy()
  })
}

export function registerRouterRootFallback(app, { store }) {
  app.use((req, res, next) => {
    const routerId = routerFromCookie(req)
    if (!routerId || req.caseyAccount?.role !== 'admin') return next()
    admin.adminRow(store, routerId).then((row) => {
      if (!row || admin.windowRemainingS(row) <= 0) return next()
      forwardToRouter(req, res, row, routerId, req.originalUrl)
    }, next)
  })
}

export const ADMIN_ROUTES = [
  ['get', '/api/router/admin', getRouterAdmin],
  ['get', '/api/hub/peers', getHubPeers],
  ['post', '/api/admin/routers/:router_id/window', postAdminWindow],
  ['post', '/api/admin/routers/:router_id/close', postAdminClose],
  ['get', '/admin/routers', getAdminPage],
  ['all', '/admin/routers/:router_id', proxyRouterAdmin, { raw: true }],
  ['all', '/admin/routers/:router_id/*splat', proxyRouterAdmin, { raw: true }],
]

export function registerPortalAdmin(app, deps) {
  mountRoutes(app, deps, ADMIN_ROUTES)
}
