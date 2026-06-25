// supervisor.js  --  the parent process that keeps casey's serving worker alive,
// reloads it on source change, and restarts it on crash WITHOUT losing the store.
//
// This is the runtime half of the reliability slice. The xstate machine
// (supervisor-machine.js) is the pure transition-validation authority; THIS file
// owns the real, irreversible side-effects -- child_process.fork, kill, the
// fs.watch, the drain handshake -- and threads the live machine-state value plus a
// small context (restart count, crash timestamps, last reload/crash) it keeps
// itself. The machine answers "is event E legal from state S, and what does it
// lead to?"; the supervisor performs the effect and advances its own state value.
//
// Durable boundary: the worker holds the sqlite store (cwd-bound app.db). A reload
// or crash respawns the worker, which REOPENS the same file -- so persisted case
// data survives every restart (WAL-checkpointed by the worker's graceful drain).
// The handoff is SEQUENTIAL (old worker fully exits before the new one opens the
// store), so two processes never hold the db at once -- that race is structurally
// unrepresentable here.

import { fork } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildSupervisorMachine, canFire, crashBudgetExceeded, isTerminal,
} from './supervisor-machine.js'
import { WORKER_MSG, PARENT_MSG, ipcSend } from './supervisor-ipc.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKER_ENTRY = path.join(__dirname, '..', 'bin', 'worker.js')

// Reload/crash tuning (env-overridable; all have conservative defaults so an
// unconfigured run behaves sanely).
const RELOAD_DEBOUNCE_MS = Number(process.env.CASEY_RELOAD_DEBOUNCE_MS || 300)
const DRAIN_DEADLINE_MS = Number(process.env.CASEY_DRAIN_DEADLINE_MS || 15_000)
const CRASH_WINDOW_MS = Number(process.env.CASEY_CRASH_WINDOW_MS || 60_000)
const CRASH_LIMIT = Number(process.env.CASEY_CRASH_LIMIT || 5)
const BACKOFF_BASE_MS = Number(process.env.CASEY_RESTART_BACKOFF_MS || 500)
const BACKOFF_CEIL_MS = Number(process.env.CASEY_RESTART_BACKOFF_CEIL_MS || 10_000)

// Default the reload watch to casey's own src/, plus any extra dirs the operator
// names (CASEY_RELOAD_PATHS, comma-separated -- e.g. ../freddie/src to pick up a
// sibling change). Absent dirs are skipped with a warning, never a crash (a bare
// clone has no ../freddie).
function reloadWatchPaths() {
  const paths = [path.join(__dirname)]   // src/
  const extra = (process.env.CASEY_RELOAD_PATHS || '').split(',').map(s => s.trim()).filter(Boolean)
  for (const p of extra) paths.push(path.resolve(p))
  return paths
}

// A source file change worth a reload: .js/.mjs only, ignore the spool, dotfiles,
// node_modules, and the sqlite store itself (the worker writes app.db constantly --
// watching it would reload-storm forever).
function isReloadableChange(file) {
  if (!file) return false
  if (!/\.(mjs|js)$/.test(file)) return false
  if (file.includes('node_modules')) return false
  if (file.includes('.gm')) return false
  if (file.startsWith('.')) return false
  return true
}

export function createSupervisor(opts = {}) {
  const log = opts.log || console
  const workerArgs = opts.workerArgs || []   // passed through to the worker (--channels, --port, ...)
  const enableReload = opts.reload !== false && process.env.CASEY_RELOAD !== '0'

  const machine = buildSupervisorMachine()
  // The supervisor IS the live state: the machine value plus the context it owns.
  let state = machine.config.initial   // 'booting'
  const ctx = {
    restarts: 0,
    crashes: [],            // epoch-ms of recent unexpected worker exits
    lastReloadAt: null,
    lastCrashReason: null,
    since: null,            // epoch-ms the current state was entered (stamped by caller)
  }

  let worker = null
  let watchers = []
  let reloadTimer = null
  let reloadQueued = false   // a reload requested mid-restart is held, not dropped or stacked
  let stopping = false
  let booted = false         // the current worker has sent READY

  // --- machine-validated state advance -------------------------------------
  // Every lifecycle move goes through the machine: illegal transitions are a bug
  // we surface loudly, not silently swallow. `nowMs` is injected so the whole
  // supervisor is replayable/testable without a hidden clock.
  function fire(event, nowMs, reason) {
    const res = canFire(machine, state, event)
    if (!res.ok) {
      // An illegal transition means our effect-ordering is wrong; log loud and do
      // NOT change state (fail safe over corrupting the lifecycle).
      log.warn?.('[supervisor] illegal transition', { from: state, event, error: res.error })
      return false
    }
    const from = state
    state = res.target
    ctx.since = nowMs
    if (reason) ctx.lastCrashReason = event === 'CRASH' || event === 'HEALTH_DEGRADED' ? reason : ctx.lastCrashReason
    log.info?.('[supervisor] transition', { from, event, to: state, reason: reason || undefined })
    pushStateToWorker()
    opts.onTransition?.({ from, event, to: state, reason, ctx: snapshot() })
    return true
  }

  // The authoritative runtime snapshot the worker's /api/runtime serves. Pushed on
  // every transition AND right after a fresh worker READY (so a new worker is never
  // blank). external_id / PII never appears here -- state + counts + reason only.
  function snapshot() {
    return {
      state,
      supervised: true,
      restarts: ctx.restarts,
      lastReloadAt: ctx.lastReloadAt,
      lastCrashReason: ctx.lastCrashReason ? String(ctx.lastCrashReason).slice(0, 300) : null,
      since: ctx.since,
    }
  }
  function pushStateToWorker() {
    if (worker && worker.connected) ipcSend(worker, PARENT_MSG.STATE, snapshot())
  }

  // --- worker lifecycle -----------------------------------------------------
  function spawnWorker(nowMs) {
    booted = false
    const child = fork(WORKER_ENTRY, workerArgs, {
      // Inherit env (tokens, CASEY_*). No shell -- fork never interpolates a string,
      // so untrusted data can never reach a shell here (security invariant).
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    })
    worker = child

    child.on('message', (m) => {
      if (!m || typeof m !== 'object') return
      if (m.type === WORKER_MSG.READY) {
        booted = true
        // booting|restarting -> healthy. (restarting sends RESTART_DONE->booting
        // first; we collapse the common case by firing BOOTED from either.)
        if (state === 'restarting') fire('RESTART_DONE', Date.now())
        fire('BOOTED', Date.now())
        pushStateToWorker()   // hand the fresh worker the current snapshot immediately
        log.info?.('[supervisor] worker ready', { pid: child.pid, port: m.payload?.port })
      } else if (m.type === WORKER_MSG.HEALTH) {
        onHealth(m.payload || {}, Date.now())
      } else if (m.type === WORKER_MSG.DRAIN_COMPLETE) {
        // handled by the drain promise (resolveDrain), nothing to do here
        if (resolveDrain) resolveDrain()
      } else if (m.type === WORKER_MSG.FATAL) {
        log.error?.('[supervisor] worker fatal', { reason: m.payload?.reason })
        ctx.lastCrashReason = m.payload?.reason || 'fatal'
        // a fatal is treated as a crash on exit below; record the reason now
      }
    })

    child.on('exit', (code, signal) => {
      const now = Date.now()
      if (stopping || state === 'stopping' || state === 'stopped') return   // expected exit
      // A planned drain (reload or stop) marks the child _expectedExit BEFORE asking
      // it to drain. This per-worker flag is immune to the timing race that the
      // shared `draining` flag has: DRAIN_COMPLETE resolves the drain promise (which
      // clears `draining`) BEFORE the child's 'exit' event lands, so by the time we
      // get here `draining` is already false and the exit would be miscounted as a
      // crash -- inflating the restart count, burning a backoff, and wrongly eating
      // the crash budget on rapid reloads. The child-local flag stays true.
      if (child._expectedExit || draining) return
      // Unexpected exit == crash. Record, count against the budget, restart-or-degrade.
      ctx.crashes.push(now)
      ctx.lastCrashReason = ctx.lastCrashReason || `worker exited code=${code} signal=${signal || ''}`
      log.error?.('[supervisor] worker crashed', { code, signal, reason: ctx.lastCrashReason })
      fire('CRASH', now, ctx.lastCrashReason)
      if (crashBudgetExceeded(ctx.crashes, now, { windowMs: CRASH_WINDOW_MS, limit: CRASH_LIMIT })) {
        // Too many crashes too fast: stop the tight loop, fail loud, hold the process
        // alive in 'degraded' (the dashboard pill + /api/runtime show it) -- never a
        // silent respawn storm.
        fire('BUDGET_EXCEEDED', now, ctx.lastCrashReason)
        log.error?.('[supervisor] crash budget exceeded -- entering degraded, no further auto-restart', {
          crashes: ctx.crashes.length, windowMs: CRASH_WINDOW_MS, limit: CRASH_LIMIT,
        })
        // Do NOT respawn. An operator (or a source change -> RELOAD) recovers it.
        return
      }
      const backoff = Math.min(BACKOFF_CEIL_MS, BACKOFF_BASE_MS * Math.pow(2, ctx.restarts))
      log.info?.('[supervisor] restarting after crash', { backoffMs: backoff })
      setTimeout(() => respawn(Date.now()), backoff).unref?.()
    })

    return child
  }

  // Sequential drain-then-respawn: tell the worker to drain, await DRAIN_COMPLETE
  // (or a deadline), ensure it has exited, THEN spawn a fresh one. The old worker
  // fully releases the store before the new one opens it.
  let draining = false
  let resolveDrain = null
  function drainWorker() {
    if (!worker || !worker.connected) return Promise.resolve()
    return new Promise((resolve) => {
      draining = true
      // Mark THIS worker's coming exit as expected, on the child object itself, so a
      // late 'exit' event (arriving after DRAIN_COMPLETE has already cleared the
      // shared `draining` flag) is still recognised as planned, not a crash.
      if (worker) worker._expectedExit = true
      let done = false
      const finish = () => {
        if (done) return
        done = true
        draining = false
        resolveDrain = null
        resolve()
      }
      resolveDrain = finish
      // If the worker exits before/around DRAIN_COMPLETE, that also satisfies the drain.
      worker.once('exit', finish)
      ipcSend(worker, PARENT_MSG.DRAIN, {})
      // Bounded: a worker stuck mid-turn must not block the runtime forever. On
      // deadline, force-kill -- any stranded turn is recoverable via the resume
      // sweep (reliability-resume-on-boot), better than a wedged supervisor.
      setTimeout(() => {
        if (done) return
        log.warn?.('[supervisor] drain deadline exceeded, force-killing worker')
        try { worker?.kill('SIGKILL') } catch {}
        finish()
      }, DRAIN_DEADLINE_MS).unref?.()
    })
  }

  // A respawn for crash recovery: the old worker is already gone, just count + spawn.
  function respawn(nowMs) {
    if (stopping) return
    ctx.restarts++
    spawnWorker(nowMs)
  }

  // A reload: drain the live worker, wait for full exit, then spawn fresh code. The
  // machine is already in 'restarting' (fired by requestReload). On completion the
  // new worker's READY drives restarting->booting->healthy.
  async function reloadNow(nowMs) {
    ctx.restarts++
    ctx.lastReloadAt = nowMs
    await drainWorker()
    if (stopping) return
    spawnWorker(Date.now())
    // If another reload was requested mid-drain, run exactly one follow-up now.
    if (reloadQueued) {
      reloadQueued = false
      // Re-enter via the machine: healthy/restarting -> restarting handled by guard.
      // We are mid-restart; the queued reload coalesces into the next cycle once
      // this worker is healthy. Defer it slightly so the new worker can boot first.
      setTimeout(() => requestReload(Date.now()), RELOAD_DEBOUNCE_MS).unref?.()
    }
  }

  // --- reload watcher -------------------------------------------------------
  function requestReload(nowMs) {
    if (stopping) return
    // If already restarting (a reload/crash in flight), hold exactly one follow-up
    // rather than stacking N reloads or dropping the change.
    if (state === 'restarting') { reloadQueued = true; return }
    const fired = fire('RELOAD_REQUESTED', nowMs)
    if (fired) reloadNow(nowMs)
  }

  function armWatcher() {
    if (!enableReload) { log.info?.('[supervisor] live reload disabled'); return }
    for (const dir of reloadWatchPaths()) {
      if (!fs.existsSync(dir)) { log.warn?.('[supervisor] reload path missing, skipping', { dir }); continue }
      try {
        const w = fs.watch(dir, { recursive: true }, (_evt, file) => {
          if (!isReloadableChange(file)) return
          // Debounce: an editor save-all writes N files; coalesce into ONE reload.
          if (reloadTimer) clearTimeout(reloadTimer)
          reloadTimer = setTimeout(() => { reloadTimer = null; requestReload(Date.now()) }, RELOAD_DEBOUNCE_MS)
          reloadTimer.unref?.()
        })
        watchers.push(w)
        log.info?.('[supervisor] watching for live reload', { dir })
      } catch (e) {
        log.warn?.('[supervisor] could not watch path', { dir, error: e.message })
      }
    }
  }

  // --- health ---------------------------------------------------------------
  function onHealth(payload, nowMs) {
    if (state !== 'healthy' && state !== 'degraded') return   // only meaningful when serving
    // A wedged store or a zombie receive is a degraded runtime: heal it by restart
    // through the same drain->refork path. receiveStatus shape: per-channel
    // {connected, sinceConnectMs, sinceInboundMs}; a real-time channel connected
    // long ago with NO inbound is only SUSPICIOUS, not proof -- so the trigger is a
    // store failure (definitive) here; the zombie-receive heuristic is left to the
    // dedicated health-selfheal row to avoid false restarts on a genuinely quiet day.
    if (payload.store === false) {
      log.error?.('[supervisor] worker reports store not ready -- degrading')
      if (fire('HEALTH_DEGRADED', nowMs, 'store not ready')) reloadNow(nowMs)
      return
    }
    if (state === 'healthy') fire('HEALTH_OK', nowMs)
  }

  // --- public control -------------------------------------------------------
  async function start() {
    if (worker) return
    ctx.since = Date.now()
    spawnWorker(Date.now())
    armWatcher()
  }

  async function stop() {
    if (stopping) return
    stopping = true
    fire('STOP', Date.now())
    for (const w of watchers) { try { w.close() } catch {} }
    watchers = []
    await drainWorker()
    fire('STOPPED', Date.now())
  }

  return {
    start, stop,
    // introspection for tests + doctor + /api/runtime fallback
    get state() { return state },
    snapshot,
    isTerminal: () => isTerminal(machine, state),
    // test seams (drive lifecycle deterministically without real processes)
    _fire: fire, _ctx: ctx, _machine: machine,
    // requestReload IS the entry the fs.watch callback calls; exposing it lets a
    // test drive a genuine drain-respawn reload cycle without depending on a
    // platform-specific fs.watch event firing. Production behaviour is unchanged.
    _requestReload: (nowMs) => requestReload(nowMs ?? Date.now()),
  }
}
