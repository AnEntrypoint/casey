// worker-runtime-events.js  --  the worker's half of the durable runtime audit:
// the snapshot the parent pushes down for /api/runtime, and the persistence of
// each lifecycle bounce the parent buffered.
//
// Split out of bin/worker.js verbatim. The parent detects a CRASH/RELOAD/
// DEGRADED/BUDGET bounce but cannot store it (the process that observed it is
// the one that died, or has no store at all), so it flushes it here once this
// worker is READY -- which is why a crash that killed the PREVIOUS worker is
// recorded by THIS one, on a singleton runtime case, as an append-only system
// observation. Reason-only: the parent snapshot never carries external_id (PII),
// so nothing here can leak it.

const RUNTIME_EVENT_LABEL = {
  CRASH: 'CRASH', RELOAD_REQUESTED: 'RELOAD', HEALTH_DEGRADED: 'DEGRADED', BUDGET_EXCEEDED: 'CRASH-BUDGET-EXCEEDED',
}

export function createRuntimeChannel(casey) {
  // Runtime snapshot the parent pushes down (PARENT_MSG.STATE). Held in a mutable
  // closure so /api/runtime reflects the latest without rebuilding the dashboard.
  // Standalone mode leaves it null -> /api/runtime reports 'standalone'.
  let runtimeSnapshot = null
  let runtimeCaseIdP = null

  async function runtimeCaseId() {
    if (!runtimeCaseIdP) {
      runtimeCaseIdP = casey.store.findOrCreateCase({
        channel: 'system', external_id: 'runtime:supervisor',
        contact: { display_name: 'casey runtime', handle: 'runtime' },
      }).then(r => {
        if (r.created && !r.case.subject) {
          casey.store.updateCase(r.case.id, { subject: 'casey runtime lifecycle' }).catch(() => {})
        }
        return r.case.id
      })
    }
    return runtimeCaseIdP
  }

  async function recordRuntimeEvent(ev) {
    try {
      const label = RUNTIME_EVENT_LABEL[ev.event] || ev.event || 'EVENT'
      const reason = ev.reason ? ` -- ${String(ev.reason).slice(0, 300)}` : ''
      const id = await runtimeCaseId()
      await casey.store.appendEvent(id, {
        kind: 'observation', actor: 'system',
        text: `RUNTIME ${label}${reason} (restart #${ev.restarts ?? 0})`,
        data: { runtime: ev.event, restarts: ev.restarts ?? 0 },
      })
    } catch (e) { console.error('[worker] runtime-event record failed:', e.message) }
  }

  return {
    runtimeStatus: () => runtimeSnapshot,
    applySnapshot: (snap) => { runtimeSnapshot = snap || null },
    recordRuntimeEvent,
  }
}
