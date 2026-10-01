

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const FREDDIE_SOURCE_CANDIDATES = [
  path.resolve(__dirname, '..', 'deps', 'freddie', 'framework'),
  path.resolve(__dirname, '..', '..', 'freddie', 'framework'),
]

export function reloadWatchPaths() {
  const paths = [path.join(__dirname)]

  paths.push(FREDDIE_SOURCE_CANDIDATES.find(p => fs.existsSync(p)) || FREDDIE_SOURCE_CANDIDATES[0])
  const extra = (process.env.CASEY_RELOAD_PATHS || '').split(',').map(s => s.trim()).filter(Boolean)
  for (const p of extra) paths.push(path.resolve(p))

  return [...new Set(paths)]
}

export function isReloadableChange(file) {
  if (!file) return false
  if (!/\.(mjs|js)$/.test(file)) return false
  if (file.includes('node_modules')) return false
  if (file.includes('.gm')) return false
  if (file.startsWith('.')) return false
  return true
}

export function armReloadWatchers({ log, debounceMs, onChange }) {
  const watchers = []
  let timer = null
  for (const dir of reloadWatchPaths()) {

    if (!fs.existsSync(dir)) { log.warn?.('[supervisor] reload path does not exist - edits under it will NOT reload the worker (nothing else will say so; name a real dir in CASEY_RELOAD_PATHS)', { dir }); continue }
    try {
      const w = fs.watch(dir, { recursive: true }, (_evt, file) => {
        if (!isReloadableChange(file)) return

        if (timer) clearTimeout(timer)

        timer = setTimeout(() => { timer = null; onChange() }, debounceMs)
      })

      w.on('error', (e) => {
        log.warn?.('[supervisor] watch error, disabling live reload for this path', { dir, error: e.message })
        try { w.close() } catch {  }
      })
      watchers.push(w)
      log.info?.('[supervisor] watching for live reload', { dir })
    } catch (e) {
      log.warn?.('[supervisor] could not watch path', { dir, error: e.message })
    }
  }
  return watchers
}

export const RELOAD_SWEEP_INTERVAL_MS = Number(process.env.CASEY_RELOAD_SWEEP_MS || 20_000)
const SWEEP_MAX_FILES = 20_000
const SWEEP_SKIP_DIR = (name) => name === 'node_modules' || name.startsWith('.')

function newestSourceMtime(dirs) {
  let newest = 0
  let seen = 0
  const walk = (dir) => {
    if (seen > SWEEP_MAX_FILES) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (seen > SWEEP_MAX_FILES) return
      if (e.isDirectory()) { if (!SWEEP_SKIP_DIR(e.name)) walk(path.join(dir, e.name)); continue }
      if (!isReloadableChange(e.name)) continue
      seen++
      try {
        const m = fs.statSync(path.join(dir, e.name)).mtimeMs
        if (m > newest) newest = m
      } catch {  }
    }
  }
  for (const dir of dirs) { if (fs.existsSync(dir)) walk(dir) }
  return newest
}

export function armReloadMtimeBackstop({ log, intervalMs = RELOAD_SWEEP_INTERVAL_MS, lastReloadAt, onChange }) {
  const dirs = reloadWatchPaths()
  let baseline = newestSourceMtime(dirs)
  const timer = setInterval(() => {
    const newest = newestSourceMtime(dirs)
    if (newest <= baseline) return
    baseline = newest
    const handledAt = Number(lastReloadAt?.() || 0)
    if (newest <= handledAt) return
    log.warn?.('[supervisor] a source change was found by the mtime backstop, not by the file watcher -- the watcher has stopped delivering events; reloading anyway', {
      newestMtime: new Date(newest).toISOString(), lastReloadAt: handledAt ? new Date(handledAt).toISOString() : null,
    })
    onChange()
  }, intervalMs)
  timer.unref?.()
  return { close: () => clearInterval(timer) }
}
