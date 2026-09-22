// supervisor.js  --  the parent process that keeps casey's serving worker alive,
// reloads it on source change, and restarts it on crash WITHOUT losing the store.
//
// This is the runtime half of the reliability slice. The xstate machine
// (supervisor-machine.js) is the pure transition-validation authority; THIS file
// owns the real, irreversible side-effects -- child_process.fork, kill, the
// drain handshake -- and threads the live machine-state value plus a
// small context (restart count, crash timestamps, last reload/crash) it keeps
// itself. The machine answers "is event E legal from state S, and what does it
// lead to?"; the supervisor performs the effect and advances its own state value.
//
// What is left in this file is the ASSEMBLY: it wires one collaborator per
// lifecycle concern and holds the shared mutable runtime record (`rt`) they all
// read, because that record is exactly the thing no single one of them owns.
// Each concern lives beside it, none of them a lifecycle effect on its own:
//   supervisor-machine.js        legal transitions
//   supervisor-state.js          the live state value, its context, and the snapshot
//   supervisor-worker-process.js fork, the IPC message contract, worker ready/exit
//   supervisor-crash-policy.js   the crash budget, the backoff, exit code 44, the parent's own net
//   supervisor-restart.js        the sequential drain-then-respawn cycle
//   supervisor-health.js         reading a HEALTH tick and deciding "degraded"
//   supervisor-reload-watch.js   "a watched source file changed, once"
//   supervisor-runtime-events.js "get this bounce durably recorded even though
//                                 the process that detected it cannot store it"
//
// Durable boundary: the worker holds the sqlite store (cwd-bound db.sqlite). A reload
// or crash respawns the worker, which REOPENS the same file -- so persisted case
// data survives every restart (WAL-checkpointed by the worker's graceful drain).
// The handoff is SEQUENTIAL (old worker fully exits before the new one opens the
// store), so two processes never hold the db at once -- that race is structurally
// unrepresentable here.

import path from 'node:path'
import { buildSupervisorMachine } from './supervisor-machine.js'
import { PARENT_MSG, ipcSend } from './supervisor-ipc.js'
import { armReloadWatchers } from './supervisor-reload-watch.js'
import { createRuntimeEventBuffer } from './supervisor-runtime-events.js'
import { createSupervisorState } from './supervisor-state.js'
import { createWorkerProcess } from './supervisor-worker-process.js'
import { createRestartCycle, RELOAD_DEBOUNCE_MS } from './supervisor-restart.js'
import { installParentCrashNet } from './supervisor-crash-policy.js'
import { applyWorkerHealth, detectZombieReceive } from './supervisor-health.js'

// Re-exported from its own module so the single real-services witness (and any
// other caller that imported it from here) keeps one import path.
export { detectZombieReceive }

export function createSupervisor(opts = {}) {
  const log = opts.log || console
  installParentCrashNet(log)
  const workerArgs = opts.workerArgs || []   // passed through to the worker (--channels, --port, ...)
  const enableReload = opts.reload !== false && process.env.CASEY_RELOAD !== '0'

  const machine = buildSupervisorMachine()
  // The one piece of state no single collaborator owns: the live child, whether
  // it has sent READY, and the three flags that coordinate a drain/stop/reload
  // across them. Held here so each module below reads one record rather than
  // each keeping a copy that can drift.
  const rt = {
    worker: null,
    booted: false,          // the current worker has sent READY
    watchers: [],
    stopping: false,
    reloadQueued: false,    // a reload requested mid-restart is held, not dropped or stacked
    draining: false,
    resolveDrain: null,
    keepAlive: null,        // the parent's own event-loop handle -- see armKeepAlive
  }

  // Durable runtime-lifecycle events (CRASH / RELOAD / DEGRADED / BUDGET) that must
  // land in the store as audited observations so the timeline + shift-handover show
  // the runtime was bounced and why -- buffered until a live, READY worker can
  // persist them, and mirrored to a JSONL sidecar so a pre-READY crash loop still
  // leaves a trail. See supervisor-runtime-events.js for the full reasoning; the
  // only part the supervisor itself knows is whether a worker can take one now.
  const runtimeEvents = createRuntimeEventBuffer({
    log,
    logPath: path.join(process.cwd(), 'data', 'runtime-events.jsonl'),
    deliver: (entry) => {
      if (!rt.worker || !rt.worker.connected || !rt.booted) return false   // hold until a live, ready worker can persist
      ipcSend(rt.worker, PARENT_MSG.RUNTIME_EVENT, entry)
      return true
    },
  })

  const sup = createSupervisorState({
    machine, log,
    onTransition: (t) => opts.onTransition?.(t),
    onRuntimeEvent: (event, reason, nowMs) => runtimeEvents.emit({ event, reason: reason || null, restarts: sup.ctx.restarts, ts: nowMs }),
    deliverSnapshot: (snap) => { if (rt.worker && rt.worker.connected) ipcSend(rt.worker, PARENT_MSG.STATE, snap) },
  })

  const onHealth = (payload, nowMs) => applyWorkerHealth({
    log, sup, payload, nowMs, reload: (at) => restart.reloadNow(at),
  })
  const workerProcess = createWorkerProcess({
    log, rt, sup, workerArgs, runtimeEvents, onHealth,
    restart: () => restart,
  })
  const restart = createRestartCycle({ log, rt, sup, spawnWorker: (nowMs) => workerProcess.spawn(nowMs) })

  // Arm the live-reload watchers, or say once that reload is off. The watcher
  // module owns the paths, the change filter, the debounce and the per-path
  // failure handling; the supervisor supplies the one thing only it can -- what
  // a debounced change actually means here, which is requestReload.
  function armWatcher() {
    if (!enableReload) { log.info?.('[supervisor] live reload disabled'); return }
    rt.watchers = armReloadWatchers({
      log,
      debounceMs: RELOAD_DEBOUNCE_MS,
      onChange: () => restart.requestReload(Date.now()),
    })
  }

  // --- public control -------------------------------------------------------
  // The supervisor owns no socket, no file watch it can rely on, and no timer of
  // its own: every long-lived handle in a healthy runtime belongs to the WORKER
  // (dashboard socket, gateway socket, sweep timers). So in every window where
  // the worker is gone -- between a crash and its respawn, and permanently once
  // the crash budget has stopped respawning -- the parent can be holding nothing
  // at all, and Node exits a process holding nothing. That turns two documented
  // behaviours into silent exits: the crash-restart itself (see the restart timer
  // in supervisor-worker-process.js) and the budget-exceeded hold, which
  // supervisor-crash-policy.js describes as "hold the process alive in
  // 'degraded' (the dashboard pill + /api/runtime show it)" -- a state nobody can
  // observe on a process that has ended. Live reload happens to mask it, because
  // its fs.watch watchers hold the loop; `casey up --no-reload` does not.
  //
  // One ref'd, never-firing timer from start() to stop() makes the supervisor's
  // own lifetime independent of what it is currently supervising. Cleared in
  // stop(), so an intentional shutdown still exits promptly.
  const KEEPALIVE_TICK_MS = 1 << 30   // ~12.4 days; a handle, not a schedule
  function armKeepAlive() {
    if (rt.keepAlive) return
    rt.keepAlive = setInterval(() => {}, KEEPALIVE_TICK_MS)
  }
  function releaseKeepAlive() {
    if (!rt.keepAlive) return
    clearInterval(rt.keepAlive)
    rt.keepAlive = null
  }

  async function start() {
    if (rt.worker) return
    sup.ctx.since = Date.now()
    armKeepAlive()
    workerProcess.spawn(Date.now())
    armWatcher()
  }

  async function stop() {
    if (rt.stopping) return
    rt.stopping = true
    sup.fire('STOP', Date.now())
    for (const w of rt.watchers) { try { w.close() } catch {} }
    rt.watchers = []
    await restart.drainWorker()
    sup.fire('STOPPED', Date.now())
    releaseKeepAlive()
  }

  return {
    start, stop,
    // introspection for tests + doctor + /api/runtime fallback
    get state() { return sup.state },
    snapshot: sup.snapshot,
    isTerminal: sup.isTerminal,
    // test seams (drive lifecycle deterministically without real processes)
    _fire: sup.fire, _ctx: sup.ctx, _machine: machine,
    // requestReload IS the entry the fs.watch callback calls; exposing it lets a
    // test drive a genuine drain-respawn reload cycle without depending on a
    // platform-specific fs.watch event firing. Production behaviour is unchanged.
    _requestReload: (nowMs) => restart.requestReload(nowMs ?? Date.now()),
  }
}
