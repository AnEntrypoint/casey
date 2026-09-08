// supervisor-state.js  --  the supervisor's own live state: the machine value,
// the small context it keeps beside it (restart count, crash timestamps, last
// reload/crash), the machine-validated advance, and the snapshot the worker's
// /api/runtime serves.
//
// Split out of src/supervisor.js: this half performs NO irreversible effect --
// it validates a transition against the xstate machine, moves the value, and
// notifies. Every real side-effect (fork, kill, drain) stays in supervisor.js,
// which is what the effect-vs-authority split in that file's header describes.

import { canFire, isTerminal } from './supervisor-machine.js'

// Which transitions mean "the runtime was disrupted and why" and so deserve a
// durable audited observation -- not the routine BOOTED/HEALTH_OK churn that
// would flood the timeline.
const AUDITED_EVENTS = new Set(['CRASH', 'RELOAD_REQUESTED', 'HEALTH_DEGRADED', 'BUDGET_EXCEEDED'])

export function createSupervisorState({ machine, log, onTransition, onRuntimeEvent, deliverSnapshot }) {
  // The supervisor IS the live state: the machine value plus the context it owns.
  let state = machine.config.initial   // 'booting'
  const ctx = {
    restarts: 0,
    crashes: [],            // epoch-ms of recent unexpected worker exits
    lastReloadAt: null,
    lastCrashReason: null,
    since: null,            // epoch-ms the current state was entered (stamped by caller)
  }

  // The authoritative runtime snapshot the worker's /api/runtime serves. Pushed on
  // every transition AND right after a fresh worker READY (so a new worker is never
  // blank). external_id / PII never appears here -- state + counts + reason only.
  function snapshot() {
    return {
      state,
      supervised: true,
      restarts: ctx.restarts,
      lastReloadAt: ctx.lastReloadAt,
      lastCrashReason: ctx.lastCrashReason ? String(ctx.lastCrashReason).slice(0, 300) : null,
      since: ctx.since,
    }
  }
  function pushStateToWorker() {
    deliverSnapshot(snapshot())
  }

  // Every lifecycle move goes through the machine: illegal transitions are a bug
  // we surface loudly, not silently swallow. `nowMs` is injected so the whole
  // supervisor is replayable/testable without a hidden clock.
  function fire(event, nowMs, reason) {
    const res = canFire(machine, state, event)
    if (!res.ok) {
      // An illegal transition means our effect-ordering is wrong; log loud and do
      // NOT change state (fail safe over corrupting the lifecycle).
      log.warn?.('[supervisor] illegal transition', { from: state, event, error: res.error })
      return false
    }
    const from = state
    state = res.target
    ctx.since = nowMs
    if (reason) ctx.lastCrashReason = event === 'CRASH' || event === 'HEALTH_DEGRADED' ? reason : ctx.lastCrashReason
    log.info?.('[supervisor] transition', { from, event, to: state, reason: reason || undefined })
    pushStateToWorker()
    // A runtime bounce is an auditable action: buffer it for durable persistence by
    // the worker.
    if (AUDITED_EVENTS.has(event)) onRuntimeEvent(event, reason, nowMs)
    onTransition({ from, event, to: state, reason, ctx: snapshot() })
    return true
  }

  // A confirmed-live worker (we just got its READY message) whose BOOTED fire was
  // still illegal means the machine diverged from reality via a race (e.g.
  // onHealth fired HEALTH_DEGRADED between RESTART_DONE and BOOTED) -- without a
  // resync, state stays stuck at whatever it was forever, since nothing else
  // re-fires BOOTED later. Force a resync to healthy directly: the worker being up
  // is ground truth here.
  function resyncHealthy(nowMs) {
    log.warn?.('[supervisor] resyncing stuck state to healthy after confirmed worker READY', { stuckState: state })
    state = 'healthy'
    ctx.since = nowMs
  }

  return {
    ctx,
    get state() { return state },
    snapshot,
    pushStateToWorker,
    fire,
    resyncHealthy,
    isTerminal: () => isTerminal(machine, state),
    machine,
  }
}
