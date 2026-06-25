// supervisor-machine.js  --  the casey PROCESS/RUNTIME lifecycle as a real
// xstate machine, mirroring case-machine.js exactly in spirit.
//
// casey's `up` used to track liveness with a single ad-hoc boolean (`exiting`),
// so "what state is the runtime in?" was implicit and uncheckable. That logic now
// lives in a real xstate v5 machine: an illegal lifecycle move (e.g. RELOAD while
// already STOPPING) is rejected by the machine's own resolution, not by bespoke
// flag juggling we have to keep correct.
//
// IMPORTANT ownership boundary (mirrors case-machine.js P10): this machine is the
// TRANSITION-VALIDATION AUTHORITY only. The supervisor (src/supervisor.js) owns
// the REAL side-effects -- forking/killing the child worker, arming the watcher,
// draining in-flight turns. Process side-effects (spawn/kill) are genuinely real
// and irreversible, so they must NOT live inside the machine as invoked actors
// where a replayed/validated transition could double-fire a spawn. The supervisor
// holds the live state (current machine state value + a small context it threads
// itself) and asks this pure surface two questions: "is event E legal from state
// S?" and "what does E lead to?". One decision surface, no second source of truth,
// no actor that could spawn a process as a side effect of mere validation.
//
// Lifecycle:
//   booting    -- parent forked the worker; awaiting its READY ipc message
//   healthy    -- worker READY and last health tick OK; normal serving
//   degraded   -- a health tick reported a zombie/wedged worker, or the crash
//                 budget tripped; the supervisor is failing loud, NOT tight-looping
//   restarting -- a crash or reload is being handled: drain -> kill -> re-fork
//   stopping   -- operator asked to stop; draining before final exit
//   stopped    -- terminal; the process is on its way out
//
// Events:
//   BOOTED            worker sent READY                  (booting|restarting -> healthy)
//   HEALTH_OK         a health tick passed               (healthy|degraded -> healthy)
//   HEALTH_DEGRADED   a health tick failed (zombie recv) (healthy -> restarting)
//   CRASH             worker exited unexpectedly         (healthy|degraded|booting -> restarting)
//   RELOAD_REQUESTED  a watched source file changed      (healthy|degraded -> restarting)
//   RESTART_DONE      drain+kill+refork complete         (restarting -> booting)
//   BUDGET_EXCEEDED   too many crashes in the window     (restarting -> degraded)
//   STOP              operator/SIGINT                    (any non-terminal -> stopping)
//   STOPPED           drain complete, exiting            (stopping -> stopped)

import { createMachine } from 'xstate'

// The lifecycle is fixed (unlike case-machine's config-driven graph), so the
// transition table is declared directly. Each state lists the events legal from
// it and their target. RELOAD/HEALTH_DEGRADED both funnel through `restarting`
// so the drain->kill->refork path is single and shared (one code path to keep
// correct, per "the worst-case integration is one row").
const RUNTIME_STATES = {
  booting: {
    on: { BOOTED: { target: 'healthy' }, CRASH: { target: 'restarting' }, STOP: { target: 'stopping' } },
  },
  healthy: {
    on: {
      HEALTH_OK: { target: 'healthy' },
      HEALTH_DEGRADED: { target: 'restarting' },
      CRASH: { target: 'restarting' },
      RELOAD_REQUESTED: { target: 'restarting' },
      STOP: { target: 'stopping' },
    },
  },
  degraded: {
    on: {
      // From degraded we still accept a fresh boot result and a manual reload --
      // a degraded runtime must be RECOVERABLE (a good reload or a successful
      // re-fork heals it), never a dead-end that needs a full process restart.
      HEALTH_OK: { target: 'healthy' },
      RELOAD_REQUESTED: { target: 'restarting' },
      CRASH: { target: 'restarting' },
      STOP: { target: 'stopping' },
    },
  },
  restarting: {
    on: {
      RESTART_DONE: { target: 'booting' },
      BUDGET_EXCEEDED: { target: 'degraded' },
      // A crash WHILE restarting (the new worker dies on boot) re-enters restarting
      // so the budget guard -- enforced by the supervisor, not the machine -- can
      // count it and trip BUDGET_EXCEEDED instead of looping forever.
      CRASH: { target: 'restarting' },
      STOP: { target: 'stopping' },
    },
  },
  stopping: {
    on: { STOPPED: { target: 'stopped' } },
  },
  stopped: {
    type: 'final',
    on: {},
  },
}

export function buildSupervisorMachine() {
  return createMachine({ id: 'supervisor', initial: 'booting', states: RUNTIME_STATES })
}

// Is `event` legal from `from`? Pure, derived from the machine definition, never
// from a live actor -- identical shape to case-machine's canTransition so the two
// validation surfaces read the same. Returns the resolved target on success so the
// supervisor never has to re-derive it.
export function canFire(machine, from, event) {
  const node = machine.config.states?.[from]
  if (!node) return { ok: false, error: `invalid runtime state "${from}"` }
  const def = node.on && node.on[event]
  if (!def) {
    const allowed = node.on ? Object.keys(node.on).join(', ') : ''
    return { ok: false, error: `event "${event}" illegal in "${from}"; allowed: ${allowed || 'none'}` }
  }
  return { ok: true, target: def.target }
}

// The events legal from `from`, for introspection (doctor/runtime API).
export function nextEvents(machine, from) {
  const node = machine.config.states?.[from]
  if (!node || !node.on) return []
  return Object.keys(node.on)
}

// Crash-loop budget, enforced by the supervisor and witnessed here so the rule is
// declarative and testable in isolation. `times` are epoch-ms of recent crashes;
// `now` and the window/limit are passed in (no hidden clock -- pure, replayable,
// and the test can drive it deterministically). True => the supervisor should fire
// BUDGET_EXCEEDED instead of another restart, i.e. stop the tight loop and fail
// loud (full -> degraded -> safe-fail ladder, never a silent catastrophic respawn).
export function crashBudgetExceeded(times, now, { windowMs = 60_000, limit = 5 } = {}) {
  if (!Array.isArray(times) || times.length < limit) return false
  const recent = times.filter(t => Number.isFinite(t) && now - t <= windowMs)
  return recent.length >= limit
}

// Convenience: is this a terminal state? (the supervisor stops dispatching once here)
export function isTerminal(machine, state) {
  return machine.config.states?.[state]?.type === 'final'
}
