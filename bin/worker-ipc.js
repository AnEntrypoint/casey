// worker-ipc.js  --  the worker's run mode: the graceful drain, the health
// self-report, and the two mutually exclusive ways this process is driven --
// the supervisor's IPC contract when forked, or SIGINT when standalone.
//
// Split out of bin/worker.js verbatim. READY is still announced LAST, after the
// dashboard is bound and serving, so the parent's 'booting -> healthy'
// transition reflects a truly-serving worker.

import { WORKER_MSG, PARENT_MSG, ipcSend } from '../src/supervisor-ipc.js'

export function installWorkerRuntimeIo({ casey, dash, forked, runtime }) {
  // Graceful drain shared by SIGINT (standalone) and PARENT_MSG.DRAIN (forked):
  // close the dashboard, let casey.stop() finish in-flight turns + flush the WAL,
  // then exit. Guarded against re-entry so a double signal cannot race the WAL
  // flush (the same guard the legacy `up` path had).
  let draining = false
  async function drainAndExit(code = 0) {
    if (draining) return
    draining = true
    try { await dash.close() } catch (e) { console.error('[worker] dash close error:', e.message) }
    try { await casey.stop() } catch (e) { console.error('[worker] casey stop error:', e.message) }
    if (forked) ipcSend(process, WORKER_MSG.DRAIN_COMPLETE, {})
    // Give the IPC message a tick to flush before exit so the parent reliably sees
    // DRAIN_COMPLETE rather than only the raw 'exit' event.
    setTimeout(() => process.exit(code), 50)
  }

  function reportHealth() {
    if (!forked) return
    let receive = null
    try { receive = casey.receiveStatus() } catch { receive = null }
    ipcSend(process, WORKER_MSG.HEALTH, {
      receive,
      // store readiness: a cheap truthiness check; a wedged store surfaces as a
      // missing/false flag the parent can act on without us blocking here.
      store: !!casey.store,
    })
  }

  if (forked) {
    process.on('message', (m) => {
      if (!m || typeof m !== 'object') return
      if (m.type === PARENT_MSG.DRAIN) drainAndExit(0)
      else if (m.type === PARENT_MSG.HEALTH_QUERY) reportHealth()
      else if (m.type === PARENT_MSG.STATE) runtime.applySnapshot(m.payload)
      else if (m.type === PARENT_MSG.RUNTIME_EVENT) runtime.recordRuntimeEvent(m.payload || {})
    })
    // Periodic self-report so the parent can detect a wedged worker (no ticks)
    // distinct from a crashed one (exit event). Unref'd: it never holds the worker
    // alive on its own.
    const hb = setInterval(reportHealth, 10_000)
    hb.unref?.()
    // Announce readiness LAST -- only once the dashboard is bound and serving, so
    // the parent's 'booting -> healthy' transition reflects a truly-serving worker.
    ipcSend(process, WORKER_MSG.READY, { port: dash.port })
    reportHealth()
  } else {
    // Standalone: own the SIGINT path exactly like the legacy single-process `up`.
    console.log(`casey worker (standalone) on http://localhost:${dash.port}`)
    process.on('SIGINT', () => drainAndExit(0))
    process.on('SIGTERM', () => drainAndExit(0))
  }

  return { drainAndExit, reportHealth }
}
