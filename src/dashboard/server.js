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
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { VISIT_CRITICAL } from '../case-health.js'
import { REPORT_KEY_ORDER, UNCLAIMED_ASSIGNEE } from '../case-store.js'
import { DASHBOARD_UI } from '../store/report-shape.js'
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
// Resolved via real Node module resolution, not a hardcoded relative path --
// a deployer that installs casey as ITS OWN dependency (e.g. serpent) gets
// these hoisted to the deployer's own node_modules, not nested under
// casey's, so the old `../../node_modules/<pkg>` assumption 503'd every
// asset under it (live-witnessed: /design/dist/247420.css, /vendor/leaflet/*,
// /design/src/bootstrap.js all 404/503'd in a real serpent deployment,
// silently blanking the whole SPA since bootstrap.js never ran).
//
// import.meta.resolve() throws synchronously (ERR_MODULE_NOT_FOUND) when a
// package is missing/partially installed -- an adversarial review caught
// that an unguarded call here, at module top level, converts a per-route
// 404 (the old hardcoded-path behavior: server boots fine, only that one
// static subpath 404s) into a full boot-time crash of the entire
// gateway+dashboard process. Falls back to the old hardcoded relative path
// on any resolution failure, preserving the original graceful-degradation
// shape while still fixing the real hoisting case this function exists for.
function resolvePackageDir(pkgName, fallbackRelative, ...subpath) {
  try {
    const entryUrl = import.meta.resolve(pkgName)
    const entryPath = fileURLToPath(entryUrl)
    // Walk up from the resolved entry file to the package root (the dir
    // containing that package's own package.json), then append the subpath
    // -- entryPath is the package's `main`/`exports` target, not its root.
    let dir = path.dirname(entryPath)
    while (dir !== path.dirname(dir)) {
      if (existsSync(path.join(dir, 'package.json'))) return path.resolve(dir, ...subpath)
      dir = path.dirname(dir)
    }
  } catch { /* fall through to the legacy relative-path guess below */ }
  return path.resolve(__dirname, '..', '..', 'node_modules', fallbackRelative, ...subpath)
}
const DESIGN_DIR = resolvePackageDir('anentrypoint-design', 'anentrypoint-design')
const LEAFLET_DIR = resolvePackageDir('leaflet', 'leaflet', 'dist')
const MARKERCLUSTER_DIR = resolvePackageDir('leaflet.markercluster', 'leaflet.markercluster', 'dist')
const PUBLIC_DIR = path.resolve(__dirname, 'public')

const PAGE_MAX = 200

// Identifies the exact set of shell bytes this process is serving. The service
// worker's cache name is built from it, so a cache filled for one build can
// never answer a request under another -- see the /sw.js route for the full
// invalidation argument.
//
// Size + mtime rather than content hashing: mtime is the same signal
// src/supervisor.js already recycles the worker on, so the process that
// recomputes this id is exactly the process a source edit restarts, and the
// two cannot disagree. The cost of mtime's coarser granularity is one
// unnecessary re-download after a checkout that rewrites timestamps without
// changing bytes; the cost of the opposite mistake is an operator running a
// shell that no longer matches its API. The bias goes this way on purpose.
//
// Bounded by construction: it walks public/ (the first-party tree, ~130 small
// files) and then stats exactly the vendored bundles index.html links. It does
// not walk the design package, which is thousands of files this page never asks
// for.
function shellBuildId(publicDir, vendoredFiles) {
  const h = createHash('sha256')
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
  for (const f of vendoredFiles) {
    try {
      const st = statSync(f)
      h.update(path.basename(f) + ':' + st.size + ':' + Math.round(st.mtimeMs) + '\n')
    } catch { h.update(path.basename(f) + ':absent\n') }
  }
  return h.digest('hex').slice(0, 16)
}

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

// Response compression -- the single biggest lever on the rural link this
// deployment targets, and it was entirely absent. Measured on the real
// map-first landing (uhh, 21 cases / 7 geocoded pins, cold cache): 140
// same-origin requests carrying 2,504,822 bytes, none of it compressed,
// before a single basemap tile is drawn. Express ships no compression of its
// own, so a request that sent `Accept-Encoding: gzip` got the raw bytes back
// with no Content-Encoding at all -- confirmed live, byte-identical response
// sizes with and without the header.
//
// Hand-rolled over node:zlib rather than adding the `compression` package:
// casey's supply-chain posture (AGENTS.md) is to not take a dependency it can
// write in a few lines, and nothing here needs configuring beyond a
// content-type test.
//
// Streaming, not buffer-then-compress: a route that writes progressively (the
// CSV export) must keep streaming rather than being held whole in memory.
const COMPRESSIBLE_TYPE = /^(?:text\/|application\/(?:json|javascript|manifest\+json|xml)|image\/svg\+xml)/i
// Under this, the gzip header and trailer plus a round of CPU cost more than
// they save, and a sub-kilobyte body is one packet either way.
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
    // 200 only, deliberately: a 206 range response must keep its byte offsets
    // meaningful, and a 304 has no body to compress in the first place.
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
    // Vary is set whether or not THIS response ends up compressed: a shared
    // cache keyed without it would happily hand a gzipped body to the next
    // client that did not ask for one.
    res.setHeader('Vary', 'Accept-Encoding')
    if (!eligible()) return
    res.setHeader('Content-Encoding', encoding)
    // The declared length describes the ORIGINAL body. Left in place it is
    // both wrong and shorter than what actually goes out, which truncates the
    // response at the client.
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
  // Computed once per boot, not per request: the supervisor forks a fresh
  // worker whenever a watched source file's mtime moves, so boot IS the moment
  // the shell can have changed.
  const SHELL_BUILD_ID = shellBuildId(PUBLIC_DIR, [
    path.join(DESIGN_DIR, 'dist', '247420.css'),
    path.join(DESIGN_DIR, 'dist', '247420.js'),
    path.join(LEAFLET_DIR, 'leaflet.js'),
    path.join(LEAFLET_DIR, 'leaflet.css'),
    path.join(MARKERCLUSTER_DIR, 'leaflet.markercluster.js'),
  ])
  // First in the chain, so it wraps every downstream response -- the API
  // routes, the SPA shell, and the /design + /vendor static mounts alike.
  app.use(compressResponses)
  app.use(express.json())
  app.use(express.urlencoded({ extended: false }))

  // Registered HERE, ahead of registerAuth, and that position is the whole
  // point: routes/auth.js's gate is an app.use() installed inside
  // registerAuth, so anything mounted before it is unconditionally public
  // without needing a new exemption added to that gate's allowlist. The
  // logged-out login gate pulls the same module graph the dashboard does, so
  // this file has to be reachable with no session, exactly like /sw.js and
  // /icon.svg (which get there via the allowlist instead).
  //
  // WHAT IT IS: six case-list modules import `* as ds` from the design SDK's
  // prebuilt bundle, /design/dist/247420.js -- 745,191 raw / 355,065 gzipped
  // bytes and one more serial round trip -- and between them use exactly two
  // things off it, `ds.h` and `ds.components`, naming nine components. All
  // nine live in three source modules the page already loads through
  // index.html's `ds/` import map, so the bundle was a strict superset of
  // bytes already in flight. index.html remaps the bundle specifier here.
  //
  // Measured on this deployment (21 cases, cold cache, gzip on): 138
  // same-origin requests / 948,256 bytes before, of which the bundle was
  // 355,065 -- 37 percent of the page, on a link where the operator is
  // paying per megabyte.
  //
  // Served as a string from here rather than as a file under public/ for the
  // same reason /sw.js and /offline.html are: those are the routes that must
  // answer before a session exists, and they already live together in this
  // file. A `components` name that is NOT re-exported below must fail loudly
  // -- an undefined component renders as nothing, which on a triage queue
  // means a row that silently loses its status chip.
  const DESIGN_SDK_SHIM = `
import * as webjsx from 'webjsx'
import * as shell from 'ds/components/shell.js'
import * as content from 'ds/components/content.js'
import * as overlay from 'ds/components/overlay-primitives.js'

export const h = webjsx.createElement

const surface = { ...shell, ...content, ...overlay }
export const components = new Proxy(surface, {
  get(target, key) {
    if (typeof key !== 'string' || key in target) return target[key]
    if (key === 'then' || key === 'default' || key === '__esModule') return undefined
    throw new Error('design-sdk-shim: components.' + key + ' is not exported by '
      + 'shell.js, content.js or overlay-primitives.js. Import it from its own ds/ '
      + 'module and re-export it here (server.js DESIGN_SDK_SHIM) -- do not point '
      + 'the import map back at /design/dist/247420.js, that is 355 KB gzipped.')
  },
})
`
  app.get('/design-sdk-shim.js', (_req, res) => {
    res.setHeader('Content-Type', 'application/javascript')
    res.setHeader('Cache-Control', 'no-cache')
    res.send(DESIGN_SDK_SHIM)
  })

  // /api/login, /api/logout, and the public /report contact form are the only
  // routes reachable with no session -- every other /api route and the SPA
  // page itself require authed(req). isAdmin(req) additionally gates
  // account-management routes to the 'admin' role.
  const authed = (req) => !!req.caseyAccount
  const isAdmin = (req) => req.caseyAccount?.role === 'admin'
  // Fails closed. Every call site sits on a route registered AFTER
  // registerAuth's session gate, so a missing account here is impossible
  // rather than merely unusual -- and the previous behaviour (returning a
  // synthetic { id: 'dashboard-operator' } identity) would have ASSERTED an
  // operator identity that no session ever authenticated, against the
  // "operator identity is learned, never asserted" invariant, and written it
  // into audit/claim/activity rows. A loud 500 on an unreachable path beats a
  // fabricated author on a real one.
  const actingOperator = (req) => {
    const acct = req.caseyAccount
    if (!acct) throw new Error('actingOperator called with no authenticated session -- a gated route was registered before the session gate')
    return { id: acct.username, name: acct.display_name || acct.username, role: acct.role || 'operator' }
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
  const AUTONOMY = enumSet('case.autonomy', ['auto', 'assisted', 'observe'])
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
    if (/^\s*[=+\-@\t\r]/.test(s)) s = "'" + s
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
    authed, isAdmin, actingOperator, getRoster,
    AUTONOMY, PRIORITY, CASE_TYPE, REPORT_KEY_LIST, REPORT_KEY_SET,
    computeFillRate, csvCell, parseJsonArraySafe, parseEventData, isOpenCase,
    UNCLAIMED_ASSIGNEE,
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

  // dashboard_ui.brand (report-shape.js's DASHBOARD_UI) drives the PWA name
  // and icon initial the same additive way app-view.js/nav-config.js already
  // consume it -- absent, byte-identical to casey's own literal branding.
  const PWA_BRAND = DASHBOARD_UI?.brand || 'casey'
  const PWA_ICON_LETTER = PWA_BRAND.charAt(0).toUpperCase()
  // index.html's own <meta name="theme-color"> is the single source for the
  // brand colour. It had drifted: the page declared #E88427 while this
  // manifest and the generated icon both hardcoded #3b6ea5, so the browser
  // chrome, the installed app's task-switcher entry and the home-screen icon
  // were three different colours for one product. Reading the page's own tag
  // makes that divergence unrepresentable rather than merely fixed once.
  const readThemeColor = () => {
    try {
      const m = /<meta\s+name="theme-color"\s+content="([^"]+)"/i.exec(readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'))
      if (m) return m[1]
    } catch { /* a deployer replacing index.html keeps casey's own colour */ }
    return '#3b6ea5'
  }
  const PWA_THEME_COLOR = readThemeColor()
  // White-on-brand is the single most common way a palette ships an unreadable
  // mark, and this one is a live example: the design kit's own measurements
  // (colors_and_type.css, herd preset) put white on #E88427 at 2.71:1 -- under
  // even the 3:1 UI floor -- and black on the same orange at 7.76:1. So the
  // letter's ink is picked from the fill's luminance rather than assumed white.
  const readableInkOn = (hex) => {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex))
    if (!m) return '#fff'
    const n = parseInt(m[1], 16)
    const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    })
    const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
    return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? '#000' : '#fff'
  }
  const PWA_ICON_INK = readableInkOn(PWA_THEME_COLOR)
  const PWA_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="32" fill="${PWA_THEME_COLOR}"/><text x="96" y="136" font-family="system-ui,sans-serif" font-size="120" font-weight="700" fill="${PWA_ICON_INK}" text-anchor="middle">${PWA_ICON_LETTER}</text></svg>`
  app.get('/icon.svg', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache')
    res.type('image/svg+xml').send(PWA_ICON_SVG)
  })
  app.get('/manifest.json', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache')
    res.json({
      name: PWA_BRAND, short_name: PWA_BRAND, start_url: '/', display: 'standalone',
      // The splash screen paints background_color before the page's own CSS
      // exists. It used to be #0f1115, a near-black, on a deployment whose
      // first paint is the brand's white ground -- so every launch of the
      // installed app opened with the dark flash that index.html's own
      // data-theme comment says was deliberately engineered away.
      background_color: '#ffffff', theme_color: PWA_THEME_COLOR,
      // No hardcoded description. The old one read "Animal-disease
      // surveillance case management" in a codebase whose whole point is that
      // the domain comes from config (AGENTS.md, Configuration architecture)
      // and which ships an IT-helpdesk demo by default. A deployer that wants
      // one sets dashboard_ui.description; otherwise the field is simply
      // absent, which is valid and honest.
      ...(DASHBOARD_UI?.description ? { description: DASHBOARD_UI.description } : {}),
      icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
    })
  })
  // SERVICE WORKER. The previous version's header comment claimed "cache-first
  // for app shell assets"; the code underneath was unconditionally
  // network-first for everything and precached exactly two files
  // ('/offline.html', '/icon.svg'), so no shell asset was ever cache-first and
  // the app did not work offline in any sense beyond showing an apology page.
  // The comment is now true because the code is.
  //
  // WHY CACHE-FIRST IS SAFE HERE, on a surveillance dashboard where a stale
  // shell would be a safety problem rather than a cosmetic one:
  //
  //  1. Nothing under /api/ is ever cached. Every fact an operator READS --
  //     case rows, the map, health, the queue -- comes from the network on
  //     every request or fails loudly with the 503 offline envelope. Only
  //     code, CSS and fonts are cached.
  //  2. The cache NAME carries SHELL_BUILD_ID, derived from the size and
  //     mtime of every file under public/ plus the design and leaflet bundles
  //     this page links. A changed shell is a different cache, so a cache
  //     built for one build is structurally incapable of serving another --
  //     this is version-scoping, not expiry, and it needs no clock.
  //  3. That id is baked into this script's bytes, and /sw.js is served
  //     no-cache, so the browser's own update check (it refetches sw.js on
  //     navigation) sees different bytes, installs the new worker, and
  //     activate deletes every cache that is not the current one. Worst case
  //     an operator is one navigation behind a deploy, never more.
  //  4. mtime is the same signal casey's supervisor already reloads the
  //     worker on (AGENTS.md, Supervised runtime), so the two agree by
  //     construction: the process that recomputes this id is the process a
  //     source edit restarts.
  //
  // skipWaiting is kept deliberately: on this link a deploy that waits for
  // every tab to close could take days to reach an operator, and the mixed
  // -version window it opens is bounded by point 2 -- the new worker serves a
  // whole consistent build or nothing from it.
  //
  // Third-party requests (OpenStreetMap tiles) are passed straight through.
  // Caching them would help offline, but a tile cache is unbounded by nature
  // and this is a device with a metered link and a small disk; that is a
  // separate decision with its own eviction policy, not a side effect here.
  app.get('/sw.js', (_req, res) => {
    res.setHeader('Content-Type', 'application/javascript')
    res.setHeader('Cache-Control', 'no-cache')
    res.send(`
const VERSION = '${SHELL_BUILD_ID}'
const CACHE = 'casey-shell-' + VERSION
// Above the fold on the map-first landing. Everything else same-origin joins
// the same versioned cache the first time it is asked for, so the operator
// never pays for a module this deployment does not actually open.
const PRECACHE = [
  '/', '/offline.html', '/icon.svg', '/manifest.json', '/app.css',
  '/design/dist/247420.css',
  '/vendor/ubuntu/ubuntu-400.woff2', '/vendor/ubuntu/ubuntu-700.woff2',
  '/vendor/leaflet/leaflet.css', '/vendor/leaflet/leaflet.js',
]

// cache: 'reload' matters. Without it the precache for a NEW build could be
// filled from the browser's own HTTP cache entry for the OLD one, which would
// quietly defeat the whole version-scoping scheme.
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(PRECACHE.map((u) =>
    fetch(new Request(u, { cache: 'reload' }))
      .then((r) => (r && r.ok ? c.put(u, r) : null))
      .catch(() => null)))))
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
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
  e.respondWith(caches.open(CACHE).then((c) => c.match(req, { ignoreVary: true }).then((hit) => {
    if (hit) return hit
    return fetch(req).then((res) => {
      if (res && res.status === 200 && res.type === 'basic') c.put(req, res.clone())
      return res
    }).catch(() => (req.mode === 'navigate' ? c.match('/offline.html') : Response.error()))
  })))
})
`)
  })
  // Reached only when the shell itself has never been cached AND the link is
  // down -- i.e. a first-ever visit with no connection. Brand and ground track
  // the real dashboard (it used to be hardcoded "casey" on a near-black page,
  // which for a deployer with their own brand was a different product's
  // apology screen).
  app.get('/offline.html', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache')
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(PWA_BRAND)} - offline</title>
<style>body{font-family:system-ui,sans-serif;background:#ffffff;color:#1a1a1a;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:20px}
.card{max-width:360px}.card h1{font-size:1.4em;margin:0 0 8px}p{color:#555c66;line-height:1.5;margin:0 0 16px}
a{color:${PWA_ICON_INK};background:${PWA_THEME_COLOR};text-decoration:none;border:1px solid ${PWA_THEME_COLOR};border-radius:6px;padding:8px 18px;display:inline-block}</style>
</head><body><div class="card">
<h1>${esc(PWA_BRAND)}</h1>
<p>You are offline. Reports already on this device are not shown here -- reconnect to see the live queue.</p>
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
  //
  // CACHING POLICY, stated rather than inherited. express.static's default
  // maxAge of 0 was already emitting `Cache-Control: public, max-age=0`; this
  // makes the same policy explicit and says why it is not a longer one.
  //
  // Not one URL in this tree carries a content hash -- every module imports
  // its siblings by a stable path, and there is no build step that could
  // rewrite them -- so any max-age above zero is a bet that no deploy will
  // change a file inside the window. On a case-triage dashboard the losing
  // side of that bet is an operator running a shell against an API it no
  // longer matches, which is a safety property rather than a slow page. The
  // HTTP layer therefore stays correctness-first: store it, but revalidate
  // before every reuse. express.static's ETag keeps each revalidation a 304
  // with no body (measured: a repeat load moved 1,536 bytes, not 948,256).
  //
  // Round trips are what actually hurt on the 2000 ms-RTT link this
  // deployment targets, and 138 conditional GETs is ~46 s of them. Removing
  // those is the SERVICE WORKER's job, not this header's: its cache is keyed
  // by SHELL_BUILD_ID, so it can answer with no revalidation at all and still
  // never outlive a deploy. Both layers are needed -- this one is the floor
  // for a first visit, a browser with no service-worker support, and the
  // window before the worker has installed.
  app.use(express.static(PUBLIC_DIR, {
    index: 'index.html',
    setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache') },
  }))

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
