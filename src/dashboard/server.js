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
import { BRAND, TYPE_SCALE_CSS } from './brand.js'
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
// The shell's asset list is DERIVED from index.html rather than maintained
// beside it. Two hardcoded copies existed before and had already drifted apart:
// the build-id inputs still named dist/247420.js (nothing has loaded it since
// the design-SDK shim was removed) while BOTH copies omitted the two
// MarkerCluster stylesheets the page really links -- so editing one of those
// could not change the cache name, and a version-scoped cache would have gone
// on serving the old CSS. index.html is the only thing that knows what the
// shell loads, so it is the only thing asked. Same precedent as the manifest's
// theme_color, which is parsed from index.html's own meta tag below.
const SHELL_MOUNTS = [
  ['/design/', DESIGN_DIR],
  ['/vendor/leaflet.markercluster/', MARKERCLUSTER_DIR],
  ['/vendor/leaflet/', LEAFLET_DIR],
]

// Every same-origin asset index.html pulls in: stylesheets, preloads (the
// Ubuntu faces), and classic scripts. Module imports are NOT in this list --
// shellModuleGraph below owns those, and they are deliberately kept out of the
// service worker's precache (see the /sw.js route).
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

// Resolve one of those URLs to the file express.static will actually serve for
// it, using the same mount table routes/auth.js registers.
function shellAssetPath(url, publicDir) {
  for (const [prefix, dir] of SHELL_MOUNTS) {
    if (url.startsWith(prefix)) return path.join(dir, url.slice(prefix.length))
  }
  return path.join(publicDir, url.slice(1))
}

// MODULE DISCOVERY IS SERIAL, and on this deployment's link that is the whole
// cold-load cost. A browser cannot know a level-N+1 import exists until the
// level-N module has arrived and been parsed, so an unbundled ES module graph
// costs a round trip per level however few bytes it moves. Measured on this
// shell with a fixed 200 ms added to every request: 120 module requests spread
// over 17 serial discovery waves, the last module requested 4.8 s after the
// first, and the page renders white for the whole descent. At the ~2 s RTT this
// deployment targets that is the difference between a page and a blank screen.
//
// The fix is <link rel="modulepreload"> for the whole graph in the head. The
// preload scanner then requests every module in one wave, discovery collapses
// to a single level, and nothing else about the page changes: no build step,
// no bundle, and the unbundled ds/ source layout this project chose stays
// exactly as it is.
//
// GENERATED, never hand-written into index.html. A hand-maintained list drifts
// the first time anyone adds an import -- which is what happened to the shell
// asset list above -- and 118 link tags would undo the narration cut that took
// index.html from 6157 to 4549 bytes.

// index.html's own <script type="importmap"> is the resolution authority. It is
// read rather than restated as constants here: a second copy of the three rules
// would drift, and a generated href that resolves even slightly differently
// from the browser's is a wasted request plus a console warning.
function shellImportMap(html) {
  const m = /<script\b[^>]*\btype\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)
  if (!m) return []
  let imports
  try { imports = JSON.parse(m[1]).imports || {} } catch { return [] }
  // Longest key first. The map carries both "webjsx" and "webjsx/", and a
  // shorter-first walk would never reach the bare entry.
  return Object.entries(imports)
    .filter(([, target]) => typeof target === 'string')
    .sort((a, b) => b[0].length - a[0].length)
}

// Static import/export-from specifiers only. A dynamic import() is deferred by
// definition, and preloading something the page may never reach is exactly what
// produces Chrome's "preloaded but not used" warning -- the one failure mode
// that would make this change cost round trips instead of saving them.
//
// Regex rather than a parser, for the same reason compressResponses is
// hand-rolled over node:zlib: no dependency casey can write in a few lines.
// Both failure modes are safe by construction. A specifier this misses leaves
// that module discovered the old way, i.e. today's behaviour. A specifier it
// invents out of a comment or a string is dropped by shellModuleGraph's
// read-the-file check before it can become a request.
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
  // An unresolvable specifier is skipped rather than guessed at: a guess that
  // 404s spends a round trip on nothing, which is the cost this whole mechanism
  // exists to remove.
  if (!url || !url.startsWith('/') || url.startsWith('//')) return null
  if (url.includes('"') || url.includes('<')) return null
  // THE 247420.js FENCE, structural rather than conventional. index.html states
  // it as a rule for humans; this states it as code. Preloading the prebuilt SDK
  // bundle would move 355,065 gzipped bytes for a strict superset of what the
  // ds/ sources already deliver, so no specifier, however written, can reach it
  // through this generator.
  if (url.startsWith('/design/dist/')) return null
  return url
}

// Breadth-first from index.html's own <script type="module"> entries, so the
// emitted order is shallowest-first. That ordering is load-bearing on HTTP/1.1,
// where the browser holds six connections per origin: the modules the rest of
// the graph waits on get sockets first.
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
    // A URL reaches the emitted list only once its file has actually been read.
    // A preload of something express.static cannot serve is a wasted request
    // that warns in the console.
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

// Injected into the SERVED bytes, never into the file on disk, so index.html
// stays the single hand-maintained statement of what the shell links and the
// generated half cannot drift from the real import graph.
function injectModulePreloads(html, moduleUrls) {
  if (!moduleUrls.length) return html
  const i = html.lastIndexOf('</head>')
  if (i < 0) return html
  const tags = moduleUrls.map(u => `<link rel="modulepreload" href="${u}">`).join('\n')
  // No crossorigin attribute: these are same-origin, and modulepreload already
  // matches a module script's own same-origin credentials mode. Adding it would
  // make the preload's cache key disagree with the import's and fetch every
  // module twice -- the trap the Ubuntu font preloads sit on the other side of,
  // where crossorigin is required for exactly the same reason.
  return html.slice(0, i) + tags + '\n' + html.slice(i)
}

// Keyed by URL, not basename: the shell links two different files named
// leaflet.css and MarkerCluster.css from two different mounts, and a basename
// key would have let one silently stand in for the other.
function shellBuildId(publicDir, assetUrls) {
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
  for (const url of assetUrls) {
    try {
      const st = statSync(shellAssetPath(url, publicDir))
      h.update(url + ':' + st.size + ':' + Math.round(st.mtimeMs) + '\n')
    } catch { h.update(url + ':absent\n') }
  }
  return h.digest('hex').slice(0, 16)
}

// Shared print CSS + row/tbl table-builder lambdas for casey's printable HTML
// report generators (/api/report.html, /api/handover?format=html, and the
// per-case briefing) -- three separate inline generators used to each carry
// a near-duplicate <style> block and their own row/tbl closures. `extraCss`
// lets a caller layer on report-specific rules (e.g. the case briefing's
// action-button styling) without every report paying for it.
//
// Headings and table heads carry the deployment's own brand (BRAND.accent is
// the ground darkened only as far as it must be to clear 4.5:1 as text; the
// raw ground is never used for small type). Body copy stays a neutral near
// -black: a management report is read as prose, and tinting a wall of running
// text is a way to make it harder to read, not more branded.
//
// Sizes and spacing come from brand.js's TYPE_SCALE_CSS, the kit's own ladder
// (see that file for why the values are copied rather than the stylesheet
// linked). Three rungs carry this page: --fs-xl for the title, --fs-lg for a
// section head, --fs-xs for body and table cells. The title used to be 1.3rem
// (20.8px) and the section head 1rem (16px) -- one off-ladder, and the other
// close enough to the 14px body that a section head barely read as one.
//
// LINE HEIGHT IS DELIBERATELY NOT SET, and that is a decision rather than an
// omission. The rule this replaces used the `font:` SHORTHAND, which resets
// line-height to `normal`; the longhands below leave it at its initial value,
// which is also `normal`, so a printed line box measures 19.2px at 14px
// system-ui before this change and 19.2px after -- page counts are untouched.
// Naming the kit's --lh-base (1.55) instead would take that to 21.7px, a 13%
// stretch on every row of every report a team has ever filed. Prose
// line-height belongs on prose surfaces, not on a dense printed table.
//
// Sizes are rem, following the kit, which is deliberate and has a consequence
// worth stating: rem resolves against the READER's root font size, so an
// operator who has enlarged their browser text gets a proportionally larger
// report rather than a fixed 14px one. That is the point of the kit using rem
// (WCAG 1.4.4), and it does mean a printed page count is reader-dependent.
//
// extraCss lands BEFORE the shared @media print block, not after. It used to
// come last, which let the case briefing's own `body{margin:...}` override the
// print rule at equal specificity and win on source order -- so the one page
// with an extraCss body rule was the one page that ignored `@media
// print{body{margin:0}}` and printed a 32px margin anyway.
//
// THE PRINTED SHEET IS A FORM TO FILL IN WITH A PEN, not only a record to
// read. An officer prints a briefing, drives out, and writes on it. Two rules
// follow, and this is the one place they live for all three printables:
//
//  - An unrecorded field prints BLANK. On screen "not recorded" is a useful
//    statement; on paper it is wrong twice, because it eats the space the
//    answer goes in and because a location row reading "not recorded" looks
//    like a finding somebody made rather than a question still open.
//    `.ds-print-blank` wraps the placeholder and this hides it in print.
//  - `.ds-fill-lines` then supplies real ruled writing space. The rule is a
//    BORDER, never a background gradient or a box-shadow: browsers leave
//    background graphics out of a print by default, so a gradient rule prints
//    as nothing at all on the common setting.
//
// The class names, the 24px line height and the 8px gap are the design kit's
// own (deps/design/src/css/app-shell/row-print.css), so the printed briefing
// and the SPA's printed case detail rule identical lines. The screen default
// is declared BEFORE the print block, so the print override wins on source
// order at equal specificity. That ordering is load-bearing: reversed, the
// screen `display:none` beats the print `display:block` and no line is ever
// drawn on paper.
//
// break-inside on rows keeps a field and its writing lines on one page, so a
// pen never runs off the bottom of a sheet mid-answer.
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
  // One derived list feeds both the build id and the service worker's precache,
  // so the two can no longer name different files.
  const SHELL_HTML_SOURCE = (() => {
    try { return readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8') } catch { return null }
  })()
  const SHELL_ASSET_URLS = SHELL_HTML_SOURCE ? shellAssetUrls(SHELL_HTML_SOURCE) : []
  const SHELL_MODULE_URLS = SHELL_HTML_SOURCE ? shellModuleGraph(SHELL_HTML_SOURCE, PUBLIC_DIR) : []
  const SHELL_HTML = SHELL_HTML_SOURCE ? injectModulePreloads(SHELL_HTML_SOURCE, SHELL_MODULE_URLS) : null
  // The module graph is hashed into the build id but deliberately NOT
  // precached. Two reasons, pulling in opposite directions:
  //
  //  - INTO the id, because most of the graph resolves under /design/, outside
  //    PUBLIC_DIR. The walk below covers public/ whole and stats the bundles
  //    index.html links, so before this a design-kit edit shipped new module
  //    bytes under an unchanged cache name and the worker went on serving the
  //    old ones. A change to any byte the shell executes must change the id, or
  //    version-scoping is not version-scoping.
  //  - OUT of the precache, because install fetches with cache: 'reload' by
  //    design. Precaching the graph would re-download all of it immediately
  //    after the page has just downloaded it, doubling the first visit's cost
  //    on the metered link this change exists to serve. The modules still join
  //    the same versioned cache the first time they are asked for.
  const SHELL_BUILD_ID = shellBuildId(PUBLIC_DIR, [...SHELL_ASSET_URLS, ...SHELL_MODULE_URLS])
  // First in the chain, so it wraps every downstream response -- the API
  // routes, the SPA shell, and the /design + /vendor static mounts alike.
  app.use(compressResponses)
  app.use(express.json())
  app.use(express.urlencoded({ extended: false }))

  // A /design-sdk-shim.js route used to be registered HERE, ahead of
  // registerAuth. It re-exported webjsx's createElement plus the merged
  // shell/content/overlay-primitives surface, and index.html's import map
  // remapped '/design/dist/247420.js' onto it, because six case-list modules
  // imported `* as ds` from the design SDK's prebuilt bundle -- 745,191 raw /
  // 355,065 gzipped bytes and one more serial round trip -- while using only
  // `ds.h` and `ds.components`, naming nine components that all live in three
  // source modules the page already loads through the `ds/` import map.
  //
  // That was a redirect standing in for the real fix. The six modules now
  // import Btn/Chip/Pill/Badge/Heading from ds/components/shell.js,
  // Select/SearchInput/FilterPills from ds/components/content.js and Dropdown
  // from ds/components/overlay-primitives.js directly, exactly like every
  // other view in this SPA, so both the import-map entry and this route are
  // gone. Nothing under public/ references /design/dist/247420.js any more.
  //
  // Do NOT reintroduce either half. A new design component belongs in a named
  // import from its own ds/ module; a bundle-specifier import map entry costs
  // 355 KB gzipped for a strict superset of bytes already in flight.

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

  // dashboard_ui.brand, the theme-colour ground and the ink computed from it
  // all now come from dashboard/brand.js -- the same resolution the public
  // /report form and the printable case briefing read, so a deployment has one
  // answer to "what colour is this product" instead of four. Absent
  // dashboard_ui and with casey's own index.html in place, this resolves
  // exactly what the inline copies that used to live here resolved.
  const PWA_BRAND = BRAND.name
  const PWA_ICON_LETTER = PWA_BRAND.charAt(0).toUpperCase()
  const PWA_THEME_COLOR = BRAND.ground
  const PWA_ICON_INK = BRAND.ink
  // The font-size="120" here is an SVG PRESENTATION ATTRIBUTE, not CSS, and it
  // is deliberately NOT on the shared type ladder. Two reasons, both hard: a
  // var() is not substituted in a presentation attribute, and /icon.svg is a
  // standalone document that carries no token block to substitute from -- so
  // tokenising this would silently render an icon with no letter in it. It is
  // also not type in the typographic sense: it is a glyph sized to fill a
  // 192x192 box, and it belongs to that geometry rather than to a text scale.
  // A future sweep over font-size in this file should skip this line.
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
      ...(BRAND.description ? { description: BRAND.description } : {}),
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
// Derived at boot from index.html's own stylesheet/preload/script tags, not
// written out by hand -- the hand-written copy had already drifted from the
// page. Everything else same-origin (the ES modules, which resolve through the
// import map) joins the same versioned cache the first time it is asked for, so
// the operator never pays for a module this deployment does not actually open.
const PRECACHE = ${JSON.stringify([
      '/', '/offline.html', '/icon.svg', '/manifest.json',
      ...SHELL_ASSET_URLS,
    ])}

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
<style>${TYPE_SCALE_CSS}body{font-family:system-ui,sans-serif;font-size:var(--fs-body);background:#ffffff;color:#1a1a1a;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:var(--space-3-5)}
.card{max-width:360px}.card h1{font-size:var(--fs-xl);margin:0 0 var(--space-2)}p{color:#555c66;line-height:var(--lh-base);margin:0 0 var(--space-3)}
a{color:${PWA_ICON_INK};background:${PWA_THEME_COLOR};font-size:var(--fs-body);text-decoration:none;border:1px solid ${PWA_THEME_COLOR};border-radius:6px;padding:var(--space-2) var(--space-3-5);display:inline-block}</style>
</head><body><div class="card">
<h1>${esc(PWA_BRAND)}</h1>
<p>You are offline. Reports already on this device are not shown here. Reconnect to see the live queue.</p>
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
  // The shell HTML is served here rather than by express.static below, because
  // it is the one file in public/ that does not go out verbatim: the generated
  // modulepreload block is injected into it at boot. Same URL, same no-cache
  // policy, same ungated status (routes/auth.js exempts '/' and '/index.html'
  // by name, and must -- a logged-out browser has to receive this page to
  // render a login form at all). Registered ahead of the static mount so it
  // wins over that mount's own index: 'index.html'.
  //
  // Boot, not per request: the supervisor forks a fresh worker whenever a
  // watched source file's mtime moves, so boot IS the moment the shell can have
  // changed -- the same argument SHELL_BUILD_ID is computed on.
  if (SHELL_HTML) {
    const sendShell = (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache')
      res.type('html').send(SHELL_HTML)
    }
    app.get('/', sendShell)
    app.get('/index.html', sendShell)
  }
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
