

import { canFire, isTerminal } from './supervisor-machine.js'

const AUDITED_EVENTS = new Set(['CRASH', 'RELOAD_REQUESTED', 'HEALTH_DEGRADED', 'BUDGET_EXCEEDED'])

export function createSupervisorState({ machine, log, onTransition, onRuntimeEvent, deliverSnapshot }) {

  let state = machine.config.initial
  const ctx = {
    restarts: 0,
    crashes: [],
    lastReloadAt: null,
    lastCrashReason: null,
    since: null,
  }

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

  function fire(event, nowMs, reason) {
    const res = canFire(machine, state, event)
    if (!res.ok) {

      log.warn?.('[supervisor] illegal transition', { from: state, event, error: res.error })
      return false
    }
    const from = state
    state = res.target
    ctx.since = nowMs
    if (reason) ctx.lastCrashReason = event === 'CRASH' || event === 'HEALTH_DEGRADED' ? reason : ctx.lastCrashReason
    log.info?.('[supervisor] transition', { from, event, to: state, reason: reason || undefined })
    pushStateToWorker()

    if (AUDITED_EVENTS.has(event)) onRuntimeEvent(event, reason, nowMs)
    onTransition({ from, event, to: state, reason, ctx: snapshot() })
    return true
  }

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
