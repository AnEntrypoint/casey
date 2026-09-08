// supervisor-worker-process.js  --  forking the serving worker and reacting to
// the two things it can tell the parent by itself: it came up, and it went away.
//
// Split out of src/supervisor.js. The fork is the supervisor's one irreversible
// effect, and the exit listener is where the restart policy is actually applied
// -- so the policy itself lives next door in supervisor-crash-policy.js and this
// module only performs what that policy returns. The IPC message routing
// (READY/HEALTH/DRAIN_COMPLETE/FATAL) is here too, so the message contract has
// exactly one reader.

import { fork } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WORKER_MSG } from './supervisor-ipc.js'
import { classifyWorkerExit } from './supervisor-crash-policy.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const WORKER_ENTRY = path.join(__dirname, '..', 'bin', 'worker.js')

// `restart` is passed as a thunk rather than a value: the restart cycle is built
// from this module's own spawn(), so the two are mutually dependent and only the
// call is deferred, never the wiring.
export function createWorkerProcess({ log, rt, sup, workerArgs, runtimeEvents, onHealth, restart }) {
  function spawn() {
    rt.booted = false
    const child = fork(WORKER_ENTRY, workerArgs, {
      // Inherit env (tokens, CASEY_*). No shell -- fork never interpolates a string,
      // so untrusted data can never reach a shell here (security invariant).
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    })
    rt.worker = child
    child.on('message', (m) => {
      if (!m || typeof m !== 'object') return
      if (m.type === WORKER_MSG.READY) handleReady(child, m.payload || {})
      else if (m.type === WORKER_MSG.HEALTH) onHealth(m.payload || {}, Date.now())
      else if (m.type === WORKER_MSG.DRAIN_COMPLETE) restart().completeDrain()
      else if (m.type === WORKER_MSG.FATAL) {
        log.error?.('[supervisor] worker fatal', { reason: m.payload?.reason })
        // A fatal is treated as a crash on exit below; record the reason now.
        sup.ctx.lastCrashReason = m.payload?.reason || 'fatal'
      }
    })
    child.on('exit', (code, signal) => handleExit(code, signal, child))
    return child
  }

  function handleReady(child, payload) {
    rt.booted = true
    // booting|restarting -> healthy. (restarting sends RESTART_DONE->booting
    // first; we collapse the common case by firing BOOTED from either.)
    if (sup.state === 'restarting') sup.fire('RESTART_DONE', Date.now())
    const bootedOk = sup.fire('BOOTED', Date.now())
    if (!bootedOk && sup.state !== 'healthy') sup.resyncHealthy(Date.now())
    sup.pushStateToWorker()   // hand the fresh worker the current snapshot immediately
    runtimeEvents.flush()     // persist any lifecycle bounce buffered while no worker was up (e.g. the crash that killed the prior one)
    log.info?.('[supervisor] worker ready', { pid: child.pid, port: payload?.port })
  }

  function handleExit(code, signal, child) {
    const now = Date.now()
    if (rt.stopping || sup.state === 'stopping' || sup.state === 'stopped') return   // expected exit
    // A planned drain (reload or stop) marks the child _expectedExit BEFORE asking
    // it to drain. This per-worker flag is immune to the timing race that the
    // shared `draining` flag has: DRAIN_COMPLETE resolves the drain promise (which
    // clears `draining`) BEFORE the child's 'exit' event lands, so by the time we
    // get here `draining` is already false and the exit would be miscounted as a
    // crash -- inflating the restart count, burning a backoff, and wrongly eating
    // the crash budget on rapid reloads. The child-local flag stays true.
    if (child._expectedExit || rt.draining) return
    const decision = classifyWorkerExit({
      code, signal, now,
      crashes: sup.ctx.crashes,
      restarts: sup.ctx.restarts,
      lastCrashReason: sup.ctx.lastCrashReason,
    })
    if (decision.kind === 'config-fatal') {
      sup.fire('BUDGET_EXCEEDED', now, decision.reason)
      log.error?.('[supervisor] worker port is already in use (another casey running?) -- not restarting. Stop the other instance or pass a different --port.', { code })
      return
    }
    // Unexpected exit == crash. Record, count against the budget, restart-or-degrade.
    sup.ctx.crashes = decision.crashes
    sup.ctx.lastCrashReason = decision.reason
    log.error?.('[supervisor] worker crashed', { code, signal, reason: decision.reason })
    sup.fire('CRASH', now, decision.reason)
    if (decision.kind === 'budget') {
      sup.fire('BUDGET_EXCEEDED', now, decision.reason)
      log.error?.('[supervisor] crash budget exceeded -- entering degraded, no further auto-restart', {
        crashes: decision.crashes.length, windowMs: decision.windowMs, limit: decision.limit,
      })
      // Do NOT respawn. An operator (or a source change -> RELOAD) recovers it.
      return
    }
    log.info?.('[supervisor] restarting after crash', { backoffMs: decision.backoffMs })
    setTimeout(() => restart().respawn(Date.now()), decision.backoffMs).unref?.()
  }

  return { spawn }
}
