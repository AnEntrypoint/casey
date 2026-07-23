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
//
// Distinct from conversation-state.js/conversation-spec.js: those track the
// AGENT-DECLARED conversation PHASE (greeting/gathering/enquiring/.../closed,
// via case_stage), a soft dstate FSM entirely separate from this file's
// workflow STATUS (new/triaging/in_progress/...). Both are load-bearing and
// intentionally independent -- a case's conv_state and its status can (and
// routinely do) sit at different points in their respective graphs.

import { createMachine } from 'xstate'

// Build an xstate machine from the parsed workflow graph
//   { <stage>: { forward:[...], backward:[...], requires_role:[...] }, ... }
// Each stage becomes a state; each legal target becomes an event named GO_<TARGET>
// whose destination is that target. requires_role is carried on the state's meta
// so the role gate stays declarative and lives with the machine, not beside it.
// Each edge also carries `meta.viaBackward` -- whether THIS specific from->to
// move is a `backward` (reopen/revert) edge -- so canTransition can gate a
// backward move on the FROM state's own requires_role (see canTransition's own
// comment for why: a role-gated state like `closed` names who may LEAVE it via
// its `backward` edges, e.g. reopening, not who may ENTER it).
export function buildCaseMachine(wfGraph) {
  const stages = Object.keys(wfGraph || {})
  if (!stages.length) throw new Error('buildCaseMachine: empty workflow graph')
  const states = {}
  for (const name of stages) {
    const g = wfGraph[name] || {}
    const backwardSet = new Set(g.backward || [])
    const targets = [...new Set([...(g.forward || []), ...(g.backward || [])])]
    const on = {}
    for (const t of targets) on[ev(t)] = { target: t, meta: { viaBackward: backwardSet.has(t) } }
    states[name] = { on, meta: { requires_role: g.requires_role || [] } }
  }
  return createMachine({ id: 'case', initial: stages[0], states })
}

// Event name for "move to <stage>". Uppercased so it reads as an xstate event.
function ev(stage) { return 'GO_' + String(stage).toUpperCase() }

// Is `from -> to` a legal transition for `role`? Pure: derived from the machine
// definition, never from a live actor.
//
// Role gate direction: a state's requires_role names who may LEAVE it via a
// `backward` edge (reopen/revert), never who may ENTER it via a forward move.
// thatcher.config.yml's `closed: { requires_role: [operator, admin], backward:
// [resolved] }` reads (per its own comment) as "reopening a closed case
// (closed -> resolved) is operator/admin only" -- closing a case (the FORWARD
// move resolved -> closed) is NOT meant to be restricted at all. The old
// behavior (mirroring the pre-xstate _validateTransition truth table exactly)
// gated on the TARGET's requires_role regardless of direction -- since
// `closed` is both the forward target of `resolved` and the backward source
// of its own edge back to `resolved`, that single field was being read as
// "gate on entry" for the forward move and, by the same TARGET-role logic,
// was NEVER actually checked on the backward move's own source (closed) at
// all except by coincidence of them being the same call. Net effect before
// this fix: closing required operator/admin, reopening required nothing --
// exactly backwards from the documented intent. Fixed: a `backward` edge
// (viaBackward, stamped by buildCaseMachine) checks the FROM node's
// requires_role; a `forward` edge is NEVER role-gated by this mechanism (a
// forward move's own target can still declare requires_role for OTHER
// reasons if a future config needs entry-gating, but none currently does).
export function canTransition(machine, from, to, role) {
  const node = machine.config.states?.[from]
  if (!node) return { ok: false, error: `invalid current stage "${from}"` }
  const toNode = machine.config.states?.[to]
  if (!toNode) return { ok: false, error: `invalid target stage "${to}"` }
  const edge = node.on?.[ev(to)]
  if (!edge) {
    const allowed = node.on ? Object.values(node.on).map(d => d.target).join(', ') : ''
    return { ok: false, error: `cannot move ${from} -> ${to}; allowed: ${allowed || 'none'}` }
  }
  if (!edge.meta?.viaBackward) return { ok: true }
  const rr = node.meta?.requires_role || []
  // A role-gated target must reject a MISSING role too, not just a wrong one --
  // otherwise an unauthenticated caller (role undefined) walks straight through
  // the gate it exists to enforce (P6/P8).
  if (rr.length && (!role || !rr.includes(role))) {
    return { ok: false, error: `role "${role || 'none'}" cannot leave "${from}" (requires ${rr.join('/')})` }
  }
  return { ok: true }
}

// The stages reachable from `from` that `role` is allowed to enter. Replaces the
// hand-rolled availableTransitions filter; same result set. Same role-gate
// direction as canTransition above -- only a backward edge (e.g. reopening)
// is gated, on the FROM node's requires_role; a forward edge is never gated
// by this mechanism, so this list matches exactly what canTransition allows.
export function nextStates(machine, from, role) {
  const node = machine.config.states?.[from]
  if (!node || !node.on) return []
  return Object.entries(node.on).filter(([, d]) => {
    if (!d.meta?.viaBackward) return true
    const rr = node.meta?.requires_role || []
    return !rr.length || (role && rr.includes(role))
  }).map(([, d]) => d.target)
}
