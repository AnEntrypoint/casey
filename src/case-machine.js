// case-machine.js  --  the case lifecycle as a real xstate machine.
//
// casey used to hand-walk a {forward,backward} graph to decide whether a stage
// change was legal. That logic now lives in a published, battle-tested state
// machine (xstate v5), so an illegal transition is rejected by the machine's own
// resolution rather than by bespoke array checks we have to keep correct.
//
// IMPORTANT ownership boundary (P10): thatcher remains the single owner of a
// case's persisted `status`. This machine is the TRANSITION-VALIDATION AUTHORITY
// only -- it answers "is from->to legal for this role?" and "what can I reach
// from here?". It holds no per-case state and runs no actor; it is a pure
// decision surface built once from the same workflow graph thatcher uses. There
// is therefore no second source of truth to drift.

import { createMachine } from 'xstate'

// Build an xstate machine from the parsed workflow graph
//   { <stage>: { forward:[...], backward:[...], requires_role:[...] }, ... }
// Each stage becomes a state; each legal target becomes an event named GO_<TARGET>
// whose destination is that target. requires_role is carried on the state's meta
// so the role gate stays declarative and lives with the machine, not beside it.
export function buildCaseMachine(wfGraph) {
  const stages = Object.keys(wfGraph || {})
  if (!stages.length) throw new Error('buildCaseMachine: empty workflow graph')
  const states = {}
  for (const name of stages) {
    const g = wfGraph[name] || {}
    const targets = [...new Set([...(g.forward || []), ...(g.backward || [])])]
    const on = {}
    for (const t of targets) on[ev(t)] = { target: t }
    states[name] = { on, meta: { requires_role: g.requires_role || [] } }
  }
  return createMachine({ id: 'case', initial: stages[0], states })
}

// Event name for "move to <stage>". Uppercased so it reads as an xstate event.
function ev(stage) { return 'GO_' + String(stage).toUpperCase() }

// Is `from -> to` a legal transition for `role`? Pure: derived from the machine
// definition, never from a live actor. Mirrors the old _validateTransition truth
// table exactly (graph reachability AND the target's role gate), so swapping the
// bespoke walk for the machine changes nothing an existing caller can observe.
export function canTransition(machine, from, to, role) {
  const node = machine.config.states?.[from]
  if (!node) return { ok: false, error: `invalid current stage "${from}"` }
  const toNode = machine.config.states?.[to]
  if (!toNode) return { ok: false, error: `invalid target stage "${to}"` }
  const reachable = node.on && Object.prototype.hasOwnProperty.call(node.on, ev(to))
  if (!reachable) {
    const allowed = node.on ? Object.values(node.on).map(d => d.target).join(', ') : ''
    return { ok: false, error: `cannot move ${from} -> ${to}; allowed: ${allowed || 'none'}` }
  }
  const rr = toNode.meta?.requires_role || []
  // A role-gated target must reject a MISSING role too, not just a wrong one --
  // otherwise an unauthenticated caller (role undefined) walks straight through
  // the gate it exists to enforce (P6/P8).
  if (rr.length && (!role || !rr.includes(role))) {
    return { ok: false, error: `role "${role || 'none'}" cannot enter "${to}" (requires ${rr.join('/')})` }
  }
  return { ok: true }
}

// The stages reachable from `from` that `role` is allowed to enter. Replaces the
// hand-rolled availableTransitions filter; same result set.
export function nextStates(machine, from, role) {
  const node = machine.config.states?.[from]
  if (!node || !node.on) return []
  return Object.values(node.on).map(d => d.target).filter(to => {
    const rr = machine.config.states?.[to]?.meta?.requires_role || []
    return !rr.length || (role && rr.includes(role))
  })
}
