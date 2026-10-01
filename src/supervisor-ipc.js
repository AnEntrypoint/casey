

export const WORKER_MSG = Object.freeze({
  READY: 'worker:ready',
  HEALTH: 'worker:health',
  DRAIN_COMPLETE: 'worker:drained',
  FATAL: 'worker:fatal',

  RELOAD_REQUEST: 'worker:reload-request',
})

export const PARENT_MSG = Object.freeze({
  DRAIN: 'parent:drain',
  HEALTH_QUERY: 'parent:health?',
  STATE: 'parent:state',
  RUNTIME_EVENT: 'parent:runtime-event',
})

export function ipcSend(target, type, payload = {}) {
  if (target && typeof target.send === 'function') {
    try { target.send({ type, payload }) } catch {  }
  }
}
