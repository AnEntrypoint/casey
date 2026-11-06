const RUNTIME_EVENT_LABEL = {
  CRASH: 'CRASH', RELOAD_REQUESTED: 'RELOAD', HEALTH_DEGRADED: 'DEGRADED', BUDGET_EXCEEDED: 'CRASH-BUDGET-EXCEEDED',
}

export function createRuntimeChannel(casey) {
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
