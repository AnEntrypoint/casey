// llm.js  --  resolve casey's callLLM backend.
//
// casey's callLLM contract is freddie's: ({messages, tools}) => {content, tool_calls}.
// freddie's acptoapi bridge (src/agent/acptoapi-bridge.js) calls the acptoapi
// library IN-PROCESS (no HTTP hop, no separate listening port) -- it used to
// fetch() a standalone acptoapi.js daemon on :4800, but that process crashed on
// an uncaught ACP-timeout exception (witnessed live, taking the whole LLM path
// down until manually restarted), so freddie now imports acptoapi directly.
// resolveCallLLM picks the backend by an explicit, honest precedence and never
// claims a capability it can't deliver:
//
//   1. acptoapi reachable (a real in-process probe call succeeds): real model
//      via the freddie bridge
//   2. otherwise: null
//
// USER DIRECTIVE: no mocks/fallbacks/stubs, only singular working mechanisms and
// loud errors. The null fall-through is NOT a "canned reply" path any more -- the
// gateway logs loud and sends nothing on a genuinely unreachable backend. The
// reliability fix is the in-process bridge itself: the LLM should always work,
// not fall back to a scripted apology when it doesn't.

// Sonnet by default: casey's turn is a multi-step extraction + tool-orchestration +
// tone-sensitive task (never alarm, mirror the contact's language, never repeat a
// question, decide when to call case_split/case_merge/case_stage) that a cheaper
// model has repeatedly been observed to get wrong (dropped tool calls, repeated
// questions, fabricated context on empty turns -- see AGENTS.md prompt-steering
// notes). CASEY_LLM_MODEL overrides this in either direction, including back down
// to a cheaper tier for cost-sensitive deployments.
const DEFAULT_MODEL = process.env.CASEY_LLM_MODEL || 'claude/sonnet'

// Bind freddie's bridge callLLM to a default model so every casey turn
// requests the same brain by default. The bridge reads FREDDIE_LLM_URL /
// FREDDIE_LLM_MODEL itself, but we pass model explicitly so CASEY_LLM_MODEL is
// the single casey-facing knob.
//
// Per-call override: req.model, when present, wins over the bound default.
// This is NOT currently exercised by casey's own case handler -- freddie's
// runTurn is a single undifferentiated tool loop where the agent itself
// decides mid-turn whether to classify/extract/route/answer (AGENTS.md), so
// casey has no ahead-of-time "this call is cheap classification vs. expensive
// extraction" signal to route on; splitting that would mean redesigning the
// turn shape, not this file. The override exists so a FUTURE caller with a
// genuine per-call reason (a background/batch task outside the live
// conversational turn, e.g. a lower-cost summarization pass) can request a
// different model without a second resolveCallLLM/makeResilientCallLLM
// instance -- one bridge, per-call choice, rather than a second bound backend.
function bridgeBackend(bridge, model) {
  // Pass EVERYTHING through (tool_choice, future params) -- destructuring only
  // {messages, tools} silently stripped tool_choice, severing the forced-first-call
  // nudge the whole way down.
  return (req) => bridge.callLLM({ ...req, model: req.model || model })
}

// Resolve the backend. `probe` (default true) decides whether a live reachability
// check is performed; callers pass probe:false to stay offline. Returns
// { callLLM, source } so callers can report which brain is active in plain
// words (the dashboard health row, the CLI banner).
export async function resolveCallLLM({ probe = true, model = DEFAULT_MODEL } = {}) {
  if (!probe) return { callLLM: null, source: 'none' }
  let freddie
  try {
    freddie = await import('freddie')
  } catch {
    return { callLLM: null, source: 'none' }
  }
  // freddie publicly re-exports the acptoapi bridge as acptoapi*; older builds
  // without the re-export honestly report no backend (source: 'none').
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
// never picked up without a restart -- contacts get nothing sent (per the
// no-fallback directive) turn after turn. makeResilientCallLLM wraps
// resolveCallLLM in a self-healing backend:
//
//   - status() always reflects the CURRENT resolution, so the dashboard health row
//     shows recovery live (no separate re-probe to drift from the real backend).
//   - the returned callLLM is ALWAYS a function. While no real backend is resolved,
//     each call triggers a debounced re-resolve (single in-flight probe, at most one
//     attempt per intervalMs) and, if still unreachable, THROWS -- the case handler
//     already catches a failing callLLM, logs loud, and sends nothing (no fallback
//     text); the next inbound re-probes. Once resolved, calls delegate to the real
//     backend with no probe overhead.
//
// This is the never-stay-degraded half (auto-resume when the provider returns) --
// the missing "never send anything but never stay silently broken either" half.
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
  const recent = []                  // newest-last: { ms, ok, at }
  const recordTurn = (ms, ok) => { recent.push({ ms, ok, at: clock() }); if (recent.length > slowWindow) recent.shift() }
  // Degraded when the recent window has ENOUGH turns and ALL of them were slow
  // or failed -- one fast turn (a recovered provider) clears it. Conservative: a
  // mixed window (some fast) is still online, so a single slow turn never flips
  // the pill, but a sustained slow/failing brain does. MIN_SAMPLES_FOR_DEGRADED
  // guards the early-window case the comment above claimed but the code did not
  // actually enforce: right after a boot (or after the window was last cleared),
  // recent.length can be 1 -- a single unlucky sample (e.g. one rate-limited
  // provider hop pushing a turn past its timeout) then trivially satisfies
  // "ALL of them failed" and gates every new inbound into the LLM-down queue for
  // a full intervalMs, even though the very next real call succeeds fine.
  // Witnessed live: a genuine chat ok right after a lone prior timeout still
  // read degraded and queued a plain "hi I'm in sheppie" report with no reply.
  // Requiring at least 2 samples before degraded can fire matches the
  // "sustained", not "one bad roll", intent the comment already promised.
  const MIN_SAMPLES_FOR_DEGRADED = 2
  const completionHealth = () => {
    if (!recent.length) return { degraded: false, lastMs: null, recentSlow: 0, newestSampleAt: null }
    const slow = recent.filter(r => !r.ok || r.ms >= slowMs)
    const degraded = recent.length >= MIN_SAMPLES_FOR_DEGRADED && slow.length === recent.length
    return { degraded, lastMs: recent[recent.length - 1].ms, recentSlow: slow.length, newestSampleAt: recent[recent.length - 1].at }
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

  // recordHealth: true for a live inbound turn (the default -- these ARE the
  // completion-path health signal), false for a boot-time resume/redrive of a
  // case already known to have failed before. A resume re-drive is, by
  // definition, retrying past failures -- letting a burst of them (e.g. the
  // boot-time resumePendingTurns sweep re-attempting several already-degraded
  // cases in a row) dominate the small rolling window would poison the SAME
  // gate that decides whether a brand-new, unrelated contact's fresh message
  // gets queued instead of answered live. Witnessed live: two ancient stuck
  // cases timing out during the boot resume sweep flipped completionHealth()
  // to degraded just as a genuinely new "hi there" arrived seconds later, and
  // it was queued even though the very next real turn succeeded in under a
  // second. Resume turns still throw/succeed normally for their OWN caller
  // (resumePendingTurns still sees a real degraded result) -- only the shared
  // health window is exempted.
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
    if (!backend && clock() - lastAttempt >= intervalMs) await ensure()
    const health = completionHealth()
    // A resolved backend that has gone consistently degraded (every recent real
    // turn failed/slow) never re-resolves on its own: `ensure()` only probes
    // when `backend` is null, so a stale/broken client object sits forever
    // reporting ok:false with no self-heal path. Drop it so the NEXT status()/
    // callLLM naturally re-resolves via the existing debounced ensure() path --
    // this does not force a probe here (keeps status() cheap), it just clears
    // the block that was preventing one.
    if (backend && health.degraded && clock() - lastAttempt >= intervalMs) {
      backend = null
    }
    // SELF-SUSTAINING-TRAP fix: the LLM-down queue gate (hooks/handler.js) reads
    // ok:false and queues the inbound WITHOUT ever calling callLLM -- so a
    // degraded window can never collect a fresh sample to clear itself once
    // every inbound is being queued instead of attempted. Live-witnessed: a
    // heavy multi-hour testing burst (many real rate-limited/timed-out turns
    // against shared provider capacity) poisoned the 5-sample window into
    // permanently reading degraded; a real, unrelated, freshly-sent "hi" then
    // got queued with zero attempt even though a direct resolveCallLLM+chat
    // call succeeded in under a second moments later -- the backend was NEVER
    // actually down, only the window's memory of it was stale. Time-decay the
    // degraded verdict by the age of its NEWEST sample (not merely how many
    // status() polls have observed it, which fires on every inbound and would
    // race with the actual staleness): once the most recent recorded turn is
    // itself older than intervalMs (the same debounce window already
    // governing re-resolve), treat the verdict as stale-not-current and
    // report healthy so the NEXT real inbound is actually attempted live --
    // which, if the backend truly is still down, immediately re-poisons the
    // window with a fresh failed sample (a real down backend still reads
    // down; only a STALE verdict about a backend that recovered or was never
    // really down gets cleared).
    if (health.degraded && health.newestSampleAt != null && clock() - health.newestSampleAt >= intervalMs) {
      return { ...last, degraded: false, lastMs: health.lastMs, recentSlow: health.recentSlow, ok: !!backend }
    }
    return { ...last, ...health, ok: !!backend && health.degraded !== true }
  }

  return { callLLM, status, _ensure: ensure }
}
