

import { createMachine } from 'xstate'

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

export function crashBudgetExceeded(times, now, { windowMs = 60_000, limit = 5 } = {}) {

  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 5
  if (!Array.isArray(times) || times.length < safeLimit) return false
  const recent = times.filter(t => Number.isFinite(t) && now - t <= windowMs)
  return recent.length >= safeLimit
}

export function isTerminal(machine, state) {
  return machine.config.states?.[state]?.type === 'final'
}
