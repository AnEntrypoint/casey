import fs from 'node:fs/promises'
import path from 'node:path'
import { mountRoutes } from './register.js'

export const DIGEST_FILE = /^casey-digest-(\d{4}-\d{2})\.(csv|txt)$/

const KINDS = { csv: { kind: 'csv', type: 'text/csv; charset=utf-8' }, txt: { kind: 'text', type: 'text/plain; charset=utf-8' } }

export const digestsDir = (store) => path.join(store.dataDir, 'digests')

export function listFiles({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    let names
    try { names = await fs.readdir(digestsDir(store)) } catch (e) {
      if (e.code === 'ENOENT') return res.json([])
      throw e
    }
    const rows = []
    for (const name of names) {
      const m = DIGEST_FILE.exec(name)
      if (!m) continue
      const st = await fs.stat(path.join(digestsDir(store), name))
      if (!st.isFile()) continue
      rows.push({ name, month: m[1], kind: KINDS[m[2]].kind, bytes: st.size, modified: st.mtime.toISOString() })
    }
    rows.sort((a, b) => b.month.localeCompare(a.month) || a.name.localeCompare(b.name))
    res.json(rows)
  }
}

export function getFile({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const name = req.params.name
    const m = DIGEST_FILE.exec(name)
    if (!m) return res.status(404).json({ error: 'not found' })
    let body
    try { body = await fs.readFile(path.join(digestsDir(store), name)) } catch (e) {
      if (e.code === 'ENOENT') return res.status(404).json({ error: 'not found' })
      throw e
    }
    res.setHeader('Content-Type', KINDS[m[2]].type)
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(body)
  }
}

const ROUTES = [
  ['get', '/api/reports/files', listFiles],
  ['get', '/api/reports/files/:name', getFile],
]

export function registerReportFiles(app, deps) {
  mountRoutes(app, deps, ROUTES)
}
