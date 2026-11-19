

import fs from 'node:fs'
import path from 'node:path'
import { freddieSessionsRoot } from './store/agent-sessions.js'
import { caseyText } from './deployment-text.js';

export const BACKUP_MANIFEST = 'manifest.json'
export const BACKUP_FORMAT = 1

export const NOT_INCLUDED = [
  { name: '.env', why: caseyText("src/backup.js#w0") },
  { name: caseyText("src/backup.js#w1"), why: caseyText("src/backup.js#w2") },
]

function copyTree(src, dest) {
  let bytes = 0
  let files = 0
  const errors = []
  const walk = (from, to) => {
    let entries
    try { entries = fs.readdirSync(from, { withFileTypes: true }) }
    catch (e) { errors.push(`${from}: ${e?.message || e}`); return }
    try { fs.mkdirSync(to, { recursive: true }) }
    catch (e) { errors.push(`${to}: ${e?.message || e}`); return }
    for (const entry of entries) {
      const f = path.join(from, entry.name)
      const t = path.join(to, entry.name)
      try {
        if (entry.isDirectory()) walk(f, t)
        else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(f), t)
        else { fs.copyFileSync(f, t); bytes += fs.statSync(t).size; files += 1 }
      } catch (e) { errors.push(`${f}: ${e?.message || e}`) }
    }
  }
  walk(src, dest)
  return { bytes, files, errors }
}

async function snapshotDatabase(dbPath, destPath) {
  const row = { name: 'db.sqlite', kind: 'sqlite', source: dbPath, status: 'missing', method: null, bytes: 0, note: null }
  if (!fs.existsSync(dbPath)) {
    row.note = caseyText("src/backup.js#w3")
    return row
  }
  try {
    const { createClient } = await import('@libsql/client')
    const client = createClient({ url: `file:${dbPath}` })
    try {

      try { fs.rmSync(destPath, { force: true }) } catch {  }
      await client.execute(caseyText("src/backup.js#w4", [destPath.replace(/'/g, "''")]))
    } finally {
      try { await client.close?.() } catch {  }
    }
    row.status = 'ok'
    row.method = 'vacuum-into'
    row.bytes = fs.statSync(destPath).size
    row.note = caseyText("src/backup.js#w5")
    return row
  } catch (e) {
    try {
      fs.copyFileSync(dbPath, destPath)
      const sidecars = []
      for (const suffix of ['-wal', '-shm']) {
        const s = dbPath + suffix
        if (fs.existsSync(s)) { fs.copyFileSync(s, destPath + suffix); sidecars.push(path.basename(s)) }
      }
      row.status = 'ok'
      row.method = 'file-copy'
      row.bytes = fs.statSync(destPath).size
      row.note = caseyText("src/backup.js#w6", [e?.message || e, sidecars.length ? ` plus ${sidecars.join(' and ')}` : ''])
      return row
    } catch (e2) {
      row.status = 'failed'
      row.note = caseyText("src/backup.js#w7", [e2?.message || e2])
      return row
    }
  }
}

function backupSessions(sessionsRoot, destRoot) {
  const row = { name: 'freddie-sessions', kind: 'directory', source: sessionsRoot, status: 'missing', bytes: 0, files: 0, note: null }
  if (!fs.existsSync(sessionsRoot)) {
    row.note = caseyText("src/backup.js#w8")
    return row
  }
  const { bytes, files, errors } = copyTree(sessionsRoot, destRoot)
  row.bytes = bytes; row.files = files
  if (errors.length) {
    row.status = 'failed'
    row.note = caseyText("src/backup.js#w9", [errors.length, errors.slice(0, 5).join('; '), errors.length > 5 ? caseyText("src/backup.js#w10", [errors.length - 5]) : ''])
    return row
  }
  row.status = 'ok'
  row.note = caseyText("src/backup.js#w11")
  return row
}

export async function runBackup({ dataDir, outDir, sessionsRoot = freddieSessionsRoot(), now = Date.now() } = {}) {
  if (!dataDir) throw new Error('backup: dataDir is required')
  if (!outDir) throw new Error('backup: outDir is required')
  const dest = path.resolve(outDir)
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) {
    throw new Error(`backup: ${dest} already exists and is not empty -- name a fresh directory rather than writing over an existing backup`)
  }
  const destData = path.join(dest, 'data')
  fs.mkdirSync(destData, { recursive: true })

  const stores = []
  const dbPath = path.join(dataDir, 'db.sqlite')
  stores.push(await snapshotDatabase(dbPath, path.join(destData, 'db.sqlite')))

  const handled = new Set(['db.sqlite', 'db.sqlite-wal', 'db.sqlite-shm'])
  let entries = []
  try { entries = fs.readdirSync(dataDir, { withFileTypes: true }) } catch (e) {
    stores.push({ name: 'data/', kind: 'directory', source: dataDir, status: 'failed', bytes: 0, note: caseyText("src/backup.js#w12", [e?.message || e]) })
  }
  for (const e of entries) {
    if (handled.has(e.name)) continue
    const src = path.join(dataDir, e.name)
    const dst = path.join(destData, e.name)
    const row = { name: e.name, kind: e.isDirectory() ? 'directory' : 'file', source: src, status: 'ok', bytes: 0, files: 0, note: null }
    try {
      if (e.isDirectory()) {
        const s = copyTree(src, dst)
        row.bytes = s.bytes; row.files = s.files
        if (s.errors.length) {
          row.status = 'failed'
          row.note = caseyText("src/backup.js#w13", [s.errors.length, s.errors.slice(0, 5).join('; '), s.errors.length > 5 ? caseyText("src/backup.js#w14", [s.errors.length - 5]) : ''])
        }
      } else { fs.copyFileSync(src, dst); row.bytes = fs.statSync(dst).size; row.files = 1 }
    } catch (err) {
      row.status = 'failed'
      row.note = caseyText("src/backup.js#w15", [err?.message || err])
    }
    stores.push(row)
  }

  stores.push(backupSessions(sessionsRoot, path.join(dest, 'freddie-sessions')))

  const failed = stores.filter(s => s.status === 'failed')
  const manifest = {
    format: BACKUP_FORMAT,
    created_at: now,
    created_at_iso: new Date(now).toISOString(),
    data_dir: path.resolve(dataDir),
    sessions_root: sessionsRoot,
    stores,
    not_included: NOT_INCLUDED,
    complete: failed.length === 0,
    restore_with: 'casey restore <this directory> --yes, with casey stopped',
  }
  fs.writeFileSync(path.join(dest, BACKUP_MANIFEST), JSON.stringify(manifest, null, 2))
  return { dir: dest, manifest, stores, failed }
}

export async function runRestore({ backupDir, dataDir, sessionsRoot = freddieSessionsRoot(), now = Date.now() } = {}) {
  const src = path.resolve(backupDir)
  const manifestPath = path.join(src, BACKUP_MANIFEST)
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`restore: ${manifestPath} not found -- this does not look like a casey backup directory`)
  }
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch (e) {
    throw new Error(`restore: ${manifestPath} could not be read as JSON: ${e?.message || e}`)
  }
  if (manifest.format !== BACKUP_FORMAT) {
    throw new Error(`restore: backup format ${manifest.format} is not the format this casey writes (${BACKUP_FORMAT})`)
  }
  const srcData = path.join(src, 'data')
  if (!fs.existsSync(srcData)) throw new Error(`restore: ${srcData} is missing -- the backup has no data directory to restore`)

  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  const live = path.resolve(dataDir)
  const asideParts = []
  if (fs.existsSync(live)) {
    const aside = `${live}.pre-restore-${stamp}`
    fs.renameSync(live, aside)
    asideParts.push(aside)
  }
  const dataCopy = copyTree(srcData, live)
  if (dataCopy.errors.length) {
    throw new Error(`restore: ${dataCopy.errors.length} path(s) could not be restored, so the data directory is INCOMPLETE. The previous contents are still at ${asideParts[0] || caseyText("src/backup.js#w17")}. First failure: ${dataCopy.errors[0]}`)
  }
  for (const suffix of ['-wal', '-shm']) {
    const p = path.join(live, `db.sqlite${suffix}`)
    try { if (fs.existsSync(p)) fs.rmSync(p, { force: true }) } catch {  }
  }

  const srcSessions = path.join(src, 'freddie-sessions')
  let sessions = { status: 'missing', note: caseyText("src/backup.js#w18") }
  if (fs.existsSync(srcSessions)) {
    try {
      if (fs.existsSync(sessionsRoot)) {
        const aside = `${sessionsRoot}.pre-restore-${stamp}`
        fs.renameSync(sessionsRoot, aside)
        asideParts.push(aside)
      }
      fs.mkdirSync(path.dirname(sessionsRoot), { recursive: true })
      const s = copyTree(srcSessions, sessionsRoot)
      sessions = s.errors.length
        ? { status: 'failed', note: caseyText("src/backup.js#w19", [s.errors.length, s.errors[0]]) }
        : { status: 'ok', note: caseyText("src/backup.js#w20", [sessionsRoot]) }
    } catch (e) {
      sessions = { status: 'failed', note: caseyText("src/backup.js#w21", [e?.message || e]) }
    }
  }
  return { dataDir: live, movedAside: asideParts, manifest, sessions }
}
