import path from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { caseListProjection } from './cases.js'
import { assigneeNamer } from '../assignee-names.js'
import { publicExternalLink } from './external-links.js'
import { verifyApiKey, findByPrefix, touchLastUsed, parseScopes, keyPrefix } from '../../sync/api-key-auth.js'
import { KINDS } from '../../sync/adapters/base.js'

const SYNC_RATE_WINDOW_MS = Number(process.env.CASEY_SYNC_API_RATE_WINDOW_MS) || 60_000
const SYNC_RATE_LIMIT = Number(process.env.CASEY_SYNC_API_RATE_LIMIT) || 120

function makeSyncRateLimiter() {
  const buckets = new Map()
  setInterval(() => {
    const now = Date.now()
    for (const [id, b] of buckets) if (now - b.windowStart > SYNC_RATE_WINDOW_MS) buckets.delete(id)
  }, SYNC_RATE_WINDOW_MS).unref?.()
  return function syncRateLimited(req, res, next) {
    const id = req.syncApiKey?.id || 'unauthenticated'
    const now = Date.now()
    let b = buckets.get(id)
    if (!b || now - b.windowStart > SYNC_RATE_WINDOW_MS) { b = { count: 0, windowStart: now }; buckets.set(id, b) }
    b.count++
    if (b.count > SYNC_RATE_LIMIT) {
      const retryAfter = Math.max(1, Math.ceil((SYNC_RATE_WINDOW_MS - (now - b.windowStart)) / 1000))
      res.set('Retry-After', String(retryAfter))
      return res.status(429).json({ error: 'rate limit exceeded', retry_after_s: retryAfter })
    }
    next()
  }
}

function authenticateSyncKey({ store }) {
  return async function (req, res, next) {
    const header = req.get('authorization') || ''
    const m = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (!m) return res.status(401).json({ error: 'unauthorized' })
    const raw = m[1].trim()
    const prefix = keyPrefix(raw)
    let candidates
    try { candidates = await findByPrefix(store, prefix) }
    catch { return res.status(401).json({ error: 'unauthorized' }) }
    const match = candidates.find(k => k.disabled !== '1' && verifyApiKey(raw, k.key_salt, k.key_hash))
    if (!match) return res.status(401).json({ error: 'unauthorized' })
    req.syncApiKey = { id: match.id, label: match.label, scopes: parseScopes(match.scopes) }
    touchLastUsed(store, match.id)
    next()
  }
}

function requireScope(scope) {
  return function (req, res, next) {
    if (!req.syncApiKey) return res.status(401).json({ error: 'unauthorized' })
    if (!req.syncApiKey.scopes.has(scope)) return res.status(403).json({ error: `missing required scope: ${scope}` })
    next()
  }
}

export function getSyncCases({ store, clampLimit, offsetOf, computeFillRate }) {
  return async (req, res) => {
    const limit = clampLimit(req.query.limit, 50)
    const offset = offsetOf(req.query.offset)
    const where = {}
    if (req.query.status) where.status = req.query.status
    const cases = await store.listCases(where, { limit, offset })
    const total = await store.countCases(where)
    const withFill = cases.map(c => ({ ...c, fill_rate: computeFillRate(c.report) }))
    const named = await assigneeNamer(store, withFill)
    res.json({ cases: withFill.map(c => caseListProjection(c, named)), total, limit, offset })
  }
}

export function getSyncExternalLinks({ store, clampLimit, offsetOf }) {
  return async (req, res) => {
    const status = ['proposed', 'confirmed', 'rejected'].includes(req.query.status) ? req.query.status : 'proposed'
    const limit = clampLimit(req.query.limit, 100)
    const rows = await store.t.list('external_link', { status }, { limit, sort: [{ field: 'created_at', dir: 'DESC' }] })
    res.json({ links: rows.map(publicExternalLink) })
  }
}

export function postSyncExternalLink({ store }) {
  return async (req, res) => {
    const b = req.body || {}
    if (!b.local_entity || !['case', 'contact'].includes(b.local_entity)) return res.status(400).json({ error: 'local_entity must be case or contact' })
    if (!b.local_id) return res.status(400).json({ error: 'local_id is required' })
    if (!b.external_entity) return res.status(400).json({ error: 'external_entity is required' })
    const row = await store.t.create('external_link', {
      system: 'meat_naturally',
      local_entity: b.local_entity, local_id: String(b.local_id),
      external_entity: String(b.external_entity), external_id: String(b.external_id || ''),
      external_ref: String(b.external_ref || '').slice(0, 200),
      match_basis: String(b.match_basis || 'external-proposed').slice(0, 100),
      confidence: String(Math.min(1, Math.max(0, Number(b.confidence) || 0))),
      status: 'proposed',
      notes: String(b.notes || '').slice(0, 2000),
    }, { id: `sync-api:${req.syncApiKey.id}`, role: 'agent' })
    res.status(201).json({ link: publicExternalLink(row) })
  }
}

export function postSyncImport({ store }) {
  return async (req, res) => {
    const kind = req.body?.kind
    const records = req.body?.records
    if (!KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` })
    if (!Array.isArray(records)) return res.status(400).json({ error: 'records must be an array' })
    const dir = path.join(store.dataDir, 'sync-import')
    mkdirSync(dir, { recursive: true })
    const outFile = path.join(dir, `${kind}.json`)
    writeFileSync(outFile, JSON.stringify({ kind, imported_at: new Date().toISOString(), source: `sync-api:${req.syncApiKey.id}`, records }, null, 2))
    res.status(201).json({ kind, count: records.length, written_to: outFile })
  }
}

const ROUTES = [
  ['get', '/api/sync/cases', getSyncCases],
  ['get', '/api/sync/external-links', getSyncExternalLinks],
  ['post', '/api/sync/external-links', postSyncExternalLink],
  ['post', '/api/sync/import', postSyncImport],
]

const ROUTE_SCOPES = {
  '/api/sync/cases': 'read:cases',
  '/api/sync/external-links::get': 'read:links',
  '/api/sync/external-links::post': 'write:links',
  '/api/sync/import': 'import:records',
}

export function registerSyncApi(app, deps) {
  const { store, wrap } = deps
  const authRequired = authenticateSyncKey({ store })
  const rateLimited = makeSyncRateLimiter()
  app.use('/api/sync', authRequired, rateLimited)
  for (const [method, path, factory] of ROUTES) {
    const scopeKey = ROUTE_SCOPES[`${path}::${method}`] ? `${path}::${method}` : path
    const scope = ROUTE_SCOPES[scopeKey]
    app[method](path, requireScope(scope), wrap(factory(deps)))
  }
}
