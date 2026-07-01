// llm.js  --  resolve casey's callLLM backend.
//
// casey's callLLM contract is freddie's: ({messages, tools}) => {content, tool_calls}.
// freddie already ships the acptoapi bridge (src/agent/acptoapi-bridge.js) that
// speaks exactly that contract over the local multi-provider bridge on :4800.
// Before this module casey only ever ran on the deterministic stub or null, so
// the real brain was never connected. resolveCallLLM picks the backend by an
// explicit, honest precedence and never claims a capability it can't deliver:
//
//   1. CASEY_STUB_LLM set: deterministic stub (offline, cheap, tests/sim)
//   2. acptoapi reachable: real model via the freddie bridge
//   3. neither: null  (gateway falls back to canned replies)
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

// A long-lived gateway must not latch "AI helper offline" for its whole life just
// because the provider was down at boot. resolveCallLLM probes ONCE; the handler
// then closes over a static callLLM, so a provider that recovers minutes later is
// never picked up without a restart -- contacts keep getting the holding message
// forever. makeResilientCallLLM wraps resolveCallLLM in a self-healing backend:
//
//   - status() always reflects the CURRENT resolution, so the dashboard health row
//     shows recovery live (no separate re-probe to drift from the real backend).
//   - the returned callLLM is ALWAYS a function. While no real backend is resolved,
//     each call triggers a debounced re-resolve (single in-flight probe, at most one
//     attempt per intervalMs) and, if still unreachable, THROWS -- the case handler
//     already catches a failing callLLM and sends its safe fallback, so a contact
//     still gets a reply and the next inbound re-probes. Once resolved, calls delegate
//     to the real backend with no probe overhead.
//
// This keeps the never-dead-end guarantee (holding message on every miss) AND adds
// the missing never-stay-degraded half (auto-resume when the provider returns).
export function makeResilientCallLLM({ probe = true, model = DEFAULT_MODEL, intervalMs = 30000, resolve = resolveCallLLM, now = null, slowMs = 20000, slowWindow = 5, onRecover = null } = {}) {
  let backend = null                 // resolved real callLLM, or null while degraded
  let last = { source: 'none', model: null, url: null }
  let inflight = null                // shared promise so concurrent inbounds probe once
  let lastAttempt = -Infinity        // monotonic ms of the last resolve attempt (debounce)

  // Completion-path health: a provider can resolve (source acptoapi, /v1/models
  // answers) yet have every real turn hang for tens of seconds while it walks a
  // failing provider chain. Reachability alone is then a false green -- the pill
  // says "online" while contacts wait minutes. So we time the REAL turns the
  // gateway already makes (no synthetic probe burning provider quota) and keep a
  // small rolling window of {ms, ok}. The health row reads `degraded` from it, so
  // a slow/erroring brain shows degraded instead of online. `slowMs` is the
  // per-turn ceiling; `slowWindow` is how many recent turns we keep.
  const recent = []                  // newest-last: { ms, ok }
  const recordTurn = (ms, ok) => { recent.push({ ms, ok }); if (recent.length > slowWindow) recent.shift() }
  // Degraded when the recent window has any turns and ALL of them were slow or
  // failed -- one fast turn (a recovered provider) clears it. Conservative: a
  // mixed window (some fast) is still online, so a single slow turn never flips
  // the pill, but a sustained slow/failing brain does.
  const completionHealth = () => {
    if (!recent.length) return { degraded: false, lastMs: null, recentSlow: 0 }
    const slow = recent.filter(r => !r.ok || r.ms >= slowMs)
    return { degraded: slow.length === recent.length, lastMs: recent[recent.length - 1].ms, recentSlow: slow.length }
  }

  // `resolve` and `now` are injectable so the single real-services test can drive the
  // recovery transition and the debounce clock deterministically (a real resolver
  // function and a real clock, not a mock framework); both default to production.
  const clock = now || (() => Date.now())

  async function resolveOnce() {
    const wasDown = !backend
    const r = await resolve({ probe, model }).catch(() => ({ callLLM: null, source: 'none' }))
    backend = r.callLLM || null
    last = { source: r.source || (backend ? 'acptoapi' : 'none'), model: r.model || null, url: r.url || null }
    // Rising edge null -> backend: the provider just came back. Fire onRecover once so
    // the host can drain any messages queued during the outage. Never awaited or
    // allowed to throw into the resolve path.
    if (wasDown && backend && typeof onRecover === 'function') {
      try { Promise.resolve(onRecover()).catch(() => {}) } catch { /* never break resolve */ }
    }
    return backend
  }

  // Debounced lazy re-resolve: returns the live backend (possibly still null). A
  // probe already in flight is shared; an attempt within intervalMs of the last is
  // skipped so a down provider never adds a round-trip to every inbound or stampedes.
  async function ensure() {
    if (backend) return backend
    if (inflight) return inflight
    if (clock() - lastAttempt < intervalMs) return backend
    lastAttempt = clock()
    inflight = resolveOnce().finally(() => { inflight = null })
    return inflight
  }

  const callLLM = async ({ messages, tools }) => {
    const b = await ensure()
    if (!b) throw new Error('AI helper offline (provider unreachable); using holding reply')
    // Time the real turn so the health row sees completion-path latency. A throw
    // (timeout/error) records an unhealthy turn too, so a hanging provider that
    // never returns ok still flips the window to degraded on the next read.
    const t0 = clock()
    try {
      const r = await b({ messages, tools })
      recordTurn(clock() - t0, true)
      return r
    } catch (e) {
      recordTurn(clock() - t0, false)
      throw e
    }
  }

  // status() forces an initial resolve so the first health read is accurate, then
  // returns the live snapshot. Subsequent reads are cheap (cached between probes).
  // It folds in completion-path health so a resolved-but-slow backend reads
  // degraded -- the operator can tell "online" from "online but answering nobody".
  const status = async () => {
    if (!backend && clock() - lastAttempt >= intervalMs) await ensure()
    return { ...last, ...completionHealth() }
  }

  return { callLLM, status, _ensure: ensure }
}
