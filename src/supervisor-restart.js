

import { PARENT_MSG, ipcSend } from './supervisor-ipc.js'

const RELOAD_DEBOUNCE_MS = Number(process.env.CASEY_RELOAD_DEBOUNCE_MS || 300)
const DRAIN_DEADLINE_MS = Number(process.env.CASEY_DRAIN_DEADLINE_MS || 15_000)

export { RELOAD_DEBOUNCE_MS }

export function createRestartCycle({ log, rt, sup, spawnWorker }) {

  function drainWorker() {
    const worker = rt.worker
    if (!worker || worker.exitCode !== null || worker.signalCode !== null) return Promise.resolve()
    if (!worker.connected) return terminateWorker(worker)
    return new Promise((resolve) => {
      rt.draining = true

      worker._expectedExit = true
      let done = false
      const finish = () => {
        if (done) return
        done = true
        rt.draining = false
        rt.resolveDrain = null
        resolve()
      }
      rt.resolveDrain = finish

      worker.once('exit', finish)
      ipcSend(worker, PARENT_MSG.DRAIN, {})

      setTimeout(() => {
        if (done) return
        log.warn?.('[supervisor] drain deadline exceeded, force-killing worker')
        try { worker?.kill('SIGKILL') } catch {}
        finish()
      }, DRAIN_DEADLINE_MS).unref?.()
    })
  }

  function terminateWorker(worker) {
    return new Promise((resolve) => {
      rt.draining = true
      worker._expectedExit = true
      const finish = () => {
        rt.draining = false
        resolve()
      }
      worker.once('exit', finish)
      try { worker.kill('SIGTERM') } catch {}
      setTimeout(() => {
        if (worker.exitCode !== null || worker.signalCode !== null) return
        log.warn?.('[supervisor] disconnected worker ignored SIGTERM, force-killing', { pid: worker.pid })
        try { worker.kill('SIGKILL') } catch {}
      }, DRAIN_DEADLINE_MS).unref?.()
    })
  }

  function completeDrain() {
    if (rt.resolveDrain) rt.resolveDrain()
  }

  function respawn(nowMs) {
    if (rt.stopping) return
    sup.ctx.restarts++
    spawnWorker(nowMs)
  }

  async function reloadNow(nowMs) {
    sup.ctx.restarts++
    sup.ctx.lastReloadAt = nowMs
    await drainWorker()
    if (rt.stopping) return
    spawnWorker(Date.now())

    if (rt.reloadQueued) {
      rt.reloadQueued = false

      setTimeout(() => requestReload(Date.now()), RELOAD_DEBOUNCE_MS).unref?.()
    }
  }

  function requestReload(nowMs) {
    if (rt.stopping) return

    if (sup.state === 'booting') { rt.reloadDeferred = true; return }
    if (sup.state === 'restarting') { rt.reloadQueued = true; return }
    const fired = sup.fire('RELOAD_REQUESTED', nowMs)
    if (fired) reloadNow(nowMs)
  }

  return { drainWorker, completeDrain, respawn, reloadNow, requestReload }
}
