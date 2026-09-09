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

// freddie's source root, resolved against a FIXED ordered candidate list. The
// watch list stays an allowlist of paths this file names literally -- never
// anything derived from contact input -- and this only chooses which of the
// three named paths is the one that exists here.
//
// Three candidates because casey runs in two layouts and freddie changed shape:
// (1) the submodule checkout casey actually resolves freddie from, the same
// <caseyRoot>/deps/freddie root scripts/link-deps.mjs walks, and the only one
// that exists when casey is itself vendored (uhh/deps/casey); (2) that same
// pnpm-workspace layout in a SIBLING checkout, casey's standalone dev layout;
// (3) the legacy flat sibling ../freddie/src.
//
// The bare '../freddie/src' this defaulted to resolved OUTSIDE the tree in the
// vendored layout AND named a directory freddie no longer has in either layout
// -- freddie's current tree carries no root src/ at all, its ~220 packages each
// hold their own packages/<group>/<name>/src -- so editing freddie never
// reloaded the worker and the only signal was one skipped-path line at boot.
//
// packages/ is watched whole rather than per-package src/: one recursive watcher
// covers all of them (measured ~220ms to arm, ~30MB RSS) and isReloadableChange
// already drops every node_modules path pnpm links underneath it.
const FREDDIE_SOURCE_CANDIDATES = [
  path.resolve(__dirname, '..', 'deps', 'freddie', 'packages'),
  path.resolve(__dirname, '..', '..', 'freddie', 'packages'),
  path.resolve(__dirname, '..', '..', 'freddie', 'src'),
]

// Default the reload watch to casey's own src/ plus freddie's source root, plus
// any extra dirs the operator names (CASEY_RELOAD_PATHS, comma-separated).
// Absent dirs are skipped with a warning, never a crash.
export function reloadWatchPaths() {
  const paths = [path.join(__dirname)]   // src/
  // freddie is resolved through node_modules junctions, but a developer editing
  // the freddie checkout (agent harness + gateway adapters) needs those saves to
  // reload the worker too, else the running build silently diverges. Watched by
  // DEFAULT, existence-guarded by armReloadWatchers' fs.existsSync. When no
  // candidate exists the first is still returned, so the missing-path warning
  // fires and hot reload is never quietly half-armed. (thatcher is an npm dep
  // with no local source tree to watch; its db.sqlite is the durable boundary,
  // reopened per worker -- nothing to hot-reload there.)
  paths.push(FREDDIE_SOURCE_CANDIDATES.find(p => fs.existsSync(p)) || FREDDIE_SOURCE_CANDIDATES[0])
  const extra = (process.env.CASEY_RELOAD_PATHS || '').split(',').map(s => s.trim()).filter(Boolean)
  for (const p of extra) paths.push(path.resolve(p))
  // Dedup: an operator naming freddie's source root in CASEY_RELOAD_PATHS must
  // not arm two watchers on the same dir (double-fire on every freddie save).
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
    // Say what the skip COSTS, not just that it happened. This line is the only
    // notice a developer ever gets that saves under this dir will not reload the
    // worker; "reload path missing, skipping" reads as harmless housekeeping and
    // scrolls past, and then edits appear to do nothing for as long as it takes
    // someone to suspect the watcher.
    if (!fs.existsSync(dir)) { log.warn?.('[supervisor] reload path does not exist - edits under it will NOT reload the worker (nothing else will say so; name a real dir in CASEY_RELOAD_PATHS)', { dir }); continue }
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
