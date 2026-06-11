// llm.js  --  resolve casey's callLLM backend.
//
// casey's callLLM contract is freddie's: ({messages, tools}) => {content, tool_calls}.
// freddie already ships the acptoapi bridge (src/agent/acptoapi-bridge.js) that
// speaks exactly that contract over the local multi-provider bridge on :4800.
// Before this module casey only ever ran on the deterministic stub or null, so
// the real brain was never connected. resolveCallLLM picks the backend by an
// explicit, honest precedence and never claims a capability it can't deliver:
//
//   1. CASEY_STUB_LLM set -> deterministic stub (offline, cheap, tests/sim)
//   2. acptoapi reachable -> real model via the freddie bridge
//   3. neither -> null  (gateway falls back to canned replies)
//
// The null fall-through is the worst-case path (P9/P10): if the bridge is down,
// casey does NOT pretend to have an AI - it returns null and the gateway answers
// with the deterministic "a person will help you" reply rather than dropping the
// contact or crashing the case.

const DEFAULT_MODEL = process.env.CASEY_LLM_MODEL || 'claude/haiku'

// Bind freddie's bridge callLLM to a fixed model so every casey turn requests the
// same brain. The bridge reads FREDDIE_LLM_URL / FREDDIE_LLM_MODEL itself, but we
// pass model explicitly so CASEY_LLM_MODEL is the single casey-facing knob.
function bridgeBackend(bridge, model) {
  return ({ messages, tools }) => bridge.callLLM({ messages, tools, model })
}

// Resolve the backend. `probe` (default true) decides whether an unset stub flag
// triggers a live reachability check; tests pass probe:false to stay offline.
// Returns { callLLM, source } so callers can report which brain is active in
// plain words (the dashboard health row, the CLI banner).
export async function resolveCallLLM({ probe = true, model = DEFAULT_MODEL } = {}) {
  if (process.env.CASEY_STUB_LLM) {
    const { stubLLM } = await import('./sim/stub-llm.js')
    return { callLLM: stubLLM(), source: 'stub' }
  }
  if (!probe) return { callLLM: null, source: 'none' }
  let freddie
  try {
    freddie = await import('freddie')
  } catch {
    return { callLLM: null, source: 'none' }
  }
  // freddie publicly re-exports the acptoapi bridge as acptoapi*; older builds
  // without the re-export degrade honestly to canned replies.
  if (typeof freddie.acptoapiReachable !== 'function' || typeof freddie.acptoapiCallLLM !== 'function') {
    return { callLLM: null, source: 'none' }
  }
  const reachable = await freddie.acptoapiReachable().catch(() => false)
  if (!reachable) return { callLLM: null, source: 'none' }
  const bridge = { callLLM: freddie.acptoapiCallLLM, getAcptoapiUrl: freddie.getAcptoapiUrl }
  return { callLLM: bridgeBackend(bridge, model), source: 'acptoapi', model, url: bridge.getAcptoapiUrl() }
}
