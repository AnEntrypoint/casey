// supervisor-ipc.js  --  the parent<->child message contract for casey's
// supervised runtime. Shared by src/supervisor.js (parent) and the worker entry
// so both speak exactly one protocol; a typo in a message type fails at import,
// not silently at runtime.
//
// Ownership split (resolves reliability-worker-ipc-contract): the WORKER holds the
// live serving surface (gateway + dashboard + store) and is exactly what restarts.
// The PARENT holds the AUTHORITATIVE runtime state (the supervisor machine value,
// restart count, last-reload/last-crash) because that state must SURVIVE a worker
// respawn -- a worker that just died cannot report why. So:
//   - the worker tells the parent only EPHEMERAL facts it alone observes
//     (it became ready; a health tick; its receiveHealth snapshot; it finished
//     draining) via WORKER_MSG;
//   - the parent commands the worker (drain and exit; report health now) via
//     PARENT_MSG;
//   - the runtime-state API (/api/runtime) is served BY the worker's dashboard but
//     reads a snapshot the PARENT pushes down on each transition (PARENT_MSG.STATE),
//     so the dashboard surface and the parent machine never disagree, and a fresh
//     worker is handed the last-known runtime state immediately after READY rather
//     than starting blank.

// worker -> parent
export const WORKER_MSG = Object.freeze({
  READY: 'worker:ready',            // gateway+dashboard up; payload {port}
  HEALTH: 'worker:health',          // periodic self-report; payload {receive, llm, store}
  DRAIN_COMPLETE: 'worker:drained', // responded to DRAIN; in-flight turns finished
  FATAL: 'worker:fatal',            // worker hit an unrecoverable boot/runtime error; payload {reason}
})

// parent -> worker
export const PARENT_MSG = Object.freeze({
  DRAIN: 'parent:drain',            // stop accepting inbound, finish in-flight, then exit
  HEALTH_QUERY: 'parent:health?',   // request an immediate HEALTH report
  STATE: 'parent:state',            // push the authoritative runtime snapshot; payload {state, restarts, lastReloadAt, lastCrashReason, since}
})

// A tiny helper so senders never hand-roll the {type,payload} envelope shape.
export function ipcSend(target, type, payload = {}) {
  if (target && typeof target.send === 'function') {
    try { target.send({ type, payload }) } catch { /* peer gone; caller handles via 'exit' */ }
  }
}
