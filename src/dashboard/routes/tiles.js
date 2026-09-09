// dashboard/routes/tiles.js -- the basemap, served from this deployment's own
// origin instead of from openstreetmap.org, backed by a bounded on-disk cache.
//
// WHY THIS EXISTS, and the second reason is the load-bearing one.
//
//  1. COST. A cold map landing pulled 30 tiles / 281 KB straight off
//     a|b|c.tile.openstreetmap.org, and paid it again on every pan and zoom,
//     on a link this deployment assumes is metered and slow. Cached here, a
//     square an operator has already looked at costs the deployment nothing
//     the second time, for every operator, not just the one whose browser
//     happened to keep it.
//  2. SOVEREIGNTY. A tile request is a statement of WHICH map square this
//     deployment is looking at, and WHEN. On an animal-disease surveillance
//     system that square is the location of an outbreak under investigation,
//     and it was being disclosed continuously to a third party with no
//     agreement, from a deployment whose own rules forbid putting a contact's
//     phone number in a Discord message. Nobody chose that; it arrived with
//     Leaflet's default tile URL.
//
// WHAT THIS ACTUALLY BUYS, stated exactly rather than overclaimed. The browser
// stops talking to openstreetmap.org entirely: OSM no longer sees one request
// per operator device, no browser fingerprint, no per-officer IP, and no way to
// correlate two officers as one deployment. What still reaches OSM is the tile
// SET, on a cold miss only -- so this REDUCES the disclosure to "these squares
// were looked at at least once by this one server", it does not eliminate it.
// Eliminating it needs self-hosted tiles (CASEY_TILE_URL points anywhere), and
// that remains the only complete answer.
//
// OSM TILE USAGE POLICY (https://operations.osmfoundation.org/policies/tiles/),
// read rather than assumed, because most of what this file does is dictated
// by it. Section 5 says plainly: "We generally do not recommend putting your
// own caching proxy in front of tile.openstreetmap.org. If you do, it must:
// set a clear, contactable User-Agent identifying the organisation/service;
// honour server caching headers or the minimum 7-day TTL rule." Both are met
// below. The recommendation against is not hidden here: this deployment does
// it anyway for reason 2 above, which is a reason the policy does not weigh.
//
//  - URL. The policy names exactly one correct URL,
//    https://tile.openstreetmap.org/{z}/{x}/{y}.png, and says other subdomains
//    "may be slower or withdrawn without notice". The map was on the
//    {s}.tile.openstreetmap.org sharding form, which is that deprecated shape.
//    The default below is the named one.
//  - Identification. A "clear, unique User-Agent string that names your app"
//    is mandatory, and "Hide behind a generic proxy User-Agent" and "Use the
//    library's generic default" are both in the must-not list. Node's fetch
//    would send a library default, so USER_AGENT is always set explicitly.
//  - Referer. "If you proxy tile requests through your servers or a CDN, do
//    not strip or blank the Referer." The browser's own Referer is forwarded.
//  - Caching. Server caching headers are honoured; where none can be read the
//    entry is held the policy's minimum 7 days. An EXPIRED entry is never
//    dropped, it is revalidated with If-None-Match / If-Modified-Since, which
//    the policy explicitly asks for -- a 304 moves no tile bytes at all.
//  - No bulk download. Nothing here prefetches. The cache fills only with
//    tiles a browser actually asked for while a human was looking at the map,
//    which is the policy's own definition of permitted use. There is no
//    seeding path, no bounding-box walk and no offline-pack builder, and
//    section 4 is why: "Offline use is not permitted on tile.openstreetmap.org"
//    and "Preloading entire towns/regions or multiple zoom stacks" is named as
//    prohibited. A deployment that genuinely needs offline districts has to
//    self-host or use a provider whose terms allow packaging.
//  - No cache-busting. Cache-Control: no-cache / Pragma: no-cache are never
//    sent upstream.
//  - Not hard-coded. The policy's "should" list asks that the tile URL be
//    switchable without a software update: CASEY_TILE_URL is that switch.
//
// The one recommendation NOT met, stated rather than implied: the policy
// recommends HTTP/2 or HTTP/3 for multiplexing. Node's fetch reaches OSM over
// HTTP/1.1. It is a "recommended", not a "must", and the cache means this
// deployment opens far fewer upstream connections than the browsers it
// replaced.
//
// FAILURE IS NEVER SILENT. This route never answers a failed upstream fetch
// with a blank or transparent PNG. A blank tile renders as an empty map that
// looks deliberate, which is exactly what the map's own rule ("an empty map
// says WHY it is empty") forbids. Instead: a stale cached copy is served if
// one exists (an out-of-date map is still a correct map), and otherwise the
// request fails with a real status code, which is what makes Leaflet fire
// tileerror -- map-leaflet.js's watchTileHealth counts a RUN of those and the
// map panel then says the background is missing while the reports are not.
// The server side says why too, in a structured log line, because the browser
// cannot tell "this dashboard could not reach the map service" from "this
// dashboard is unreachable" and the operator needs the difference.
import fs from 'node:fs'
import path from 'node:path'
import { BRAND } from '../brand.js'

const DEFAULT_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

// The upstream template. Any {z}/{x}/{y} template works, including a
// self-hosted renderer, which is the complete answer to the sovereignty half
// of this file's reason for existing.
export const TILE_URL = process.env.CASEY_TILE_URL || DEFAULT_TILE_URL

// Same-origin delivery is the DEFAULT, and the default is the interesting
// half of this switch. A deployment that genuinely wants its browsers talking
// straight to OSM sets CASEY_TILE_PROXY=0 and gets exactly that -- no route is
// registered, and the shell's tile URL is rewritten to the upstream template
// so Leaflet goes direct. The default is on because the cost and the
// disclosure both fall on the deployment rather than on whoever set the
// variable, and a default that quietly narrates an outbreak's location to a
// third party is not a default anyone would choose if asked.
export const TILE_PROXY_ENABLED = process.env.CASEY_TILE_PROXY !== '0'

// What the browser is told to fetch. Injected into the served shell by
// server.js (see brandShellHead's sibling), so the client needs no config
// round trip and no module has to know an environment variable exists.
export const CLIENT_TILE_URL = TILE_PROXY_ENABLED ? '/tiles/{z}/{x}/{y}.png' : TILE_URL

// Policy section 3.1 and 3.4: a stable string naming this app, ideally with a
// contact. CASEY_PUBLIC_URL is already the deployment's own published address,
// so it doubles as the contact the policy asks for when it is set. There is no
// path here that leaves the header unset or library-default.
const CASEY_VERSION = '0.2.0'
export const TILE_USER_AGENT = process.env.CASEY_TILE_USER_AGENT
  || `${String(BRAND.name || 'casey').replace(/[^\x20-\x7e]/g, '').replace(/[()\/;]/g, '') || 'casey'}`
  + `/${CASEY_VERSION} (casey; ${process.env.CASEY_PUBLIC_URL || 'https://github.com/AnEntrypoint/casey'})`

// THE BOUND, in bytes, and the number is measured rather than round.
//
// Bytes and not a tile count: a tile of empty veld and a tile of a town differ
// by roughly ten times in size, so a count bound would be ten times wrong in
// one direction or the other, while the question an operator actually has --
// "can this fill my disk" -- is a question about bytes.
//
// What decided 256 MB. Measured on the real cold landing: 30 tiles / 281 KB,
// so 9.37 KB per tile. This deployment's whole located-case bounding box
// (-28.05,28.15 to -22.94,32.18, its 6 placeable reports) is 792 tiles at z11
// and 1,158 tiles across z0-z11 together -- and z11 is the deepest the map's
// own auto-fit ever goes (map-leaflet.js caps fitBounds at maxZoom 11). That
// is 9.9 MB for every square the map can put itself on. Add the two deeper
// zooms focusCaseOnMap can reach (it clamps at 13) for a screenful around each
// of the 26 stored cases, about 30 tiles per screen: 26 x 2 x 30 = 1,560
// tiles, 14.3 MB. The whole realistic working set is therefore about 24 MB.
//
// 256 MB is ten times that, and the factor is the point rather than the
// number. Eviction has to be the exception and not the steady state, because
// a cache that thrashes re-fetches the same squares over and over -- which
// MULTIPLIES upstream requests instead of reducing them, and the OSM policy
// specifically asks for the opposite. Ten times headroom holds the working set
// of a deployment ten times this size, or this one after its operators have
// hand-zoomed to z14 across their own districts, with no eviction at all.
// It is also small enough to never be a surprise: data/ on this deployment is
// 96 KB today, and a ceiling an operator can check with one `du` and hold in
// their head is worth more than a cleverer adaptive number.
export const DEFAULT_MAX_CACHE_BYTES = 256 * 1024 * 1024

// The policy's floor for an entry whose caching headers cannot be read.
const MIN_TTL_MS = 7 * 24 * 60 * 60 * 1000

// Upstream fetch budget. Past this the tile is treated as unavailable, which
// on a rural link means a stale copy or an honest tileerror rather than a
// request that hangs a browser connection slot indefinitely.
const UPSTREAM_TIMEOUT_MS = Number(process.env.CASEY_TILE_TIMEOUT_MS) || 15000

// The deepest zoom this route will proxy. It is the tile layer's own maxZoom,
// and it is a bound rather than a courtesy: without it, z/x/y is an unbounded
// key space and a scripted caller could walk it, which is precisely the "bulk
// download" the policy forbids and this deployment would be blamed for.
const MAX_Z = 19

function logLine(fields) {
  console.log(JSON.stringify({ t: new Date().toISOString(), component: 'tiles', ...fields }))
}

// ---- the bounded store --------------------------------------------------

// Flat filenames in one directory rather than z/x/y nesting. The directory is
// bounded by construction (that is this class's whole job), so it never grows
// the many-thousand-entry-per-directory problem nesting exists to avoid, and a
// flat layout means eviction is one unlink with no empty parents left behind.
//
// Two files per tile: the PNG, and a small JSON sidecar holding the upstream
// validators (etag / last-modified) and the expiry the response declared.
// Those validators are what make revalidation cost zero tile bytes, so losing
// them matters; a sidecar survives a crash independently of the image, and a
// PNG whose sidecar is missing is simply treated as expired with no validator,
// which degrades to one ordinary re-fetch rather than to a wrong answer.
//
// RECENCY IS THE FILE'S OWN mtime. There is no index file to write, to keep in
// step, or to lose: the filesystem already stores exactly the fact LRU needs,
// it survives a restart for free, and boot rebuilds the whole order with one
// readdir plus a stat per entry. A read touches the mtime forward, but only
// when the recorded one is already more than TOUCH_FLOOR_MS old -- the same
// trick Linux's own relatime uses, and the reason a busy map does not turn
// every tile hit into a disk write on an SD card.
const TOUCH_FLOOR_MS = 60 * 60 * 1000

export class TileCache {
  constructor({ dir, maxBytes } = {}) {
    if (!dir) throw new Error('TileCache: dir is required')
    this.dir = dir
    this.maxBytes = maxBytes || Number(process.env.CASEY_TILE_CACHE_MAX_BYTES) || DEFAULT_MAX_CACHE_BYTES
    fs.mkdirSync(this.dir, { recursive: true })
    // key -> { bytes, used } where `used` is the mtime in ms. Rebuilt from
    // disk at construction so a restart inherits the real LRU order rather
    // than starting from an empty cache and re-fetching everything.
    this.index = new Map()
    this.totalBytes = 0
    this.evictions = 0
    this.hits = 0
    this.misses = 0
    this.revalidations = 0
    this.upstreamFailures = 0
    this._boot()
  }

  _boot() {
    let names = []
    try { names = fs.readdirSync(this.dir) } catch { return }
    for (const name of names) {
      const m = /^(\d+-\d+-\d+)\.png$/.exec(name)
      if (!m) continue
      const key = m[1]
      let bytes = 0, used = 0
      try {
        const st = fs.statSync(path.join(this.dir, name))
        bytes = st.size
        used = st.mtimeMs
      } catch { continue }
      try { bytes += fs.statSync(this._metaPath(key)).size } catch { /* sidecar lost: still bounded by the png */ }
      this.index.set(key, { bytes, used })
      this.totalBytes += bytes
    }
    // A bound lowered between restarts has to bite immediately, not only once
    // the next tile happens to be written.
    this._evict()
  }

  _pngPath(key) { return path.join(this.dir, key + '.png') }
  _metaPath(key) { return path.join(this.dir, key + '.json') }

  // The stored entry, or null. Never throws: a torn sidecar reads as an entry
  // with no validators, which costs one ordinary re-fetch and nothing else.
  read(key) {
    const entry = this.index.get(key)
    if (!entry) return null
    let png
    try { png = fs.readFileSync(this._pngPath(key)) } catch { this._forget(key); return null }
    let meta = {}
    try { meta = JSON.parse(fs.readFileSync(this._metaPath(key), 'utf8')) } catch { meta = {} }
    const now = Date.now()
    if (now - entry.used > TOUCH_FLOOR_MS) {
      entry.used = now
      try { fs.utimesSync(this._pngPath(key), new Date(now), new Date(now)) } catch { /* recency is an optimisation */ }
    }
    return { png, meta }
  }

  has(key) { return this.index.has(key) }

  // Write a freshly fetched tile, then evict down to the bound. Eviction runs
  // AFTER the write and against the incoming size, so the bound is exact
  // rather than exceeded by however large the tile that tripped it was.
  write(key, png, meta) {
    const metaJson = JSON.stringify(meta)
    try {
      fs.writeFileSync(this._pngPath(key), png)
      fs.writeFileSync(this._metaPath(key), metaJson)
    } catch (e) {
      // A full disk must not take the map down with it: the tile is still
      // served to the browser from memory by the caller, it just is not kept.
      logLine({ level: 'error', msg: 'tile_cache_write_failed', key, error: e?.message || String(e) })
      this._forget(key)
      return false
    }
    const prev = this.index.get(key)
    if (prev) this.totalBytes -= prev.bytes
    const bytes = png.length + Buffer.byteLength(metaJson, 'utf8')
    this.index.set(key, { bytes, used: Date.now() })
    this.totalBytes += bytes
    this._evict()
    return true
  }

  // Refresh an entry's expiry after a 304, without rewriting the image.
  refresh(key, meta) {
    const entry = this.index.get(key)
    if (!entry) return
    const metaJson = JSON.stringify(meta)
    try { fs.writeFileSync(this._metaPath(key), metaJson) } catch { return }
    const now = Date.now()
    entry.used = now
    try { fs.utimesSync(this._pngPath(key), new Date(now), new Date(now)) } catch { /* recency is an optimisation */ }
  }

  _forget(key) {
    const entry = this.index.get(key)
    if (!entry) return
    this.totalBytes -= entry.bytes
    this.index.delete(key)
    try { fs.unlinkSync(this._pngPath(key)) } catch { /* already gone */ }
    try { fs.unlinkSync(this._metaPath(key)) } catch { /* already gone */ }
  }

  // Least-recently-used first, until the total is back under the bound. The
  // sort is over the in-memory index, not the filesystem, so an eviction pass
  // costs no disk reads at all.
  _evict() {
    if (this.totalBytes <= this.maxBytes) return
    const order = [...this.index.entries()].sort((a, b) => a[1].used - b[1].used)
    for (const [key] of order) {
      if (this.totalBytes <= this.maxBytes) break
      this._forget(key)
      this.evictions += 1
    }
  }

  stats() {
    return {
      dir: this.dir,
      tiles: this.index.size,
      total_bytes: this.totalBytes,
      max_bytes: this.maxBytes,
      hits: this.hits,
      misses: this.misses,
      revalidations: this.revalidations,
      evictions: this.evictions,
      upstream_failures: this.upstreamFailures,
    }
  }
}

// ---- upstream -----------------------------------------------------------

// How long the response says this tile stays good for. Cache-Control's max-age
// first (what OSM actually sends), then Expires, then the policy's 7-day floor
// for the case where neither can be read.
function ttlFrom(headers) {
  const cc = headers.get('cache-control') || ''
  const m = /max-age\s*=\s*(\d+)/i.exec(cc)
  if (m) return Number(m[1]) * 1000
  const exp = headers.get('expires')
  if (exp) {
    const at = Date.parse(exp)
    if (Number.isFinite(at)) return Math.max(0, at - Date.now())
  }
  return MIN_TTL_MS
}

async function fetchUpstream(z, x, y, { etag, lastModified, referer }) {
  const url = TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y)
  const headers = {
    // Policy 3.1/3.4. Never a library default, never a generic proxy name.
    'User-Agent': TILE_USER_AGENT,
    Accept: 'image/png,image/*;q=0.8',
  }
  // Policy 3.4: a proxy must not strip the browser's Referer. Forwarded as the
  // browser sent it; where a browser sent none, this deployment's own
  // published address stands in when it has one.
  const ref = referer || process.env.CASEY_PUBLIC_URL
  if (ref) headers.Referer = ref
  // Policy 3.2: revalidate an expired entry rather than re-downloading it.
  if (etag) headers['If-None-Match'] = etag
  else if (lastModified) headers['If-Modified-Since'] = lastModified
  // Cache-Control: no-cache is never set here, deliberately: the policy names
  // sending it by default in its must-not list.
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
  if (res.status === 304) return { status: 304, headers: res.headers }
  if (!res.ok) return { status: res.status, headers: res.headers }
  const buf = Buffer.from(await res.arrayBuffer())
  return { status: 200, headers: res.headers, body: buf }
}

// ---- the route ----------------------------------------------------------

// z/x/y are the whole of the untrusted input, and they are validated as
// integers in range before either the filesystem or the upstream URL sees
// them. Nothing string-shaped reaches a path join, so there is no traversal to
// reason about, and the zoom ceiling keeps the key space finite.
function parseTile(req) {
  const z = Number(req.params.z), x = Number(req.params.x), y = Number(req.params.y)
  if (!Number.isInteger(z) || z < 0 || z > MAX_Z) return null
  const span = 2 ** z
  if (!Number.isInteger(x) || x < 0 || x >= span) return null
  if (!Number.isInteger(y) || y < 0 || y >= span) return null
  return { z, x, y, key: `${z}-${x}-${y}` }
}

function sendTile(res, png, { contentType, expiresAt, etag }, cacheState) {
  const remaining = Math.max(0, Math.floor(((expiresAt || 0) - Date.now()) / 1000))
  res.setHeader('Content-Type', contentType || 'image/png')
  // Passed through rather than invented: the browser gets the same freshness
  // the upstream declared, so a repeat pan inside one session reaches neither
  // this server nor OSM.
  res.setHeader('Cache-Control', `public, max-age=${remaining}`)
  if (etag) res.setHeader('ETag', etag)
  // The one header that exists purely to be read by a human with devtools
  // open: it is how "the browser stopped talking to OSM" and "this tile came
  // off our own disk" are checked rather than assumed.
  res.setHeader('X-Tile-Cache', cacheState)
  res.end(png)
}

export function registerTiles(app, deps) {
  const { store } = deps
  if (!TILE_PROXY_ENABLED) {
    logLine({ level: 'info', msg: 'tile_proxy_disabled', client_tile_url: CLIENT_TILE_URL })
    return null
  }
  const cache = new TileCache({ dir: path.join(store.dataDir, 'tile-cache') })
  logLine({
    level: 'info', msg: 'tile_proxy_ready', upstream: TILE_URL,
    user_agent: TILE_USER_AGENT, ...cache.stats(),
  })

  // Registered after registerAuth, so it sits BEHIND the session gate like
  // every other non-asset route. That is deliberate and it is not only about
  // this deployment's data: an ungated tile route is an open proxy onto
  // openstreetmap.org that anyone who finds the host could point a scraper at,
  // and the policy's blocks land on the operator of the proxy, not on the
  // scraper. Leaflet requests tiles as same-origin images, so the session
  // cookie rides along and an operator never sees the difference.
  app.get('/tiles/:z/:x/:y.png', async (req, res) => {
    const t = parseTile(req)
    if (!t) return res.status(400).json({ error: 'bad tile coordinate' })

    const stored = cache.read(t.key)
    const now = Date.now()
    if (stored && (stored.meta.expiresAt || 0) > now) {
      cache.hits += 1
      return sendTile(res, stored.png, stored.meta, 'hit')
    }

    try {
      const up = await fetchUpstream(t.z, t.x, t.y, {
        etag: stored?.meta?.etag,
        lastModified: stored?.meta?.lastModified,
        referer: req.get('referer'),
      })
      if (up.status === 304 && stored) {
        // The cheapest possible outcome and the reason revalidation is worth
        // doing: the tile was already right, and no image bytes moved.
        cache.revalidations += 1
        const meta = { ...stored.meta, expiresAt: Date.now() + ttlFrom(up.headers) }
        cache.refresh(t.key, meta)
        return sendTile(res, stored.png, meta, 'revalidated')
      }
      if (up.status !== 200 || !up.body) {
        cache.upstreamFailures += 1
        // A 404 at a zoom over open sea is normal and is NOT a deployment
        // problem, so it is passed through as itself rather than dressed up.
        // map-leaflet.js only latches its warning on a RUN of failures for
        // exactly this reason.
        if (stored) return sendTile(res, stored.png, stored.meta, 'stale')
        logLine({ level: 'warn', msg: 'tile_upstream_status', key: t.key, status: up.status })
        return res.status(up.status === 404 ? 404 : 502).json({ error: 'tile unavailable upstream' })
      }
      const meta = {
        contentType: up.headers.get('content-type') || 'image/png',
        etag: up.headers.get('etag') || null,
        lastModified: up.headers.get('last-modified') || null,
        expiresAt: Date.now() + ttlFrom(up.headers),
      }
      cache.misses += 1
      cache.write(t.key, up.body, meta)
      return sendTile(res, up.body, meta, 'miss')
    } catch (e) {
      cache.upstreamFailures += 1
      // An out-of-date map is still a correct map, and on this link a stale
      // tile is far better than a grey square. Serving it is the honest
      // degradation; inventing a blank tile would not be.
      if (stored) return sendTile(res, stored.png, stored.meta, 'stale')
      // Nothing cached and nothing upstream. This is the case the operator
      // has to be told about, and the browser cannot tell it apart from "the
      // dashboard is unreachable" -- so the server says which it was.
      logLine({ level: 'error', msg: 'tile_upstream_unreachable', key: t.key, upstream: TILE_URL, error: e?.message || String(e) })
      return res.status(502).json({ error: 'the map service could not be reached from this dashboard' })
    }
  })

  return cache
}
