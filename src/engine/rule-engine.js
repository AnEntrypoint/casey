// engine/rule-engine.js -- the bounded rule EVALUATOR (as opposed to
// pack-schema.js's rule VALIDATOR). Consumes a pack's declarative rules
// (condition/severity/route/SLA, comparisons/sets/counts/thresholds only)
// against a real Observation's findings and returns which rules fire.
//
// This is the engine-layer half of escalation-routing-to-responders: given
// a fired rule's `route`, the CALLER (casey's existing gateway-hooks.js/
// case-tools.js, untouched by this module) decides how that route maps to
// an actual case_handoff/needs-human action -- this module only answers
// "did this observation trip a pack-declared rule, and with what
// severity/route", never sends anything itself.

function readField(findings, fieldKey) {
  const v = findings?.[fieldKey]
  if (!v) return undefined
  if (v.provenance === 'unknown') return undefined   // an unknown value can never satisfy a threshold comparison
  return v.value
}

function evalCondition(cond, findings) {
  switch (cond.op) {
    case 'and': return cond.clauses.every(c => evalCondition(c, findings))
    case 'or': return cond.clauses.some(c => evalCondition(c, findings))
    case 'eq': return readField(findings, cond.field) === cond.value
    case 'neq': return readField(findings, cond.field) !== cond.value
    case 'gt': { const v = readField(findings, cond.field); return typeof v === 'number' && v > cond.value }
    case 'gte': { const v = readField(findings, cond.field); return typeof v === 'number' && v >= cond.value }
    case 'lt': { const v = readField(findings, cond.field); return typeof v === 'number' && v < cond.value }
    case 'lte': { const v = readField(findings, cond.field); return typeof v === 'number' && v <= cond.value }
    case 'in': { const v = readField(findings, cond.field); return Array.isArray(cond.value) && cond.value.includes(v) }
    case 'notIn': { const v = readField(findings, cond.field); return Array.isArray(cond.value) && !cond.value.includes(v) }
    default: throw new Error(`rule-engine: unrecognised op "${cond.op}" -- pack should have failed validatePack() before reaching here`)
  }
}

// Returns every rule from pack.rules that fires against this observation's
// findings, each annotated with its own severity/route -- an observation
// can trip more than one rule (e.g. both mass-mortality and a notifiable
// disease); the caller decides how to reconcile multiple fired rules
// (typically: escalate at the highest severity, route to every distinct
// responder named).
export function evaluateRules(pack, observation) {
  const rules = pack.rules || []
  const fired = []
  for (const rule of rules) {
    let matches
    try { matches = evalCondition(rule.condition, observation.findings) }
    catch (e) { throw new Error(`rule-engine: rule "${rule.id}" failed to evaluate: ${e.message}`) }
    if (matches) fired.push({ ruleId: rule.id, severity: rule.severity, route: rule.route })
  }
  return fired
}

// Highest-severity-wins reconciliation across every fired rule, with an
// explicit tie-break: multiple distinct routes at the SAME top severity are
// all returned (never silently drop one responder because another was
// named first) -- true routing fan-out is the caller's call, not this
// function's to collapse.
const SEVERITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 }

export function topEscalation(firedRules) {
  if (!firedRules.length) return null
  const maxRank = Math.max(...firedRules.map(r => SEVERITY_RANK[r.severity] ?? 0))
  const top = firedRules.filter(r => (SEVERITY_RANK[r.severity] ?? 0) === maxRank)
  return { severity: top[0].severity, routes: [...new Set(top.map(r => r.route))], firedRuleIds: top.map(r => r.ruleId) }
}
