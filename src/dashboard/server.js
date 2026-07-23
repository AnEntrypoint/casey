// dashboard/server.js -- casey's observe + manual-edit UI.
//
// Serves a small single-page app styled with anentrypoint-design's CSS, backed
// by a JSON API over the CaseStore. This is the human surface of casey:
// - observe   read every case, open one, read its full timeline
// - edit      change subject/summary/priority/tags/assignee/autonomy
// - override  force any valid workflow transition as an operator
// - reply     send a message to the contact on their channel as a human
//
// Everything written here goes through the same CaseStore the agent uses, so
// agent and operator share one timeline. The API is the operator-override
// surface, gated by a per-operator login (see dashboard/auth.js).
//
// AUTH MODEL: username/password per operator, a real (if simple) login screen
// familiar to a not-necessarily-tech-literate field-organisation team -- no
// bearer token to copy/paste or lose. A fresh deployment auto-creates a single
// bootstrap admin account (printed once to the server log) so there is always
// a way in; that admin creates named accounts for the rest of the team from
// the dashboard's user-management panel (admin-only), or via `casey.js
// operators` on the CLI for break-glass recovery (lost admin password,
// scripted provisioning). Sessions are stateless HMAC-signed cookies (no
// server-side session table to keep in sync across the hot-reload supervisor's
// worker restarts -- AGENTS.md). X-Casey-Operator is retired: the logged-in
// session IS the acting operator now, not a self-attested header.
//
// STRUCTURE: this file is the ASSEMBLY POINT only. Every route handler lives
// in src/dashboard/routes/{auth,cases,accounts,contacts,map,reports,
// operations}.js, each exporting a register*(app, deps) function called
// below. Route modules are grouped by what they actually do (case CRUD,
// account/session management, contacts/reporters, map views, management
// reports, operational health/thresholds) -- auth.js additionally owns the
// session-resolving + auth-gate MIDDLEWARE and so registers first, since
// every other module's routes assume req.caseyAccount is already resolved.
// This split is pure reorganisation: every route's URL/method/request/
// response/status/auth gating is unchanged from the single-file version.

import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VISIT_CRITICAL } from '../case-health.js'
import { REPORT_KEY_ORDER } from '../case-store.js'
import { rankAttention } from '../attn.js'
import { fmtTimeSAST, isOpenCase, SAST_TZ, fmtPhone27 } from '../format.js'
import { getWebhookDeliveryStatus } from '../gateway-hooks.js'
import { escapeHtml } from 'anentrypoint-design/html-escape.js'
import { parseJsonArraySafe, parseEventData } from '../safe.js'
import { registerAuth } from './routes/auth.js'
import { registerCases } from './routes/cases.js'
import { registerAccounts } from './routes/accounts.js'
import { registerContacts } from './routes/contacts.js'
import { registerMap } from './routes/map.js'
import { registerReports } from './routes/reports.js'
import { registerOperations } from './routes/operations.js'
const esc = escapeHtml
import {
  COOKIE_NAME, parseCookies, sessionCookieHeader, clearCookieHeader,
  issueSession, verifySession, findAccountByUsername, verifyPassword, markLogin,
  getAccount, listAccounts, createAccount, setAccountDisabled, deleteAccount, changePassword,
  revokeAccountSessions,
} from './auth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESIGN_DIR = path.resolve(__dirname, '..', '..', 'node_modules', 'anentrypoint-design')
const LEAFLET_DIR = path.resolve(__dirname, '..', '..', 'node_modules', 'leaflet', 'dist')
const MARKERCLUSTER_DIR = path.resolve(__dirname, '..', '..', 'node_modules', 'leaflet.markercluster', 'dist')
const PUBLIC_DIR = path.resolve(__dirname, 'public')

const OPERATOR = { id: 'dashboard-operator', role: 'operator' }
const PAGE_MAX = 200

// Shared print CSS + row/tbl table-builder lambdas for casey's printable HTML
// report generators (/api/report.html, /api/handover?format=html, and the
// per-case briefing) -- three separate inline generators used to each carry
// a near-duplicate <style> block and their own row/tbl closures. `extraCss`
// lets a caller layer on report-specific rules (e.g. the case briefing's
// action-button styling) without every report paying for it.
function printableReportStyle(extraCss = '') {
  return `<style>body{font:14px system-ui,sans-serif;margin:2rem;color:#1a1a1a}h1{font-size:1.3rem}h2{font-size:1rem;margin-top:1.5rem}table{border-collapse:collapse;margin:.3rem 0}td,th{border:1px solid #ccc;padding:.2rem .6rem;text-align:left}@media print{body{margin:0}}${extraCss}</style>`
}
function printableReportRow(cells) {
  return `<tr>${cells.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`
}
function printableReportTable(head, rows) {
  return rows.length
    ? `<table>${head ? `<tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr>` : ''}${rows.join('')}</table>`
    : `<p>none</p>`
}
// title/bodyHtml compose the full standalone page; extraCss is passed through
// to printableReportStyle for report-specific additions.
function printableReport(title, bodyHtml, extraCss = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>`
    + printableReportStyle(extraCss)
    + `</head><body>${bodyHtml}</body></html>`
}

// thatcher persists event.data as a JSON string and store.list* returns it unparsed.
// The SPA reads e.data.field/.by etc. as objects, so parse `data` to an object at the
// API boundary before sending. Both helpers now live in src/safe.js (casey's shared
// defensive-parsing module); parseEventData there always shallow-clones each row (the
// original inline version here skipped the clone when data was already an object --
// a latent bug the shared version fixes, since store.list*'s returned rows must never
// be mutated regardless of whether data happened to already be parsed).

// opts.sendReply(caseRow, text) -> Promise; lets the operator reply on the channel.
export function createDashboard(store, { port = 4000, sendReply = null, llmStatus = null, runSweep = null, receiveStatus = null, runtimeStatus = null, queueStatus = null, alertWebhookUrl = null } = {}) {
  if (!store) throw new Error('createDashboard requires a store instance')
  const app = express()
  // Trust-proxy is env-driven and defaults OFF (req.ip stays the raw socket
  // peer, today's exact behavior -- no regression for a direct/ngrok/dev
  // deployment). A deployment that sits behind a reverse proxy/load balancer
  // (the normal internet-facing topology) MUST set CASEY_TRUST_PROXY_HOPS to
  // the number of trusted proxy hops in front of it, or every request's
  // socket peer is the proxy -- reportRateLimited (routes/auth.js) then keys
  // ALL farmers into one shared 10-req/60s bucket, so any combination of 10
  // legitimate submissions in a minute gets every OTHER farmer 429'd.
  // Misconfiguring the hop count the other way (too high/untrusted) lets a
  // client spoof X-Forwarded-For to bypass the limiter -- an operator setting
  // this must know their own real proxy chain depth.
  const trustProxyHops = Number(process.env.CASEY_TRUST_PROXY_HOPS)
  if (Number.isFinite(trustProxyHops) && trustProxyHops > 0) app.set('trust proxy', trustProxyHops)
  app.use(express.json())
  app.use(express.urlencoded({ extended: false }))

  // /api/login, /api/logout, and the public /report contact form are the only
  // routes reachable with no session -- every other /api route and the SPA
  // page itself require authed(req). isAdmin(req) additionally gates
  // account-management routes to the 'admin' role.
  const authed = (req) => !!req.caseyAccount
  const isAdmin = (req) => req.caseyAccount?.role === 'admin'
  const actingOperator = (req) => {
    const acct = req.caseyAccount
    if (!acct) return OPERATOR
    return { id: acct.username, name: acct.display_name || acct.username, role: 'operator' }
  }
  // Same {id, name} shape the old CASEY_OPERATORS roster returned, sourced
  // from real operator_account rows instead of an env var -- every existing
  // consumer (workload/report/identities/suggested-assignee) keeps working
  // unchanged. Excludes disabled accounts (a disabled operator is no longer
  // "on the team" for coverage/workload purposes, though their history stays).
  const getRoster = async () => {
    const accounts = await listAccounts(store)
    return accounts.filter(a => a.disabled !== '1').map(a => ({ id: a.username, name: a.display_name || a.username }))
  }

  const clampLimit = (v, d) => Math.min(PAGE_MAX, Math.max(1, parseInt(v, 10) || d))
  const offsetOf = (v) => Math.min(50000, Math.max(0, parseInt(v, 10) || 0))

  // Adversarial-Structural: reject malformed mutations with a clear 4xx before
  // thatcher is touched. No framework, no dependency. MAX_LEN is a product cap
  // on operator-entered text length (UTF-16 units), NOT a security boundary --
  // express.json()'s 100KB default already bounds the body.
  const MAX_LEN = 4000
  const AUTONOMY = new Set(['auto', 'assisted', 'observe'])
  // priority/case_type are config-declared enums: derive the accepted set from the
  // SAME live source /api/config and the case_* tools validate against
  // (store.getFieldEnum), never a hardcoded parallel copy -- otherwise a value
  // added to thatcher.config.yml is accepted by the store and shown in the editor
  // yet 400s here (the config-drift the stage list already avoids via
  // getOpenStatuses). The literal list is only the fallback when getFieldEnum is
  // absent (a pre-support store), matching the /api/config fallback shape.
  const enumSet = (field, fallback) => new Set(
    typeof store.getFieldEnum === 'function' && store.getFieldEnum(field, []).length
      ? store.getFieldEnum(field, [])
      : fallback)
  const PRIORITY = enumSet('case.priority', ['low', 'normal', 'high', 'urgent'])
  const CASE_TYPE = enumSet('case.case_type', ['unset', 'outbreak', 'follow_up', 'lab_sample', 'import_alert'])
  // Returns a validated string, or sends a 4xx and returns undefined so the
  // caller short-circuits: `const x = str(...); if (x === undefined) return`.
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

  // Dedupes the repeated `try { ... } catch (e) { res.status(500).json({error:e.message}) }`
  // envelope that wraps nearly every JSON API route. Purely mechanical: same
  // status code, same response shape, same error.message -- just written once.
  // Routes with a DIFFERENT catch shape (e.g. the public HTML /report form's
  // error page) are left as their own explicit try/catch.
  function wrap(handler) {
    return async (req, res, next) => {
      try {
        await handler(req, res, next)
      } catch (e) {
        res.status(500).json({ error: e.message })
      }
    }
  }

  // Keys used by the report fields -- REPORT_KEY_ORDER is case-store.js's REPORT_KEYS,
  // ordered for display (observation fields first, then logistics, then contacts/media).
  const REPORT_KEY_LIST = REPORT_KEY_ORDER
  const REPORT_KEY_SET = new Set(REPORT_KEY_LIST)
  const VISIT_CRITICAL_SET = new Set(VISIT_CRITICAL)

  function computeFillRate(reportJson) {
    let r = {}
    try { r = reportJson ? JSON.parse(reportJson) : {} } catch { r = {} }
    const filled = REPORT_KEY_LIST.filter(k => r[k] != null && String(r[k]).trim() !== '').length
    const vcFilled = [...VISIT_CRITICAL_SET].filter(k => r[k] != null && String(r[k]).trim() !== '').length
    return { total_fields: REPORT_KEY_LIST.length, filled, visit_critical_filled: vcFilled, visit_critical_total: VISIT_CRITICAL_SET.size }
  }

  // Escape a cell value for CSV: neutralize a leading formula-trigger character
  // (=, +, -, @) so a contact-supplied value never auto-executes as a formula in
  // Excel/Sheets (CWE-1236), then wrap in quotes if it contains comma, newline, or quote.
  function csvCell(v) {
    let s = v == null ? '' : String(v)
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
    // A bare \r (no \n) is itself a row-breaking character to Excel and many
    // CSV parsers (old-Mac-style or stray CR line endings), but was missing
    // from the quoting trigger below -- a farmer-supplied field containing a
    // lone \r (public /report form, WhatsApp/Discord free text) could split a
    // CSV export into a bogus row with no quoting to prevent it.
    if (s.includes(',') || s.includes('\n') || s.includes('\r') || s.includes('"')) return '"' + s.replace(/"/g, '""') + '"'
    return s
  }

  // Shared closure surface every route module may draw from. Each module
  // destructures only what it actually uses -- see each routes/*.js file's own
  // header comment for its specific dependency list.
  const deps = {
    store, express, path, DESIGN_DIR, LEAFLET_DIR, MARKERCLUSTER_DIR,
    COOKIE_NAME, parseCookies, sessionCookieHeader, clearCookieHeader,
    issueSession, verifySession, findAccountByUsername, verifyPassword,
    markLogin, getAccount, listAccounts, createAccount, setAccountDisabled,
    deleteAccount, changePassword, revokeAccountSessions,
    esc, wrap, str, clampLimit, offsetOf,
    authed, isAdmin, actingOperator, getRoster, OPERATOR,
    AUTONOMY, PRIORITY, CASE_TYPE, REPORT_KEY_LIST, REPORT_KEY_SET,
    computeFillRate, csvCell, parseJsonArraySafe, parseEventData, isOpenCase,
    rankAttention, sendReply, fmtTimeSAST, fmtPhone27, SAST_TZ,
    printableReportRow, printableReportTable, printableReport,
    getWebhookDeliveryStatus, llmStatus, runSweep, receiveStatus,
    runtimeStatus, queueStatus, alertWebhookUrl,
  }

  // auth.js registers first: the session-resolving middleware, the public
  // /report form + /api/ready + login/logout/whoami/change-password routes,
  // the auth-gate middleware, and the /design + /vendor + /media static
  // mounts. Every other module's routes run after the gate.
  registerAuth(app, deps)
  registerCases(app, deps)
  registerAccounts(app, deps)
  registerContacts(app, deps)
  registerMap(app, deps)
  registerReports(app, deps)
  registerOperations(app, deps)

  const PWA_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="32" fill="#3b6ea5"/><text x="96" y="136" font-family="system-ui,sans-serif" font-size="120" font-weight="700" fill="#fff" text-anchor="middle">C</text></svg>`
  app.get('/icon.svg', (_req, res) => res.type('image/svg+xml').send(PWA_ICON_SVG))
  app.get('/manifest.json', (_req, res) => res.json({
    name: 'casey', short_name: 'casey', start_url: '/', display: 'standalone',
    background_color: '#0f1115', theme_color: '#3b6ea5',
    description: 'Animal-disease surveillance case management',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
  }))
  // Service worker: cache-first for app shell assets, network-first for API, offline.html fallback.
  app.get('/sw.js', (_req, res) => {
    res.setHeader('Content-Type', 'application/javascript')
    res.setHeader('Cache-Control', 'no-cache')
    res.send(`
const CACHE='casey-v1'
const SHELL=['/offline.html','/icon.svg']
self.addEventListener('install',e=>{ e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL))); self.skipWaiting() })
self.addEventListener('activate',e=>{ e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k))))); self.clients.claim() })
self.addEventListener('fetch',e=>{
  const u=e.request.url
  if(u.includes('/api/')){ e.respondWith(fetch(e.request).catch(()=>new Response(JSON.stringify({error:'offline'}),{status:503,headers:{'content-type':'application/json'}}))); return }
  e.respondWith(fetch(e.request).catch(()=>caches.match('/offline.html')))
})
`)
  })
  app.get('/offline.html', (_req, res) => {
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>casey - offline</title>
<style>body{font-family:sans-serif;background:#0f1115;color:#cdd3de;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:20px}
.card{max-width:360px}.card h1{font-size:1.4em;margin:0 0 8px}p{color:#8b95a6;line-height:1.5;margin:0 0 16px}
a{color:#3b6ea5;text-decoration:none;border:1px solid #3b6ea5;border-radius:6px;padding:8px 18px;display:inline-block}a:hover{background:#1e2a3a}</style>
</head><body><div class="card">
<h1>casey</h1>
<p>You are offline. Please check your connection and try again.</p>
<a href="/">Try again</a>
</div></body></html>`)
  })
  // The dashboard SPA itself: index.html + app.css + app.js served as real
  // static files (see src/dashboard/public/) -- moved out of an inline
  // template-literal constant so scripts/lint.mjs and editor tooling can see
  // the client code (casey-dashboard-spa-to-static PRD row). No server-side
  // interpolation was needed: the SPA already fetches its dynamic config
  // (workflow stages, case_type/priority enums, tz) from /api/config and its
  // session identity from /api/whoami at load time, so the static files are
  // byte-identical in content to what the inline template used to render.
  app.use(express.static(PUBLIC_DIR, { index: 'index.html' }))

  // Error middleware MUST be registered last -- express only routes an error
  // to middleware defined AFTER the point where it was thrown/passed via
  // next(err), so registering this before any route (its previous position)
  // meant it could never actually catch a route error, only ever the
  // malformed-JSON body-parse failure that happens to occur upstream of every
  // route. casey never sets NODE_ENV=production anywhere, so anything that
  // fell through to express's own default handler (a framework-level error,
  // e.g. a static-file range error) rendered a full HTML page with a stack
  // trace and absolute filesystem paths to any anonymous client. Handles the
  // existing entity.parse.failed case first (unchanged response shape), then
  // a final catch-all that never echoes err.message/err.stack.
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid request body' })
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
