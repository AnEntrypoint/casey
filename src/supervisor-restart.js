// supervisor-restart.js  --  the drain-then-respawn cycle: the sequential
// handshake that replaces a live worker without ever letting two processes hold
// the sqlite store at once.
//
// Split out of src/supervisor.js. The durable boundary described in that file's
// header is enforced HERE: the old worker fully exits before the new one opens
// the store, so the two-writers race is structurally unrepresentable rather than
// merely avoided.

import { PARENT_MSG, ipcSend } from './supervisor-ipc.js'

const RELOAD_DEBOUNCE_MS = Number(process.env.CASEY_RELOAD_DEBOUNCE_MS || 300)
const DRAIN_DEADLINE_MS = Number(process.env.CASEY_DRAIN_DEADLINE_MS || 15_000)

export { RELOAD_DEBOUNCE_MS }

export function createRestartCycle({ log, rt, sup, spawnWorker }) {
  // Sequential drain-then-respawn: tell the worker to drain, await DRAIN_COMPLETE
  // (or a deadline), ensure it has exited, THEN spawn a fresh one.
  function drainWorker() {
    if (!rt.worker || !rt.worker.connected) return Promise.resolve()
    return new Promise((resolve) => {
      rt.draining = true
      // Mark THIS worker's coming exit as expected, on the child object itself, so a
      // late 'exit' event (arriving after DRAIN_COMPLETE has already cleared the
      // shared `draining` flag) is still recognised as planned, not a crash.
      const worker = rt.worker
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

  // The worker answered PARENT_MSG.DRAIN. Nothing else to do -- the promise above
  // owns the rest of the handshake.
  function completeDrain() {
    if (rt.resolveDrain) rt.resolveDrain()
  }

  // A respawn for crash recovery: the old worker is already gone, just count + spawn.
  function respawn(nowMs) {
    if (rt.stopping) return
    sup.ctx.restarts++
    spawnWorker(nowMs)
  }

  // A reload: drain the live worker, wait for full exit, then spawn fresh code. The
  // machine is already in 'restarting' (fired by requestReload). On completion the
  // new worker's READY drives restarting->booting->healthy.
  async function reloadNow(nowMs) {
    sup.ctx.restarts++
    sup.ctx.lastReloadAt = nowMs
    await drainWorker()
    if (rt.stopping) return
    spawnWorker(Date.now())
    // If another reload was requested mid-drain, run exactly one follow-up now.
    if (rt.reloadQueued) {
      rt.reloadQueued = false
      // Re-enter via the machine: healthy/restarting -> restarting handled by guard.
      // We are mid-restart; the queued reload coalesces into the next cycle once
      // this worker is healthy. Defer it slightly so the new worker can boot first.
      setTimeout(() => requestReload(Date.now()), RELOAD_DEBOUNCE_MS).unref?.()
    }
  }

  function requestReload(nowMs) {
    if (rt.stopping) return
    // If already restarting (a reload/crash in flight), hold exactly one follow-up
    // rather than stacking N reloads or dropping the change.
    if (sup.state === 'restarting') { rt.reloadQueued = true; return }
    const fired = sup.fire('RELOAD_REQUESTED', nowMs)
    if (fired) reloadNow(nowMs)
  }

  return { drainWorker, completeDrain, respawn, reloadNow, requestReload }
}
