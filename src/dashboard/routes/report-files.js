import fs from 'node:fs/promises'
import path from 'node:path'
import { mountRoutes } from './register.js'
import { DIGEST_STATUS_FILE, lastCompletedMonth } from '../../report-digest.js'
import { caseyText } from '../../deployment-text.js';
import { digestMonthIsTest, parseLaunchCutoff, readDomainSettings } from '../../test-material.js'

export const DIGEST_FILE = /^casey-digest-(\d{4}-\d{2})\.(csv|txt)$/

const KINDS = { csv: { kind: 'csv', type: 'text/csv; charset=utf-8' }, txt: { kind: 'text', type: 'text/plain; charset=utf-8' } }

export const digestsDir = (store) => path.join(store.dataDir, 'digests')

async function readStatus(dir) {
  try { return JSON.parse(await fs.readFile(path.join(dir, DIGEST_STATUS_FILE), 'utf8')) } catch { return {} }
}

function monthsBetween(first, last) {
  const out = []
  let [y, m] = first.split('-').map(Number)
  while (true) {
    const id = `${y}-${String(m).padStart(2, '0')}`
    if (id > last) break
    out.push(id)
    m += 1
    if (m > 12) { m = 1; y += 1 }
  }
  return out
}

const stateOf = (s) => (s?.ok === false ? 'failed' : s?.incomplete ? 'incomplete' : 'ok')

export function listFiles({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const dir = digestsDir(store)
    const cutoffMs = parseLaunchCutoff(readDomainSettings().launch_cutoff)
    const hiddenMonth = (month) => Date.now() >= cutoffMs && digestMonthIsTest(month, cutoffMs)
    let names
    try { names = await fs.readdir(dir) } catch (e) {
      if (e.code === 'ENOENT') names = []
      else throw e
    }
    const status = await readStatus(dir)
    const rows = []
    for (const name of names) {
      const m = DIGEST_FILE.exec(name)
      if (!m || hiddenMonth(m[1])) continue
      const st = await fs.stat(path.join(dir, name))
      if (!st.isFile()) continue
      rows.push({ name, month: m[1], kind: KINDS[m[2]].kind, bytes: st.size, modified: st.mtime.toISOString(), status: stateOf(status[m[1]]), test_material: digestMonthIsTest(m[1], cutoffMs) ? 'test' : '' })
    }
    const have = new Set(rows.map(r => r.month))
    const evidence = [...have, ...Object.keys(status)].filter(k => /^\d{4}-\d{2}$/.test(k)).sort()
    if (evidence.length) {
      const last = lastCompletedMonth()
      for (const month of monthsBetween(evidence[0], last)) {
        if (have.has(month) || hiddenMonth(month)) continue
        rows.push({ name: null, month, kind: 'missing', bytes: 0, modified: null, status: status[month]?.ok === false ? 'failed' : 'missing', error: status[month]?.error ?? null })
      }
    }
    rows.sort((a, b) => b.month.localeCompare(a.month) || (a.name ?? '').localeCompare(b.name ?? ''))
    res.json(rows)
  }
}

export function getFile({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const name = req.params.name
    const m = DIGEST_FILE.exec(name)
    if (!m) return res.status(404).json({ error: caseyText("src/dashboard/routes/report-files.js#w0") })
    let body
    try { body = await fs.readFile(path.join(digestsDir(store), name)) } catch (e) {
      if (e.code === 'ENOENT') return res.status(404).json({ error: caseyText("src/dashboard/routes/report-files.js#w1") })
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
