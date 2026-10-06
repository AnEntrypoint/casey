import express from 'express'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { VISIT_CRITICAL } from '../case-health.js'
import { REPORT_KEY_ORDER, UNCLAIMED_ASSIGNEE } from '../case-store.js'
import { SYSTEM_SET_FIELDS } from '../store/report-shape.js'
import { BRAND, TYPE_SCALE_CSS } from './brand.js'
import { rankAttention } from '../attn.js'
import { fmtTimeSAST, isOpenCase, SAST_TZ, fmtPhone27 } from '../format.js'
import { getWebhookDeliveryStatus } from '../gateway-hooks.js'
import { escapeHtml } from 'anentrypoint-design/html-escape.js'
import { parseJsonArraySafe, parseEventData } from '../safe.js'
import { registerAuth } from './routes/auth.js'
import { roleOf } from './roles.js'
import { clientVocabulary } from '../config-loader.js'
import { registerTeam } from './routes/team.js'
import { registerAreas } from './routes/areas.js'
import { registerTeamImport } from './routes/team-import.js'
import { registerFeedback } from './routes/feedback.js'
import { registerWhatsappWebhook } from './routes/whatsapp-webhook.js'
import { registerCases } from './routes/cases.js'
import { registerAccounts } from './routes/accounts.js'
import { registerContacts } from './routes/contacts.js'
import { registerPersons } from './routes/persons.js'
import { registerExternalLinks } from './routes/external-links.js'
import { registerSyncApi } from './routes/sync-api.js'
import { registerMap } from './routes/map.js'
import { registerReports } from './routes/reports.js'
import { registerReportsMap } from './routes/reports-map.js'
import { registerReportFiles } from './routes/report-files.js'
import { registerOperations } from './routes/operations.js'
import { registerTranslate } from './routes/translate.js'
import { registerTiles, CLIENT_TILE_URL } from './routes/tiles.js'
import { publicSiteDir, landingHandler } from './routes/public-site.js'
const esc = escapeHtml
import {
  COOKIE_NAME, parseCookies, sessionCookieHeader, clearCookieHeader,
  issueSession, verifySession, findAccountByUsername, verifyPassword, markLogin,
  getAccount, listAccounts, createAccount, setAccountDisabled, setAccountContactPhone, deleteAccount, changePassword,
  revokeAccountSessions,
} from './auth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
function resolvePackageDir(pkgName, fallbackRelative, ...subpath) {
  try {
    const entryUrl = import.meta.resolve(pkgName)
    const entryPath = fileURLToPath(entryUrl)
    let dir = path.dirname(entryPath)
    while (dir !== path.dirname(dir)) {
      if (existsSync(path.join(dir, 'package.json'))) return path.resolve(dir, ...subpath)
      dir = path.dirname(dir)
    }
  } catch {  }
  return path.resolve(__dirname, '..', '..', 'node_modules', fallbackRelative, ...subpath)
}
const DESIGN_DIR = resolvePackageDir('anentrypoint-design', 'anentrypoint-design')
const LEAFLET_DIR = resolvePackageDir('leaflet', 'leaflet', 'dist')
const MARKERCLUSTER_DIR = resolvePackageDir('leaflet.markercluster', 'leaflet.markercluster', 'dist')
const PUBLIC_DIR = path.resolve(__dirname, 'public')

const PAGE_MAX = 200

const SHELL_MOUNTS = [
  ['/design/', DESIGN_DIR],
  ['/vendor/leaflet.markercluster/', MARKERCLUSTER_DIR],
  ['/vendor/leaflet/', LEAFLET_DIR],
]

function shellAssetUrls(html) {
  const urls = new Set()
  const add = (u) => { if (u && u.startsWith('/') && !u.startsWith('//')) urls.add(u) }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel\s*=\s*["'](?:stylesheet|preload)["']/i.test(m[0])) continue
    add((/\bhref\s*=\s*["']([^"']+)["']/i.exec(m[0]) || [])[1])
  }
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) add(m[1])
  return [...urls].sort()
}

function shellAssetPath(url, publicDir) {
  for (const [prefix, dir] of SHELL_MOUNTS) {
    if (url.startsWith(prefix)) return path.join(dir, url.slice(prefix.length))
  }
  return path.join(publicDir, url.slice(1))
}

function shellImportMap(html) {
  const m = /<script\b[^>]*\btype\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)
  if (!m) return []
  let imports
  try { imports = JSON.parse(m[1]).imports || {} } catch { return [] }
  return Object.entries(imports)
    .filter(([, target]) => typeof target === 'string')
    .sort((a, b) => b[0].length - a[0].length)
}

const MODULE_FROM_RE = /\b(?:import|export)\b[^'"()]*?\bfrom\s*['"]([^'"]+)['"]/g
const MODULE_SIDE_EFFECT_RE = /\bimport\s*['"]([^'"]+)['"]/g

function resolveModuleSpecifier(spec, fromUrl, importMap) {
  let url = null
  if (spec.startsWith('/')) url = spec
  else if (spec.startsWith('./') || spec.startsWith('../')) {
    url = path.posix.normalize(path.posix.join(path.posix.dirname(fromUrl), spec))
  } else {
    for (const [key, target] of importMap) {
      if (key.endsWith('/')) { if (spec.startsWith(key)) { url = target + spec.slice(key.length); break } }
      else if (spec === key) { url = target; break }
    }
  }
  if (!url || !url.startsWith('/') || url.startsWith('//')) return null
  if (url.includes('"') || url.includes('<')) return null
  if (url.startsWith('/design/dist/')) return null
  return url
}

function shellModuleGraph(html, publicDir) {
  const importMap = shellImportMap(html)
  const queue = []
  const seen = new Set()
  for (const m of html.matchAll(/<script\b[^>]*\btype\s*=\s*["']module["'][^>]*>/gi)) {
    const src = (/\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[0]) || [])[1]
    if (!src || !src.startsWith('/') || src.startsWith('//') || seen.has(src)) continue
    seen.add(src)
    queue.push(src)
  }
  const order = []
  while (queue.length) {
    const url = queue.shift()
    let src
    try { src = readFileSync(shellAssetPath(url, publicDir), 'utf8') } catch { continue }
    order.push(url)
    const specs = new Set()
    for (const m of src.matchAll(MODULE_FROM_RE)) specs.add(m[1])
    for (const m of src.matchAll(MODULE_SIDE_EFFECT_RE)) specs.add(m[1])
    for (const spec of specs) {
      const next = resolveModuleSpecifier(spec, url, importMap)
      if (!next || seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return order
}

function brandShellHead(html) {
  const name = esc(BRAND.name)
  return html
    .replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${name}</title>`)
    .replace(/(<meta\s+name="apple-mobile-web-app-title"\s+content=")[^"]*(")/i, (_m, a, b) => a + name + b)
    .replace(/(<meta\s+name="theme-color"\s+content=")[^"]*(")/i, (_m, a, b) => a + esc(BRAND.ground) + b)
    .replace(/(<b id="ds-boot-brand">)[^<]*(<\/b>)/i, (_m, a, b) => a + name + b)
}

function tileShellHead(html) {
  return html.replace(
    /(<meta\s+name="casey-tile-url"\s+content=")[^"]*(")/i,
    (_m, a, b) => a + esc(CLIENT_TILE_URL) + b)
}

function vocabularyJson() {
  return JSON.stringify(clientVocabulary()).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}
function vocabularyShellHead(html) {
  const i = html.lastIndexOf('</head>')
  if (i < 0) return html
  return html.slice(0, i) + `<script type="application/json" id="casey-vocab">${vocabularyJson()}</script>\n` + html.slice(i)
}

function injectModulePreloads(html, moduleUrls) {
  if (!moduleUrls.length) return html
  const i = html.lastIndexOf('</head>')
  if (i < 0) return html
  const tags = moduleUrls.map(u => `<link rel="modulepreload" href="${u}">`).join('\n')
  return html.slice(0, i) + tags + '\n' + html.slice(i)
}

function shellBuildId(publicDir, assetUrls, siteEnabled) {
  const h = createHash('sha256')
  h.update('brand:' + BRAND.name + ':' + BRAND.ground + '\n')
  h.update('tiles:' + CLIENT_TILE_URL + '\n')
  h.update('site:' + siteEnabled + '\n')
  h.update('vocab:' + vocabularyJson() + '\n')
  const walk = (dir, rel) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) { walk(abs, rel + e.name + '/'); continue }
      const st = statSync(abs)
      h.update(rel + e.name + ':' + st.size + ':' + Math.round(st.mtimeMs) + '\n')
    }
  }
  try { walk(publicDir, '') } catch { h.update('public-dir-unreadable\n') }
  for (const url of assetUrls) {
    try {
      const st = statSync(shellAssetPath(url, publicDir))
      h.update(url + ':' + st.size + ':' + Math.round(st.mtimeMs) + '\n')
    } catch { h.update(url + ':absent\n') }
  }
  return h.digest('hex').slice(0, 16)
}

function printableReportStyle(extraCss = '') {
  return `<style>${TYPE_SCALE_CSS}body{font-family:system-ui,sans-serif;font-size:var(--fs-xs);margin:var(--space-5);color:#1a1a1a}h1{font-size:var(--fs-xl);margin:0 0 var(--space-2);color:${BRAND.accent}}h2{font-size:var(--fs-lg);margin:var(--space-4) 0 var(--space-2);color:${BRAND.accent}}p.meta{font-size:var(--fs-tiny);color:#5a6674;margin:0 0 var(--space-4)}table{border-collapse:collapse;margin:var(--space-2) 0}td,th{border:1px solid ${BRAND.edge};padding:var(--space-1) var(--space-2-5);text-align:left}th{background:${BRAND.soft}}.ds-fill-lines{display:none}${extraCss}@media print{body{margin:0}.ds-print-blank{display:none}.ds-fill-lines{display:block;margin-bottom:var(--space-1)}.ds-fill-line{display:block;height:var(--space-4);border-bottom:var(--bw-hair) solid #1a1a1a}.ds-fill-line+.ds-fill-line{margin-top:var(--space-2)}tr,td,th{break-inside:avoid;page-break-inside:avoid}}</style>`
}
function printableReportRow(cells) {
  return `<tr>${cells.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`
}
function printableReportTable(head, rows) {
  return rows.length
    ? `<table>${head ? `<tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr>` : ''}${rows.join('')}</table>`
    : `<p>none</p>`
}
function printableReport(title, bodyHtml, extraCss = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>`
    + printableReportStyle(extraCss)
    + `</head><body>${bodyHtml}</body></html>`
}

const COMPRESSIBLE_TYPE = /^(?:text\/|application\/(?:json|javascript|manifest\+json|xml)|image\/svg\+xml)/i
const COMPRESS_MIN_BYTES = 1024

function compressResponses(req, res, next) {
  const accept = String(req.headers['accept-encoding'] || '')
  const encoding = /\bgzip\b/i.test(accept) ? 'gzip' : (/\bdeflate\b/i.test(accept) ? 'deflate' : null)
  if (!encoding || req.method === 'HEAD') return next()

  const rawWrite = res.write.bind(res)
  const rawEnd = res.end.bind(res)
  let stream = null
  let started = false

  const eligible = () => {
    if (res.headersSent) return false
    if (res.statusCode !== 200) return false
    if (res.getHeader('Content-Encoding')) return false
    if (!COMPRESSIBLE_TYPE.test(String(res.getHeader('Content-Type') || ''))) return false
    const declared = Number(res.getHeader('Content-Length'))
    if (Number.isFinite(declared) && declared < COMPRESS_MIN_BYTES) return false
    return true
  }

  const begin = () => {
    if (started) return
    started = true
    res.setHeader('Vary', 'Accept-Encoding')
    if (!eligible()) return
    res.setHeader('Content-Encoding', encoding)
    res.removeHeader('Content-Length')
    stream = encoding === 'gzip' ? zlib.createGzip() : zlib.createDeflate()
    stream.on('data', (chunk) => { rawWrite(chunk) })
    stream.on('end', () => { rawEnd() })
    stream.on('error', () => { rawEnd() })
  }

  const toBuffer = (chunk, enc) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof enc === 'string' ? enc : 'utf8'))

  res.write = function (chunk, enc, cb) {
    begin()
    if (!stream) return rawWrite(chunk, enc, cb)
    if (chunk != null && typeof chunk !== 'function') stream.write(toBuffer(chunk, enc))
    if (typeof chunk === 'function') chunk()
    else if (typeof enc === 'function') enc()
    else if (typeof cb === 'function') cb()
    return true
  }

  res.end = function (chunk, enc, cb) {
    begin()
    if (!stream) return rawEnd(chunk, enc, cb)
    if (chunk != null && typeof chunk !== 'function') stream.end(toBuffer(chunk, enc))
    else stream.end()
    if (typeof chunk === 'function') chunk()
    else if (typeof enc === 'function') enc()
    else if (typeof cb === 'function') cb()
    return res
  }

  next()
}

export function createDashboard(store, { port = 4000, sendReply = null, llmStatus = null, callLLM = null, runSweep = null, receiveStatus = null, runtimeStatus = null, queueStatus = null, alertWebhookUrl = null, resolveWhatsappAdapter = null } = {}) {
  if (!store) throw new Error('createDashboard requires a store instance')
  const app = express()
  const trustProxyHops = Number(process.env.CASEY_TRUST_PROXY_HOPS)
  if (Number.isFinite(trustProxyHops) && trustProxyHops > 0) app.set('trust proxy', trustProxyHops)
  const SHELL_HTML_SOURCE = (() => {
    try { return readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8') } catch { return null }
  })()
  const SHELL_ASSET_URLS = SHELL_HTML_SOURCE ? shellAssetUrls(SHELL_HTML_SOURCE) : []
  const SHELL_MODULE_URLS = SHELL_HTML_SOURCE ? shellModuleGraph(SHELL_HTML_SOURCE, PUBLIC_DIR) : []
  const SHELL_HTML = SHELL_HTML_SOURCE ? vocabularyShellHead(tileShellHead(brandShellHead(injectModulePreloads(SHELL_HTML_SOURCE, SHELL_MODULE_URLS)))) : null
  const PUBLIC_SITE_ROOT = publicSiteDir()
  const SHELL_BUILD_ID = shellBuildId(PUBLIC_DIR, [...SHELL_ASSET_URLS, ...SHELL_MODULE_URLS], !!PUBLIC_SITE_ROOT)
  const SHELL_ENTRY = PUBLIC_SITE_ROOT ? '/app' : '/'
  registerWhatsappWebhook(app, { express, resolveWhatsappAdapter })
  app.use(compressResponses)
  app.use(express.json())
  app.use(express.urlencoded({ extended: false }))

  const authed = (req) => !!req.caseyAccount
  const isAdmin = (req) => req.caseyAccount?.role === 'admin'
  const actingOperator = (req) => {
    const acct = req.caseyAccount
    if (!acct) throw new Error('actingOperator called with no authenticated session -- a gated route was registered before the session gate')
    return { id: acct.username, name: acct.display_name || acct.username, role: roleOf(acct) }
  }
  const getRoster = async () => {
    const accounts = await listAccounts(store)
    return accounts.filter(a => a.disabled !== '1').map(a => ({ id: a.username, name: a.display_name || a.username }))
  }

  const clampLimit = (v, d) => Math.min(PAGE_MAX, Math.max(1, parseInt(v, 10) || d))
  const offsetOf = (v) => Math.min(50000, Math.max(0, parseInt(v, 10) || 0))

  const MAX_LEN = 4000
  const enumSet = (field, fallback) => new Set(
    typeof store.getFieldEnum === 'function' && store.getFieldEnum(field, []).length
      ? store.getFieldEnum(field, [])
      : fallback)
  const PRIORITY = enumSet('case.priority', ['low', 'normal', 'high', 'urgent'])
  const CASE_TYPE = enumSet('case.case_type', ['unset', 'outbreak', 'follow_up', 'lab_sample', 'import_alert'])
  const AUTONOMY = enumSet('case.autonomy', ['auto', 'assisted', 'observe'])
  const str = (res, body, field, { required = true } = {}) => {
    const v = body[field]
    if (v == null) {
      if (required) { res.status(400).json({ error: `${field} required` }); return undefined }
      return ''
    }
    if (typeof v !== 'string') { res.status(400).json({ error: `${field} must be a string` }); return undefined }
    if (v.length > MAX_LEN) { res.status(413).json({ error: `${field} too long (max ${MAX_LEN})` }); return undefined }
    return v
  }

  function wrap(handler) {
    return async (req, res, next) => {
      try {
        await handler(req, res, next)
      } catch (e) {
        console.error('[dashboard] handler error', req.method, String(req.path).slice(0, 120), String(e?.stack || e).split('\n').slice(0, 6).join(' | '))
        res.status(500).json({ error: e.message })
      }
    }
  }

  const REPORT_KEY_LIST = REPORT_KEY_ORDER
  const REPORT_KEY_SET = new Set(REPORT_KEY_LIST)
  const VISIT_CRITICAL_SET = new Set(VISIT_CRITICAL)

  function computeFillRate(reportJson) {
    let r = {}
    try { r = reportJson ? JSON.parse(reportJson) : {} } catch { r = {} }
    const askable = REPORT_KEY_LIST.filter(k => !SYSTEM_SET_FIELDS.has(k))
    const filled = askable.filter(k => r[k] != null && String(r[k]).trim() !== '').length
    const vcFilled = [...VISIT_CRITICAL_SET].filter(k => r[k] != null && String(r[k]).trim() !== '').length
    return { total_fields: askable.length, filled, visit_critical_filled: vcFilled, visit_critical_total: VISIT_CRITICAL_SET.size }
  }

  function csvCell(v) {
    let s = v == null ? '' : String(v)
    if (/^\s*[=+\-@\t\r]/.test(s)) s = "'" + s
    if (s.includes(',') || s.includes('\n') || s.includes('\r') || s.includes('"')) return '"' + s.replace(/"/g, '""') + '"'
    return s
  }

  const deps = {
    PUBLIC_SITE_ROOT,
    store, express, path, DESIGN_DIR, LEAFLET_DIR, MARKERCLUSTER_DIR,
    COOKIE_NAME, parseCookies, sessionCookieHeader, clearCookieHeader,
    issueSession, verifySession, findAccountByUsername, verifyPassword,
    markLogin, getAccount, listAccounts, createAccount, setAccountDisabled, setAccountContactPhone,
    deleteAccount, changePassword, revokeAccountSessions,
    esc, wrap, str, clampLimit, offsetOf,
    authed, isAdmin, actingOperator, getRoster,
    AUTONOMY, PRIORITY, CASE_TYPE, REPORT_KEY_LIST, REPORT_KEY_SET,
    computeFillRate, csvCell, parseJsonArraySafe, parseEventData, isOpenCase,
    UNCLAIMED_ASSIGNEE,
    rankAttention, sendReply, fmtTimeSAST, fmtPhone27, SAST_TZ,
    printableReportRow, printableReportTable, printableReport,
    getWebhookDeliveryStatus, llmStatus, callLLM, runSweep, receiveStatus,
    runtimeStatus, queueStatus, alertWebhookUrl, resolveWhatsappAdapter,
  }

  registerAuth(app, deps)
  registerCases(app, deps)
  registerAccounts(app, deps)
  registerContacts(app, deps)
  registerPersons(app, deps)
  registerExternalLinks(app, deps)
  registerSyncApi(app, deps)
  registerMap(app, deps)
  registerReports(app, deps)
  registerReportsMap(app, deps)
  registerReportFiles(app, deps)
  registerOperations(app, deps)
  registerTranslate(app, deps)
  registerTeam(app, deps)
  registerAreas(app, deps)
  registerTeamImport(app, deps)
  registerFeedback(app, deps)
  registerTiles(app, deps)

  const PWA_BRAND = BRAND.name
  const PWA_ICON_LETTER = PWA_BRAND.charAt(0).toUpperCase()
  const PWA_THEME_COLOR = BRAND.ground
  const PWA_ICON_INK = BRAND.ink
  const PWA_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="32" fill="${PWA_THEME_COLOR}"/><text x="96" y="136" font-family="system-ui,sans-serif" font-size="120" font-weight="700" fill="${PWA_ICON_INK}" text-anchor="middle">${PWA_ICON_LETTER}</text></svg>`
  app.get('/icon.svg', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache')
    res.type('image/svg+xml').send(PWA_ICON_SVG)
  })
  app.get('/manifest.json', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache')
    res.json({
      name: PWA_BRAND, short_name: PWA_BRAND, start_url: SHELL_ENTRY, scope: '/', display: 'standalone',
      background_color: '#ffffff', theme_color: PWA_THEME_COLOR,
      ...(BRAND.description ? { description: BRAND.description } : {}),
      icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
    })
  })
  app.get('/sw.js', (_req, res) => {
    res.setHeader('Content-Type', 'application/javascript')
    res.setHeader('Cache-Control', 'no-cache')
    res.send(`
const VERSION = '${SHELL_BUILD_ID}'
const CACHE = 'casey-shell-' + VERSION
// Derived at boot from index.html's own stylesheet/preload/script tags and its
// resolved module graph, not written out by hand -- the hand-written copy had
// already drifted from the page.
//
// THE MODULE GRAPH IS IN HERE, and it has to be. It used to be left out, on the
// argument that a module joins this cache the first time it is asked for. What
// actually asked for it on a first visit was the unconditional reload that
// index.html fired when the worker claimed the page -- and that reload is gone,
// because on a first visit nothing has been superseded and reloading cost a
// second parse and execute of the whole graph. Witnessed after removing it,
// server killed following one online visit: the reload served the cached shell
// (title, boot notice, DOMContentLoaded 218 ms) while #app had 0 children and no
// header rendered, because Cache Storage held 16 entries and not one module. An
// operator whose first visit is their only online moment had a shell and no app.
//
// Precaching the graph was ruled out before because install fetched with
// cache: 'reload', which made it a second full download of everything. The
// install fetch is a default one now (see the handler below), so these are
// conditional requests against the entries the page has just filled: the
// operator pays request headers and a 304, not a body. That is what makes the
// offline guarantee affordable rather than theoretical.
const PRECACHE = ${JSON.stringify([
      SHELL_ENTRY, '/offline.html', '/icon.svg', '/manifest.json',
      ...SHELL_ASSET_URLS, ...SHELL_MODULE_URLS,
    ])}

// A DEFAULT fetch, deliberately NOT cache: 'reload'.
//
// This used to force one, and it doubled every first load on the wire.
// The install runs while the page that registered the worker is still up, so
// every URL below is one the browser fetched seconds ago; cache: 'reload'
// bypasses the HTTP cache entirely and pulls a second full copy of the whole
// shell. Measured cold at the socket, 290 requests: 1,328,304 bytes, with 142 of
// the 148 shell URLs downloaded exactly twice -- 247420.css alone arrived as
// 415,814 bytes instead of 207,908. On the metered rural link this deployment
// targets that is the difference between about 39 s and about 71 s of transfer
// at 150 kbps, for no new bytes.
//
// The hazard it was guarding -- a NEW build's precache filled from the browser's
// HTTP cache entry for the OLD one -- is already closed by the response headers
// every one of these URLs carries: no-cache or max-age=0, each with an ETag or
// Last-Modified. Both directives mean the browser MUST revalidate before reuse,
// so a default fetch either gets a 304 that the server has just asserted is the
// current build's bytes, or it gets the new body. There is no path by which it
// silently returns stale content, which is why the version-scoping scheme
// survives the change. If a future route ever serves a shell asset with a real
// max-age, that route -- not this fetch -- is the thing to fix.
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(PRECACHE.map((u) =>
    fetch(u)
      .then((r) => (r && r.ok ? c.put(u, r) : null))
      .catch(() => null)))))
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    // A worker that used to cache /report leaves those entries behind under a
    // cache name this build may still be using, and version-scoping alone does
    // not reach them: the id is derived from public/ and the linked bundles, so
    // a change to the fetch rule here does not rename the cache. The handler
    // below no longer reads them, but a report's contents sitting on a shared
    // handset is the point, so they are deleted rather than orphaned.
    .then(() => caches.open(CACHE))
    .then((c) => c.keys().then((rs) => Promise.all(rs
      .filter((r) => { const p = new URL(r.url).pathname; return p === '/report' || p.toLowerCase().startsWith('/media/') })
      .map((r) => c.delete(r)))))
    .then(() => self.clients.claim()))
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  // A range request is a partial body; storing or replaying one is wrong.
  if (req.headers.has('range')) return
  // Never cached, ever: this is the live case data.
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(req).catch(() => new Response(
      JSON.stringify({ error: 'offline' }),
      { status: 503, headers: { 'content-type': 'application/json' } })))
    return
  }
  // The update check must reach the network or the worker can never be replaced.
  if (url.pathname === '/sw.js') return
  if (url.pathname === '/site' || url.pathname.startsWith('/site/')) return
  if (${JSON.stringify(!!PUBLIC_SITE_ROOT)} && url.pathname === '/') {
    e.respondWith(fetch(req).catch(() => caches.open(CACHE).then((c) => c.match(${JSON.stringify(SHELL_ENTRY)})).then((hit) => hit || offlineFallback(req))))
    return
  }
  // Basemap tiles: straight to the network, never into this cache. The bounded
  // cache is the server's; see the note above the /sw.js route. Left entirely
  // to the browser's own HTTP cache, which honours the Cache-Control the tile
  // route passes through from upstream and is bounded by the browser itself.
  if (url.pathname.startsWith('/tiles/')) return
  // Photo and voice-note bytes are case data behind a session. Cached here they would be
  // handed to the next person on a shared handset with no login at all (cache-first, no
  // network, no cookie), so they go to the network like /api/ and are never stored.
  if (url.pathname.toLowerCase().startsWith('/media/')) return
  // The public report form is live per-case data on an unauthenticated URL, so
  // it belongs with /api/ above and not with the shell. Cached, it did two
  // wrong things at once: a reporter who came back to their own reference was
  // served the answers as they stood at their first visit, with no sign that
  // anything had moved since, and a named person's whole report -- species,
  // place, directions, owner name and number -- stayed readable on the handset
  // from Cache Storage with no network and no session, which on a shared rural
  // phone is the exact exposure the form's own sessionStorage draft rule
  // already refuses to create.
  if (url.pathname === '/report') {
    e.respondWith(fetch(req).catch(() => offlineFallback(req)))
    return
  }
  e.respondWith(caches.open(CACHE).then((c) => c.match(req, { ignoreVary: true }).then((hit) => {
    if (hit) return hit
    return fetch(req).then((res) => {
      if (res && res.status === 200 && res.type === 'basic') c.put(req, res.clone())
      return res
    }).catch(() => offlineFallback(req))
  })))
})

// A navigation that cannot reach the network gets the offline page; anything
// else gets a network error. The cache lookup is guarded because respondWith
// REJECTS on an undefined resolution -- an install whose /offline.html fetch
// failed would otherwise turn every offline navigation into the browser's own
// error page rather than this deployment's.
function offlineFallback(req) {
  if (req.mode !== 'navigate') return Response.error()
  return caches.open(CACHE).then((c) => c.match('/offline.html')).then((hit) => hit || Response.error())
}
`)
  })
  app.get('/offline.html', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache')
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="${esc(PWA_THEME_COLOR)}"><title>${esc(PWA_BRAND)} - no connection</title>
<style>${TYPE_SCALE_CSS}body{font-family:system-ui,sans-serif;font-size:var(--fs-body);background:#ffffff;color:#1a1a1a;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:var(--space-3-5)}
.card{max-width:360px}.card h1{font-size:var(--fs-xl);margin:0 0 var(--space-2)}p{color:#555c66;line-height:var(--lh-base);margin:0 0 var(--space-3)}
a{color:${PWA_ICON_INK};background:${PWA_THEME_COLOR};font-size:var(--fs-body);text-decoration:none;border:1px solid ${PWA_THEME_COLOR};border-radius:6px;padding:var(--space-2-75) var(--space-3-5);display:inline-block;min-height:44px;line-height:var(--lh-snug);box-sizing:border-box}
.fine{font-size:var(--fs-tiny)}</style>
</head><body><div class="card">
<h1>${esc(PWA_BRAND)}</h1>
<p>This phone has no connection to ${esc(PWA_BRAND)} right now, so the page you asked for could not be opened.</p>
<p>Nothing you have already sent is lost. Move to a spot with signal and this page opens itself as soon as the connection is back.</p>
<a id="retry" href="/">Try now</a>
<p class="fine" id="watching"></p>
</div>
<script>
(function () {
  var retry = document.getElementById('retry');
  // location is the URL that was actually asked for -- the service worker
  // answers the failed navigation with this document's bytes without changing
  // the address -- so reloading returns the reader to their own page rather
  // than to the dashboard root the static href names for the no-script case.
  //
  // Reached at its own address instead, this page is not standing in for
  // anything and there is nothing to return to: retrying would reload the
  // apology, and the recovery watch below would do it on a timer forever. So
  // both are off in that case and the static link to the dashboard stands.
  var standingIn = location.pathname !== '/offline.html';
  if (!standingIn) return;
  retry.setAttribute('href', location.href);
  retry.addEventListener('click', function (e) { e.preventDefault(); location.reload(); });
  document.getElementById('watching').textContent = 'Checking for a connection every few seconds.';
  var checking = false;
  function probe() {
    if (checking) return;
    checking = true;
    fetch('/api/ready', { cache: 'no-store' })
      .then(function (r) { if (r && r.status === 200) location.reload(); })
      .catch(function () {})
      .then(function () { checking = false; });
  }
  addEventListener('online', probe);
  setInterval(probe, 15000);
})();
</script>
</body></html>`)
  })
  if (SHELL_HTML) {
    const sendShell = (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache')
      res.type('html').send(SHELL_HTML)
    }
    app.get('/', PUBLIC_SITE_ROOT ? landingHandler(PUBLIC_SITE_ROOT, sendShell) : sendShell)
    app.get('/app', sendShell)
    app.get('/index.html', sendShell)
  }
  app.use(express.static(PUBLIC_DIR, {
    index: 'index.html',
    setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache') },
  }))

  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid request body' })
    if (!err?.status || err.status >= 500) console.error('[dashboard] unhandled error', req.method, String(req.path).slice(0, 120), String(err?.stack || err).split('\n').slice(0, 6).join(' | '))
    res.status(err?.status || 500).json({ error: 'internal error' })
  })

  const server = app.listen(port)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', () => {
      resolve({ app, server, port, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r) }) })
    })
  })
}
