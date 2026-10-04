import fs from 'node:fs'
import path from 'node:path'
import { BRAND } from '../brand.js'

const DEFAULT_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

export const TILE_URL = process.env.CASEY_TILE_URL || DEFAULT_TILE_URL

export const TILE_PROXY_ENABLED = process.env.CASEY_TILE_PROXY !== '0'

export const CLIENT_TILE_URL = TILE_PROXY_ENABLED ? '/tiles/{z}/{x}/{y}.png' : TILE_URL

const CASEY_VERSION = '0.2.0'
export const TILE_USER_AGENT = process.env.CASEY_TILE_USER_AGENT
  || `${String(BRAND.name || 'casey').replace(/[^\x20-\x7e]/g, '').replace(/[()\/;]/g, '') || 'casey'}`
  + `/${CASEY_VERSION} (casey; ${process.env.CASEY_PUBLIC_URL || 'https://github.com/AnEntrypoint/casey'})`

export const DEFAULT_MAX_CACHE_BYTES = 256 * 1024 * 1024

const MIN_TTL_MS = 7 * 24 * 60 * 60 * 1000

const UPSTREAM_TIMEOUT_MS = Number(process.env.CASEY_TILE_TIMEOUT_MS) || 15000

const MAX_Z = 19

function logLine(fields) {
  console.log(JSON.stringify({ t: new Date().toISOString(), component: 'tiles', ...fields }))
}

const TOUCH_FLOOR_MS = 60 * 60 * 1000

export class TileCache {
  constructor({ dir, maxBytes } = {}) {
    if (!dir) throw new Error('TileCache: dir is required')
    this.dir = dir
    this.maxBytes = maxBytes || Number(process.env.CASEY_TILE_CACHE_MAX_BYTES) || DEFAULT_MAX_CACHE_BYTES
    fs.mkdirSync(this.dir, { recursive: true })
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
      try { bytes += fs.statSync(this._metaPath(key)).size } catch {  }
      this.index.set(key, { bytes, used })
      this.totalBytes += bytes
    }
    this._evict()
  }

  _pngPath(key) { return path.join(this.dir, key + '.png') }
  _metaPath(key) { return path.join(this.dir, key + '.json') }

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
      try { fs.utimesSync(this._pngPath(key), new Date(now), new Date(now)) } catch {  }
    }
    return { png, meta }
  }

  has(key) { return this.index.has(key) }

  write(key, png, meta) {
    const metaJson = JSON.stringify(meta)
    try {
      fs.writeFileSync(this._pngPath(key), png)
      fs.writeFileSync(this._metaPath(key), metaJson)
    } catch (e) {
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

  refresh(key, meta) {
    const entry = this.index.get(key)
    if (!entry) return
    const metaJson = JSON.stringify(meta)
    try { fs.writeFileSync(this._metaPath(key), metaJson) } catch { return }
    const now = Date.now()
    entry.used = now
    try { fs.utimesSync(this._pngPath(key), new Date(now), new Date(now)) } catch {  }
  }

  _forget(key) {
    const entry = this.index.get(key)
    if (!entry) return
    this.totalBytes -= entry.bytes
    this.index.delete(key)
    try { fs.unlinkSync(this._pngPath(key)) } catch {  }
    try { fs.unlinkSync(this._metaPath(key)) } catch {  }
  }

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
    'User-Agent': TILE_USER_AGENT,
    Accept: 'image/png,image/*;q=0.8',
  }
  const ref = referer || process.env.CASEY_PUBLIC_URL
  if (ref) headers.Referer = ref
  if (etag) headers['If-None-Match'] = etag
  else if (lastModified) headers['If-Modified-Since'] = lastModified
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
  if (res.status === 304) return { status: 304, headers: res.headers }
  if (!res.ok) return { status: res.status, headers: res.headers }
  const buf = Buffer.from(await res.arrayBuffer())
  return { status: 200, headers: res.headers, body: buf }
}

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
  res.setHeader('Cache-Control', `public, max-age=${remaining}`)
  if (etag) res.setHeader('ETag', etag)
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
        cache.revalidations += 1
        const meta = { ...stored.meta, expiresAt: Date.now() + ttlFrom(up.headers) }
        cache.refresh(t.key, meta)
        return sendTile(res, stored.png, meta, 'revalidated')
      }
      if (up.status !== 200 || !up.body) {
        cache.upstreamFailures += 1
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
      if (stored) return sendTile(res, stored.png, stored.meta, 'stale')
      logLine({ level: 'error', msg: 'tile_upstream_unreachable', key: t.key, upstream: TILE_URL, error: e?.message || String(e) })
      return res.status(502).json({ error: 'the map service could not be reached from this dashboard' })
    }
  })

  return cache
}
