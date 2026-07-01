// conversation-state.js -- casey's durable, agent-driven conversation state.
//
// Wraps dstate/adaptogen as a per-case SOFT conversation FSM (CONVERSATION_SPEC).
// The AGENT declares its phase (the case_stage tool); casey applies the transition
// here and persists the exported bundle on the case row (conv_state field). Each
// turn, orient() reads the current phase + legal next phases back for the system
// prompt, so the model knows where it is in the report arc -- never re-asking,
// always advancing.
//
// Pattern B persistence (no separate file per case): the dstate bundle is
// export()'d to a JSON blob stored on the thatcher case row (conv_state), and
// importState(':memory:', blob) rehydrates it. This keeps the durable boundary the
// same as the rest of casey (thatcher), needs no filesystem, and is crash-safe.
//
// DEGRADE-SAFE: adaptogen is an optional import. When it is absent (a bare clone),
// or the bundle is torn/old, or a store write throws (an unpublished conv_state
// column), every function degrades to null / a fresh greeting machine -- the report-
// derived next-fact block in the prompt still drives the conversation, exactly as
// before this wiring. dstate MUST NEVER break a live turn.
import { CONVERSATION_SPEC } from './conversation-spec.js'

// Module-level cached optional import. A bare clone (no ../dstate) resolves to null
// once and every call becomes a no-op.
let _adaptogen
async function loadAdaptogen() {
  if (_adaptogen !== undefined) return _adaptogen
  try {
    const m = await import('adaptogen')
    _adaptogen = { Adaptogen: m.Adaptogen || m.DState, importState: m.importState }
    if (!_adaptogen.Adaptogen || !_adaptogen.importState) _adaptogen = null
  } catch { _adaptogen = null }
  return _adaptogen
}

// Build (or rehydrate) an in-memory DState for a case. Returns the DState or null
// when degraded. A stored blob is imported; otherwise a fresh machine is planned
// from CONVERSATION_SPEC (cursor starts at greeting).
async function machine(blob) {
  const a = await loadAdaptogen()
  if (!a) return null
  try {
    if (blob) {
      const bundle = typeof blob === 'string' ? JSON.parse(blob) : blob
      const ds = a.importState(':memory:', bundle, { lock: false })
      // A rehydrated machine already carries the spec (nodes/edges are events in the
      // bundle); no re-plan. If the import produced an empty machine, fall through.
      if (ds && typeof ds.orient === 'function') return ds
    }
  } catch { /* torn/old blob -> fresh machine below */ }
  try {
    const ds = a.Adaptogen.open(':memory:', { seed: false, lock: false })
    const r = ds.plan(CONVERSATION_SPEC)
    if (r && r.ok === false) return null
    return ds
  } catch { return null }
}

// Read the current conversation phase + legal next phases for the prompt. Returns
// null when degraded (no adaptogen / any error) so the caller shows the report-
// derived block alone. `vars` feeds transition guards (e.g. report_complete).
export async function orientCase(caseRow, vars = {}) {
  try {
    const ds = await machine(caseRow?.conv_state)
    if (!ds) return null
    const o = ds.orient(vars)   // PURE object: { cursor, legalMoves, done, ... }
    if (!o) return null
    const state = (Array.isArray(o.cursor) && o.cursor[0]) || 'greeting'
    const legalMoves = Array.isArray(o.legalMoves) ? o.legalMoves.map(m => m.to).filter(Boolean) : []
    return { state, legalMoves, done: !!o.done }
  } catch { return null }
}

// Apply an agent-declared phase move and persist the new bundle on the case row.
// Only persists when the transition ACTUALLY applied (an enforcement:off handoff/
// closed edge returns applied:false -- it is allowed but does not move the cursor,
// so nothing to persist). Degrades to a no-op when adaptogen is absent or any step
// throws (setConvState is itself try/catch-guarded in the store). Returns
// { applied, softWarned, from, to } or null when degraded.
export async function advanceCase(store, caseRow, to, vars = {}) {
  try {
    const ds = await machine(caseRow?.conv_state)
    if (!ds) return null
    const r = ds.transition(to, vars)   // Result: { ok, value:{ applied, soft_warned, from, to } }
    if (!r || r.ok === false || !r.value) return null
    const v = r.value
    if (v.applied) {
      try {
        if (store?.setConvState) await store.setConvState(caseRow.id, JSON.stringify(ds.export()))
      } catch { /* unpublished column / write race -> fresh machine next turn, never break the turn */ }
    }
    return { applied: !!v.applied, softWarned: v.soft_warned === true, from: v.from, to: v.to }
  } catch { return null }
}
