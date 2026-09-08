// supervisor-reload-watch.js  --  "a source file changed, once" as a single
// unit: which directories to watch, which changes count, the debounce that
// collapses an editor's save-all into one reload, and the per-path failure
// handling that must never take the supervisor down with it.
//
// Split out of supervisor.js. The supervisor keeps the irreversible
// side-effects it owns (fork, kill, the drain handshake) and now takes the
// reload signal as a callback instead of also owning fs.watch bookkeeping.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Default the reload watch to casey's own src/, plus any extra dirs the operator
// names (CASEY_RELOAD_PATHS, comma-separated -- e.g. ../freddie/src to pick up a
// sibling change). Absent dirs are skipped with a warning, never a crash (a bare
// clone has no ../freddie).
export function reloadWatchPaths() {
  const paths = [path.join(__dirname)]   // src/
  // freddie is an npm dependency, but a developer editing a sibling ../freddie
  // checkout (agent harness + gateway adapters) needs those saves to reload the
  // worker too, else the running build silently diverges. Watched by DEFAULT,
  // existence-guarded by armReloadWatchers' fs.existsSync -- a bare clone (no
  // sibling) simply skips it with a warning, never crashes. (thatcher is an npm
  // dep with no local source tree to watch; its db.sqlite is the durable
  // boundary, reopened per worker -- nothing to hot-reload there.)
  const freddieSrc = path.resolve(__dirname, '..', '..', 'freddie', 'src')
  paths.push(freddieSrc)
  const extra = (process.env.CASEY_RELOAD_PATHS || '').split(',').map(s => s.trim()).filter(Boolean)
  for (const p of extra) paths.push(path.resolve(p))
  // Dedup: an operator naming ../freddie/src in CASEY_RELOAD_PATHS must not arm two
  // watchers on the same dir (double-fire on every freddie save).
  return [...new Set(paths)]
}

// A source file change worth a reload: .js/.mjs only, ignore the spool, dotfiles,
// node_modules, and the sqlite store itself (the worker writes db.sqlite constantly --
// watching it would reload-storm forever).
export function isReloadableChange(file) {
  if (!file) return false
  if (!/\.(mjs|js)$/.test(file)) return false
  if (file.includes('node_modules')) return false
  if (file.includes('.gm')) return false
  if (file.startsWith('.')) return false
  return true
}

/**
 * Arm one recursive watcher per reload path. Returns the live FSWatchers so the
 * caller can close them on stop; an empty array means nothing is watched.
 *
 * @param {object} opts
 * @param {object} opts.log
 * @param {number} opts.debounceMs
 * @param {()=>void} opts.onChange  fired at most once per debounce window
 */
export function armReloadWatchers({ log, debounceMs, onChange }) {
  const watchers = []
  let timer = null
  for (const dir of reloadWatchPaths()) {
    if (!fs.existsSync(dir)) { log.warn?.('[supervisor] reload path missing, skipping', { dir }); continue }
    try {
      const w = fs.watch(dir, { recursive: true }, (_evt, file) => {
        if (!isReloadableChange(file)) return
        // Debounce: an editor save-all writes N files; coalesce into ONE reload.
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => { timer = null; onChange() }, debounceMs)
        timer.unref?.()
      })
      // An FSWatcher can emit 'error' ASYNCHRONOUSLY after a successful fs.watch()
      // call (dir deleted, permission change mid-run -- common on Windows recursive
      // watches) -- the try/catch below only guards the synchronous fs.watch() call
      // itself. An unhandled 'error' event throws inside the SUPERVISOR process, the
      // one process whose job is to keep the worker alive and restart on crash, with
      // no restart-with-backoff for this failure -- just total supervisor death.
      // Disable reload for this one path and keep the supervisor running.
      w.on('error', (e) => {
        log.warn?.('[supervisor] watch error, disabling live reload for this path', { dir, error: e.message })
        try { w.close() } catch { /* already closing */ }
      })
      watchers.push(w)
      log.info?.('[supervisor] watching for live reload', { dir })
    } catch (e) {
      log.warn?.('[supervisor] could not watch path', { dir, error: e.message })
    }
  }
  return watchers
}
