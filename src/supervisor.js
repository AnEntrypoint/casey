

import path from 'node:path'
import { buildSupervisorMachine } from './supervisor-machine.js'
import { PARENT_MSG, ipcSend } from './supervisor-ipc.js'
import { armReloadWatchers, armReloadMtimeBackstop } from './supervisor-reload-watch.js'
import { createRuntimeEventBuffer } from './supervisor-runtime-events.js'
import { createSupervisorState } from './supervisor-state.js'
import { createWorkerProcess } from './supervisor-worker-process.js'
import { createRestartCycle, RELOAD_DEBOUNCE_MS } from './supervisor-restart.js'
import { installParentCrashNet } from './supervisor-crash-policy.js'
import { applyWorkerHealth, detectZombieReceive } from './supervisor-health.js'

export { detectZombieReceive }

export function createSupervisor(opts = {}) {
  const log = opts.log || console
  installParentCrashNet(log)
  const workerArgs = opts.workerArgs || []
  const enableReload = opts.reload !== false && process.env.CASEY_RELOAD !== '0'

  const machine = buildSupervisorMachine()

  const rt = {
    worker: null,
    booted: false,
    watchers: [],
    stopping: false,
    reloadQueued: false,
    draining: false,
    resolveDrain: null,
    keepAlive: null,
  }

  const runtimeEvents = createRuntimeEventBuffer({
    log,
    logPath: path.join(process.cwd(), 'data', 'runtime-events.jsonl'),
    deliver: (entry) => {
      if (!rt.worker || !rt.worker.connected || !rt.booted) return false
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

  function armWatcher() {
    if (!enableReload) { log.info?.('[supervisor] live reload disabled'); return }
    const onChange = () => restart.requestReload(Date.now())
    rt.watchers = armReloadWatchers({ log, debounceMs: RELOAD_DEBOUNCE_MS, onChange })

    rt.watchers.push(armReloadMtimeBackstop({
      log, onChange,
      lastReloadAt: () => sup.ctx.lastReloadAt || sup.ctx.since || 0,
    }))
  }

  const KEEPALIVE_TICK_MS = 1 << 30
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

    try {
      await restart.drainWorker()
      sup.fire('STOPPED', Date.now())
    } finally {
      releaseKeepAlive()
      workerProcess.cancelPendingRestart()
    }
  }

  return {
    start, stop,

    get state() { return sup.state },
    snapshot: sup.snapshot,
    isTerminal: sup.isTerminal,

    _fire: sup.fire, _ctx: sup.ctx, _machine: machine,

    _requestReload: (nowMs) => restart.requestReload(nowMs ?? Date.now()),
  }
}
