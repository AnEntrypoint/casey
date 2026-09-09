// backup.js  --  a consistent, restorable copy of everything this deployment
// holds, and an honest account of anything it could not copy.
//
// WHAT "EVERYTHING" IS. data/db.sqlite is not the whole story, and a backup that
// silently missed one of these would be worse than none:
//
//   data/db.sqlite            the thatcher/busybase system of record: cases,
//                             events, contacts, operator accounts.
//   data/raw-log/             the provenance tier's append-only JSONL segments
//                             (src/core/raw-log.js). Its own header calls a
//                             data-escrow export of this tier "hand over the
//                             directory", so a backup that skipped it would lose
//                             the one record of who said what, how, and when.
//   data/media/               the real photo and voice-note bytes a field worker
//                             sent (src/store/media.js writes them here; only a
//                             dataDir-relative PATH is stored in the case row,
//                             so without these files the report rows point at
//                             nothing).
//   data/runtime-events*.jsonl the supervisor's crash/reload audit sidecar
//                             (src/supervisor-runtime-events.js), including its
//                             rotated archives.
//   the freddie session dirs   every conversation casey has ever had, one
//                             session.jsonl.zstd per case, under ~/.freddie/
//                             sessions/ -- OUTSIDE data/ entirely (see
//                             src/store/agent-sessions.js). run-turn.js resumes
//                             an evicted agent from these, so they are live
//                             state, not a cache.
//
// Rather than enumerate that list and hope it stays current, this walks data/
// and copies every top-level entry it finds, snapshotting db.sqlite specially.
// A store added under data/ next year is therefore covered automatically instead
// of being silently missed -- the failure mode this whole command exists to
// avoid. Each entry lands in the manifest by name whether it succeeded or not.
//
// WHAT IS DELIBERATELY NOT COPIED, stated rather than implied:
//   .env                     channel tokens, the session-signing key, provider
//                            credentials. Writing live secrets into a backup
//                            directory -- which is then copied to a laptop, a
//                            USB stick, an object store -- is a worse exposure
//                            than the restore inconvenience it saves. Restore
//                            the .env by hand from wherever secrets are kept.
//   the config package       thatcher.config.yml / report-fields.yml /
//                            persona.cjs live in the deployer's own git repo
//                            (uhh), which is the copy that matters.
// Both are named in the manifest's `not_included` list so a restore never
// discovers them missing.
//
// CONSISTENCY. The database is snapshotted with sqlite's own `VACUUM INTO`,
// which writes a fully-checkpointed single file that is transactionally
// consistent even against a running writer. When @libsql/client cannot be
// resolved (it reaches casey as a transitive dependency of thatcher/busybase and
// is not declared in casey's own package.json), the fallback copies db.sqlite
// together with its -wal and -shm sidecars and the manifest RECORDS that the
// copy is only consistent if casey was stopped. The command says which path it
// took; it never claims the stronger guarantee it did not get.

import fs from 'node:fs'
import path from 'node:path'
import { freddieSessionsRoot } from './store/agent-sessions.js'

export const BACKUP_MANIFEST = 'manifest.json'
export const BACKUP_FORMAT = 1

// Named here so the manifest can list them and a restore can say what it is not
// bringing back. See the header for why each is excluded.
export const NOT_INCLUDED = [
  { name: '.env', why: 'holds live channel tokens and the dashboard session key; restore it by hand from wherever secrets are kept' },
  { name: 'config package (thatcher.config.yml, report-fields.yml, persona.cjs)', why: 'lives in the deployer package\'s own git repository, which is the authoritative copy' },
]

// A hand-rolled recursive copy, deliberately NOT fs.cpSync.
//
// fs.cpSync's native implementation aborts the whole PROCESS on an unreadable
// directory -- a C++ std::filesystem error, SIGABRT, exit 134 -- which no
// try/catch in JavaScript can intercept. Witnessed against a data/ containing a
// chmod-000 subdirectory: the backup died with no manifest written and no line
// naming what it could not read, which is precisely the silent-incomplete-backup
// failure this command exists to make impossible. readdirSync/copyFileSync throw
// ordinary catchable JS errors, so walking it by hand is what lets an unreadable
// entry be RECORDED instead of ending the run.
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

// A single consistent file copy of the database. Returns the store row for the
// manifest, including which mechanism actually ran.
async function snapshotDatabase(dbPath, destPath) {
  const row = { name: 'db.sqlite', kind: 'sqlite', source: dbPath, status: 'missing', method: null, bytes: 0, note: null }
  if (!fs.existsSync(dbPath)) {
    row.note = 'no database file at this path -- nothing has been stored yet, or the data directory is wrong'
    return row
  }
  try {
    const { createClient } = await import('@libsql/client')
    const client = createClient({ url: `file:${dbPath}` })
    try {
      // VACUUM INTO refuses to overwrite, so the destination must not exist.
      try { fs.rmSync(destPath, { force: true }) } catch { /* nothing there */ }
      await client.execute(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`)
    } finally {
      try { await client.close?.() } catch { /* handle release is best-effort */ }
    }
    row.status = 'ok'
    row.method = 'vacuum-into'
    row.bytes = fs.statSync(destPath).size
    row.note = 'transactionally consistent and fully checkpointed, safe to take against a running casey'
    return row
  } catch (e) {
    // Fall back to a raw copy INCLUDING the sidecars. Copying db.sqlite alone
    // while a -wal file exists is the classic silently-corrupt backup: the
    // committed transactions living in the WAL are simply absent from it.
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
      row.note = `@libsql/client could not be loaded (${e?.message || e}), so this is a plain file copy of db.sqlite${sidecars.length ? ` plus ${sidecars.join(' and ')}` : ''}. It is consistent ONLY if casey was stopped when it was taken.`
      return row
    } catch (e2) {
      row.status = 'failed'
      row.note = `could not snapshot the database: ${e2?.message || e2}`
      return row
    }
  }
}

// The freddie session transcripts. Copied whole, keyed by the project segment
// freddie itself uses, so a restore can put them back where run-turn.js will
// find them. An absent root is 'missing', not 'failed': a deployment that has
// never run a turn has no transcripts and that is not an error.
function backupSessions(sessionsRoot, destRoot) {
  const row = { name: 'freddie-sessions', kind: 'directory', source: sessionsRoot, status: 'missing', bytes: 0, files: 0, note: null }
  if (!fs.existsSync(sessionsRoot)) {
    row.note = 'no freddie sessions directory on this host -- no conversation has been stored yet'
    return row
  }
  const { bytes, files, errors } = copyTree(sessionsRoot, destRoot)
  row.bytes = bytes; row.files = files
  if (errors.length) {
    row.status = 'failed'
    row.note = `${errors.length} path(s) could not be copied, so the stored conversations are INCOMPLETE in this backup: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? ` (and ${errors.length - 5} more)` : ''}`
    return row
  }
  row.status = 'ok'
  row.note = 'stored conversations, which live outside data/ and which a data/-scoped backup would miss entirely'
  return row
}

// Take the backup. `outDir` is created; an existing non-empty directory is
// refused rather than merged, because a half-overwritten backup is the one thing
// worse than no backup -- it looks complete.
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

  // Everything else under data/, discovered rather than listed. db.sqlite and
  // its sidecars are already handled above; copying them again here would
  // overwrite the consistent snapshot with an inconsistent one.
  const handled = new Set(['db.sqlite', 'db.sqlite-wal', 'db.sqlite-shm'])
  let entries = []
  try { entries = fs.readdirSync(dataDir, { withFileTypes: true }) } catch (e) {
    stores.push({ name: 'data/', kind: 'directory', source: dataDir, status: 'failed', bytes: 0, note: `could not read the data directory: ${e?.message || e}` })
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
          row.note = `${s.errors.length} path(s) inside could not be copied, so this store is INCOMPLETE in the backup: ${s.errors.slice(0, 5).join('; ')}${s.errors.length > 5 ? ` (and ${s.errors.length - 5} more)` : ''}`
        }
      } else { fs.copyFileSync(src, dst); row.bytes = fs.statSync(dst).size; row.files = 1 }
    } catch (err) {
      row.status = 'failed'
      row.note = `could not copy: ${err?.message || err}`
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
    // Written into the artifact, not only printed: whoever reads this directory
    // during an incident is not the person who ran the command.
    restore_with: 'casey restore <this directory> --yes, with casey stopped',
  }
  fs.writeFileSync(path.join(dest, BACKUP_MANIFEST), JSON.stringify(manifest, null, 2))
  return { dir: dest, manifest, stores, failed }
}

// Put a backup back. Destructive by construction, so it refuses to guess:
// the manifest must be present and readable, and the caller must have taken an
// explicit confirmation. The live data directory is MOVED aside rather than
// overwritten, so a restore from the wrong backup is itself recoverable.
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
    throw new Error(`restore: ${dataCopy.errors.length} path(s) could not be restored, so the data directory is INCOMPLETE. The previous contents are still at ${asideParts[0] || '(nothing was moved aside)'}. First failure: ${dataCopy.errors[0]}`)
  }
  // A stale WAL beside a restored database is silent corruption: sqlite would
  // replay the OLD write-ahead log over the restored file on the next open. The
  // snapshot path already checkpointed everything into the single file, so any
  // sidecar sitting here now belongs to the database that was just moved aside.
  for (const suffix of ['-wal', '-shm']) {
    const p = path.join(live, `db.sqlite${suffix}`)
    try { if (fs.existsSync(p)) fs.rmSync(p, { force: true }) } catch { /* nothing to remove */ }
  }

  const srcSessions = path.join(src, 'freddie-sessions')
  let sessions = { status: 'missing', note: 'the backup holds no stored conversations' }
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
        ? { status: 'failed', note: `${s.errors.length} path(s) could not be restored, so the stored conversations are incomplete: ${s.errors[0]}` }
        : { status: 'ok', note: `stored conversations restored to ${sessionsRoot}` }
    } catch (e) {
      sessions = { status: 'failed', note: `could not restore the stored conversations: ${e?.message || e}` }
    }
  }
  return { dataDir: live, movedAside: asideParts, manifest, sessions }
}
