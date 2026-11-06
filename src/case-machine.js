

import { createMachine } from 'xstate'

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

function ev(stage) { return 'GO_' + String(stage).toUpperCase() }

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

  if (rr.length && (!role || !rr.includes(role))) {
    return { ok: false, error: `role "${role || 'none'}" cannot leave "${from}" (requires ${rr.join('/')})` }
  }
  return { ok: true }
}

export function nextStates(machine, from, role) {
  const node = machine.config.states?.[from]
  if (!node || !node.on) return []
  return Object.entries(node.on).filter(([, d]) => {
    if (!d.meta?.viaBackward) return true
    const rr = node.meta?.requires_role || []
    return !rr.length || (role && rr.includes(role))
  }).map(([, d]) => d.target)
}
