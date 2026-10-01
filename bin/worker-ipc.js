import { WORKER_MSG, PARENT_MSG, ipcSend } from '../src/supervisor-ipc.js'

export function installWorkerRuntimeIo({ casey, dash, forked, runtime }) {
  let draining = false
  async function drainAndExit(code = 0) {
    if (draining) return
    draining = true
    try { await dash.close() } catch (e) { console.error('[worker] dash close error:', e.message) }
    try { await casey.stop() } catch (e) { console.error('[worker] casey stop error:', e.message) }
    if (forked) ipcSend(process, WORKER_MSG.DRAIN_COMPLETE, {})
    setTimeout(() => process.exit(code), 50)
  }

  function reportHealth() {
    if (!forked) return
    let receive = null
    try { receive = casey.receiveStatus() } catch { receive = null }
    ipcSend(process, WORKER_MSG.HEALTH, {
      receive,
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
    const hb = setInterval(reportHealth, 10_000)
    hb.unref?.()
    ipcSend(process, WORKER_MSG.READY, { port: dash.port })
    reportHealth()
  } else {
    console.log(`casey worker (standalone) on http://localhost:${dash.port}`)
    process.on('SIGINT', () => drainAndExit(0))
    process.on('SIGTERM', () => drainAndExit(0))
  }

  return { drainAndExit, reportHealth }
}
