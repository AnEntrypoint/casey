

import { fork } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WORKER_MSG } from './supervisor-ipc.js'
import { classifyWorkerExit } from './supervisor-crash-policy.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const WORKER_ENTRY = path.join(__dirname, '..', 'bin', 'worker.js')

const STDERR_TAIL_LINES = 40
const STDERR_PARTIAL_LINE_CAP = 8192

function causeFromStderrTail(lines) {
  const meaningful = lines.filter(l => l.trim() && !/^\s+at\s/.test(l) && !/^Node\.js v/.test(l.trim()))
  const named = meaningful.filter(l => /(?:^|\s)[A-Za-z]*(?:Error|Exception)\b/.test(l))
  const pick = named.length ? named[named.length - 1] : meaningful[meaningful.length - 1]
  return pick ? pick.trim().slice(0, 200) : null
}

function absorbStderrChunk(child, text) {
  const parts = ((child._stderrRest || '') + text).split(/\r?\n/)
  child._stderrRest = parts.pop().slice(-STDERR_PARTIAL_LINE_CAP)
  child._stderrTail.push(...parts)
  if (child._stderrTail.length > STDERR_TAIL_LINES) child._stderrTail = child._stderrTail.slice(-STDERR_TAIL_LINES)
}
function flushStderrTail(child) {
  if (child._stderrRest) { child._stderrTail.push(child._stderrRest); child._stderrRest = '' }
  return child._stderrTail
}

export function createWorkerProcess({ log, rt, sup, workerArgs, runtimeEvents, onHealth, restart }) {
  let pendingRestartTimer = null
  function spawn() {
    rt.booted = false
    const child = fork(WORKER_ENTRY, workerArgs, {

      stdio: ['inherit', 'inherit', 'pipe', 'ipc'],
    })
    rt.worker = child
    child._stderrTail = []
    child._stderrRest = ''
    child.stderr?.on('data', (chunk) => {

      try { process.stderr.write(chunk) } catch {  }
      absorbStderrChunk(child, chunk.toString('utf8'))
    })
    child.on('message', (m) => {
      if (!m || typeof m !== 'object') return
      if (m.type === WORKER_MSG.READY) handleReady(child, m.payload || {})
      else if (m.type === WORKER_MSG.HEALTH) onHealth(m.payload || {}, Date.now())
      else if (m.type === WORKER_MSG.DRAIN_COMPLETE) restart().completeDrain()

      else if (m.type === WORKER_MSG.RELOAD_REQUEST) {
        log.info?.('[supervisor] worker asked for a full restart (its in-process hot reload could not apply the change)', { reason: m.payload?.reason })
        restart().requestReload(Date.now())
      }
      else if (m.type === WORKER_MSG.FATAL) {
        log.error?.('[supervisor] worker fatal', { reason: m.payload?.reason })

        child._fatalReason = m.payload?.reason || 'fatal'
        sup.ctx.lastCrashReason = child._fatalReason
      }
    })
    child.on('exit', (code, signal) => handleExit(code, signal, child))
    return child
  }

  function handleReady(child, payload) {
    rt.booted = true

    if (sup.state === 'restarting') sup.fire('RESTART_DONE', Date.now())
    const bootedOk = sup.fire('BOOTED', Date.now())
    if (!bootedOk && sup.state !== 'healthy') sup.resyncHealthy(Date.now())
    sup.pushStateToWorker()
    runtimeEvents.flush()
    log.info?.('[supervisor] worker ready', { pid: child.pid, port: payload?.port })
  }

  function handleExit(code, signal, child) {
    const now = Date.now()
    if (rt.stopping || sup.state === 'stopping' || sup.state === 'stopped') return

    if (child._expectedExit || rt.draining) return
    const decision = classifyWorkerExit({
      code, signal, now,
      crashes: sup.ctx.crashes,
      restarts: sup.ctx.restarts,

      lastCrashReason: child._fatalReason || (() => {
        const cause = causeFromStderrTail(flushStderrTail(child))
        return cause ? `worker exited code=${code} signal=${signal || ''} -- ${cause}` : null
      })(),
    })
    if (decision.kind === 'config-fatal') {
      sup.fire('BUDGET_EXCEEDED', now, decision.reason)
      log.error?.('[supervisor] worker port is already in use (another casey running?) -- not restarting. Stop the other instance or pass a different --port.', { code })
      return
    }

    sup.ctx.crashes = decision.crashes
    sup.ctx.lastCrashReason = decision.reason
    log.error?.('[supervisor] worker crashed', { code, signal, reason: decision.reason })
    sup.fire('CRASH', now, decision.reason)
    if (decision.kind === 'budget') {
      sup.fire('BUDGET_EXCEEDED', now, decision.reason)
      log.error?.('[supervisor] crash budget exceeded -- entering degraded, no further auto-restart', {
        crashes: decision.crashes.length, windowMs: decision.windowMs, limit: decision.limit,
      })

      return
    }
    log.info?.('[supervisor] restarting after crash', { backoffMs: decision.backoffMs })

    pendingRestartTimer = setTimeout(() => { pendingRestartTimer = null; restart().respawn(Date.now()) }, decision.backoffMs)
  }

  function cancelPendingRestart() {
    if (!pendingRestartTimer) return
    clearTimeout(pendingRestartTimer)
    pendingRestartTimer = null
  }

  return { spawn, cancelPendingRestart }
}
