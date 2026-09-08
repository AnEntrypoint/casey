// llm.js  --  resolve casey's callLLM backend.
//
// casey's callLLM contract is freddie's: ({messages, tools}) => {content, tool_calls}.
// freddie's acptoapi bridge (src/agent/acptoapi-bridge.js) calls the acptoapi
// library IN-PROCESS -- no HTTP hop, no separate listening port. Do not
// reintroduce an out-of-process daemon: an uncaught ACP-timeout exception in one
// takes the whole LLM path down until it is manually restarted.
// resolveCallLLM returns the real model via the freddie bridge when a live
// in-process probe call succeeds, and null otherwise. There is deliberately no
// third, degraded backend.
//
// USER DIRECTIVE: no mocks/fallbacks/stubs, only singular working mechanisms and
// loud errors. The null fall-through is not a canned-reply path: the gateway
// logs loud and sends nothing on a genuinely unreachable backend. The LLM should
// always work rather than fall back to a scripted apology.

// Sonnet by default: casey's turn is a multi-step extraction + tool-orchestration
// + tone-sensitive task (never alarm, mirror the contact's language, never repeat
// a question, decide when to call case_split/case_report). Cheaper models drop
// tool calls, repeat questions, and fabricate context on empty turns, so this is
// the floor for a live turn. CASEY_LLM_MODEL overrides it in either direction,
// including back down to a cheaper tier for cost-sensitive deployments.
const DEFAULT_MODEL = process.env.CASEY_LLM_MODEL || 'claude/sonnet'

// Bind freddie's bridge callLLM to a default model so every casey turn requests
// the same brain by default. The bridge reads FREDDIE_LLM_URL/FREDDIE_LLM_MODEL
// itself; casey passes model explicitly so CASEY_LLM_MODEL is the single
// casey-facing knob.
//
// Per-call override: req.model, when present, wins over the bound default. No
// casey call site uses it today -- freddie's runTurn is one undifferentiated
// tool loop where the agent itself decides mid-turn whether to
// classify/extract/route/answer, so casey has no ahead-of-time "cheap
// classification vs. expensive extraction" signal to route on; adding one means
// redesigning the turn shape, not this file. The override exists so a caller
// with a genuine per-call reason (a background/batch summarization pass outside
// the live conversational turn) needs no second bound backend.
function bridgeBackend(bridge, model) {
  // Pass the WHOLE req through (tool_choice, future params). Destructuring only
  // {messages, tools} silently strips tool_choice, severing the forced-first-call
  // nudge the whole way down.
  return (req) => bridge.callLLM({ ...req, model: req.model || model })
}

// Resolve the backend. `probe` (default true) decides whether a live reachability
// check is performed; callers pass probe:false to stay offline. Returns
// { callLLM, source } so callers can report which brain is active in plain
// words (the dashboard health row, the CLI banner).
export async function resolveCallLLM({ probe = true, model = DEFAULT_MODEL } = {}) {
  if (!probe) return { callLLM: null, source: 'none' }
  let bridge
  try {
    bridge = await import('./agent/acptoapi-bridge.js')
  } catch {
    return { callLLM: null, source: 'none' }
  }
  // isReachable() probes only the auto-chain's top-3 ranked links
  // (REACHABILITY_PROBE_CHAIN_LINK_CAP), which for an 'auto' model resolve to
  // whichever provider currently ranks highest by static SWE-bench score. When
  // that one top-ranked provider is rate-limited by concurrent boot-time traffic
  // (the resume sweep and readiness prober firing their own probes in the same
  // window), the narrow 3-link sample reports the WHOLE ecosystem unreachable
  // even though healthy providers sit immediately behind it in the SAME chain --
  // resolveCallLLM then returns source:none and every real turn queues silently
  // with no reply sent. A genuine chat call through the bridge walks the FULL
  // chain (every configured/keyed provider, not just the top 3), so it is a
  // strictly wider and more accurate liveness signal. Fall through to it only on
  // the narrow probe's negative, so the common case (top-ranked provider
  // healthy) still pays just the cheap probe.
  let reachable = await bridge.isReachable(undefined, model).catch(() => false)
  if (!reachable) {
    // callLLM's own bound is ACPTOAPI_TIMEOUT_MS (default 240000ms) -- far too
    // wide for a liveness probe. Without an explicit race, this
    // narrow-probe-negative path (the uncommon, unhealthy case the fallback
    // exists for) can hang a live inbound turn up to 4 minutes instead of
    // failing fast to source:'none'.
    const FALLBACK_PROBE_TIMEOUT_MS = Number(process.env.CASEY_LLM_FALLBACK_PROBE_TIMEOUT_MS) || 45000
    try {
      const r = await Promise.race([
        bridge.callLLM({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('fallback probe timeout')), FALLBACK_PROBE_TIMEOUT_MS))
      ])
      reachable = !!(r && (r.content != null || r.tool_calls))
    } catch { reachable = false }
  }
  if (!reachable) return { callLLM: null, source: 'none' }
  return { callLLM: bridgeBackend(bridge, model), source: 'acptoapi', model, url: bridge.getAcptoapiUrl() }
}

// A long-lived gateway must not latch "AI helper offline" for its whole life
// because the provider was down at boot. resolveCallLLM probes ONCE and the
// handler closes over a static callLLM, so a provider that recovers minutes
// later is never picked up without a restart -- contacts get nothing sent (per
// the no-fallback directive) turn after turn. makeResilientCallLLM wraps
// resolveCallLLM in a self-healing backend:
//
//   - status() always reflects the CURRENT resolution, so the dashboard health
//     row shows recovery live with no separate re-probe to drift from it.
//   - the returned callLLM is ALWAYS a function. While no real backend is
//     resolved it debounces a re-resolve (one in-flight probe) and, if still
//     unreachable, THROWS -- the case handler catches that, logs loud and sends
//     nothing (no fallback text), and the next inbound re-probes.
export function makeResilientCallLLM({ probe = true, model = DEFAULT_MODEL, intervalMs = 30000, resolveDebounceMs = null, resolve = resolveCallLLM, now = null, slowMs = 20000, slowWindow = 5, onRecover = null } = {}) {
  let backend = null                 // resolved real callLLM, or null while degraded
  let last = { source: 'none', model: null, url: null }
  let inflight = null                // shared promise so concurrent inbounds probe once
  let lastAttempt = -Infinity        // monotonic ms of the last resolve attempt (debounce)

  // Completion-path health: a provider can resolve (source acptoapi, /v1/models
  // answers) yet have every real turn hang for tens of seconds while it walks a
  // failing provider chain. Reachability alone is then a false green -- the pill
  // says "online" while contacts wait minutes. So time the REAL turns the gateway
  // already makes (no synthetic probe burning provider quota) and keep a small
  // rolling window of {ms, ok}. The health row reads `degraded` from it, so a
  // slow/erroring brain shows degraded instead of online. `slowMs` is the
  // per-turn ceiling; `slowWindow` is how many recent turns are kept.
  const recent = []                  // newest-last: { ms, ok, at }
  const recordTurn = (ms, ok) => { recent.push({ ms, ok, at: clock() }); if (recent.length > slowWindow) recent.shift() }
  // Degraded when the recent window has ENOUGH turns and ALL of them were slow
  // or failed -- one fast turn (a recovered provider) clears it. Conservative: a
  // mixed window (some fast) is still online, so a single slow turn never flips
  // the pill, but a sustained slow/failing brain does. MIN_SAMPLES_FOR_DEGRADED
  // must stay >= 2: right after a boot (or after the window was last cleared)
  // recent.length can be 1, and one unlucky sample (a single rate-limited
  // provider hop pushing a turn past its timeout) would otherwise satisfy "ALL
  // of them failed" and gate every new inbound into the LLM-down queue for a
  // full intervalMs even though the very next real call succeeds fine.
  const MIN_SAMPLES_FOR_DEGRADED = 2
  const completionHealth = () => {
    if (!recent.length) return { degraded: false, lastMs: null, recentSlow: 0, newestSampleAt: null }
    const slow = recent.filter(r => !r.ok || r.ms >= slowMs)
    const degraded = recent.length >= MIN_SAMPLES_FOR_DEGRADED && slow.length === recent.length
    return { degraded, lastMs: recent[recent.length - 1].ms, recentSlow: slow.length, newestSampleAt: recent[recent.length - 1].at }
  }

  // `resolve` and `now` are injection seams so the recovery transition and the
  // debounce clock can be driven deterministically against real code (a real
  // resolver function and a real clock, never a mock framework); both default to
  // production.
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
  // probe already in flight is shared; an attempt within RESOLVE_DEBOUNCE_MS of
  // the last is skipped so a down provider never adds a round-trip to every
  // inbound or stampedes.
  //
  // RESOLVE_DEBOUNCE_MS must stay INDEPENDENT of intervalMs: they are genuinely
  // different signals, intervalMs governing the SEPARATE completion-health
  // staleness decay below. Share them and a single FAILED reachability probe
  // (source:'none', backend still null) locks EVERY subsequent inbound into the
  // LLM-down queue gate (hooks/case-intake.js: "LLM backend down; queued inbound, no
  // reply sent") for a full 30 real seconds with zero further attempt made, even
  // when the underlying provider chain is fully reachable and only that ONE probe
  // attempt was unlucky. Retrying a failed reachability probe is cheap (worst
  // case, another quick failure), so the default is a much shorter window; a
  // caller that explicitly wants the shared-window behaviour passes
  // resolveDebounceMs.
  const RESOLVE_DEBOUNCE_MS = resolveDebounceMs != null ? resolveDebounceMs : Math.min(intervalMs, 3000)
  async function ensure() {
    if (backend) return backend
    if (inflight) return inflight
    if (clock() - lastAttempt < RESOLVE_DEBOUNCE_MS) return backend
    lastAttempt = clock()
    inflight = resolveOnce().finally(() => { inflight = null })
    return inflight
  }

  // recordHealth: true for a live inbound turn (the default -- these ARE the
  // completion-path health signal), false for a boot-time resume/redrive of a
  // case already known to have failed before. A resume re-drive is, by
  // definition, retrying past failures, and letting a burst of them (the
  // boot-time resumePendingTurns sweep re-attempting several already-degraded
  // cases in a row) dominate the small rolling window poisons the SAME gate that
  // decides whether a brand-new, unrelated contact's fresh message gets queued
  // instead of answered live. Resume turns still throw/succeed normally for their
  // OWN caller (resumePendingTurns still sees a real degraded result) -- only the
  // shared health window is exempted.
  const callLLM = async (req, { recordHealth = true } = {}) => {
    const b = await ensure()
    if (!b) throw new Error('AI helper offline (provider unreachable); no reply sent')
    // Time the real turn so the health row sees completion-path latency. A throw
    // (timeout/error) records an unhealthy turn too, so a hanging provider that
    // never returns ok still flips the window to degraded on the next read.
    // Full pass-through: tool_choice (and future params) must survive the wrapper.
    const t0 = clock()
    try {
      const r = await b(req)
      if (recordHealth) recordTurn(clock() - t0, true)
      return r
    } catch (e) {
      if (recordHealth) recordTurn(clock() - t0, false)
      throw e
    }
  }

  // status() forces an initial resolve so the first health read is accurate, then
  // returns the live snapshot. Subsequent reads are cheap (cached between probes).
  // It folds in completion-path health so a resolved-but-slow backend reads
  // degraded -- the operator can tell "online" from "online but answering nobody".
  const status = async () => {
    // Must use the SAME window ensure() itself checks (RESOLVE_DEBOUNCE_MS, not
    // intervalMs): this is a pre-check for whether ensure() is worth calling at
    // all, so a wider window here makes status() wait the longer intervalMs
    // before ever attempting the re-resolve ensure() provides.
    if (!backend && clock() - lastAttempt >= RESOLVE_DEBOUNCE_MS) await ensure()
    const health = completionHealth()
    // Do not reintroduce a branch here that nulls `backend` when degraded: it
    // races the decay-clear below (both gate on the same `intervalMs`), the clear
    // runs first, and the decay -- which requires `backend` truthy -- then never
    // fires, so the degraded flag persists until some later `ensure()` happens to
    // re-resolve, which can take arbitrarily long. The decay must fire
    // unconditionally; if the backend is truly down, the next real callLLM call
    // fails and immediately re-poisons the window.
    if (backend && health.degraded && health.newestSampleAt != null && clock() - health.newestSampleAt >= intervalMs) {
      return { ...last, degraded: false, lastMs: health.lastMs, recentSlow: health.recentSlow, ok: true }
    }
    return { ...last, ...health, ok: !!backend && health.degraded !== true }
  }

  return { callLLM, status, _ensure: ensure }
}
