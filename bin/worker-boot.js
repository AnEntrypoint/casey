// worker-boot.js  --  bringing the serving casey instance up: the self-healing
// LLM backend, the casey assembly around it, and the boot-time readiness warm-up
// that has to finish before the gateway can accept real traffic.
//
// Split out of bin/worker.js verbatim. The ordering here is load-bearing (see
// the cold-start note below); it is a sequence, not a set.

import { createCasey } from '../src/casey.js'

export async function bootServingCasey(channels) {
  // Self-healing LLM backend: a provider that is down at boot must not latch casey
  // into holding-message-only mode for the whole process life. makeResilientCallLLM
  // re-resolves lazily (debounced) so a recovered provider resumes real auto-replies
  // with no restart, and its status() is the single live source for the health row.
  const { makeResilientCallLLM } = await import('../src/llm.js')
  // onRecover fires on the provider's down->up edge to drain messages queued during
  // the outage. casey is created after brain, so route through a late-bound ref.
  let caseyRef = null
  const brain = makeResilientCallLLM({
    probe: true,
    onRecover: () => caseyRef?.drainQueuedTurns?.().catch(e => caseyRef?.log?.warn?.('[casey] recovery drain failed', { error: e.message })),
  })
  const casey = await createCasey({
    channels,
    callLLM: brain.callLLM,
    // Live backend health for the handler's LLM-down queue gate (drainQueuedTurns
    // drains on recovery).
    llmStatus: brain.status,
    // Periodic background poll driving drainQueuedTurns -- see casey.js
    // startDrainPoll's own comment for why this cannot rely solely on the
    // onRecover edge or a new inbound arriving. CASEY_DRAIN_POLL_INTERVAL_MS=0
    // disables it (falls back to the reactive-only paths).
    drainPollIntervalMs: process.env.CASEY_DRAIN_POLL_INTERVAL_MS != null ? Number(process.env.CASEY_DRAIN_POLL_INTERVAL_MS) : undefined,
  })
  caseyRef = casey
  // The queue-drain hard status-gate reads the SAME resilient backend the handler and
  // health row use, so a drain only fires when the provider is genuinely back. Health
  // reads it too, so the dashboard shows recovery the instant the provider comes back
  // -- no separate probe to drift from reality.
  casey.resilientStatus = brain.status
  // COLD-START RACE, fixed here: makeResilientCallLLM never eagerly resolves at
  // construction -- the backend only actually resolves (and, transitively, the
  // acptoapi readiness prober only actually STARTS, see llm.js resolveCallLLM ->
  // freddie.acptoapiReachable -> acptoapi.chatChain -> _ensureReadinessStarted)
  // on the FIRST real callLLM()/status() call. casey.start() below connects the
  // Discord gateway and begins accepting real inbound messages immediately --
  // so a message arriving within the first seconds of a restart used to race
  // the readiness system's own cold start, walking a chain with zero
  // real-request-verified availability data instead of one already warmed by
  // a boot-time probe. USER DIRECTIVE: the correct model must already be ready
  // when the call happens, not discovered live. Force one status() read here,
  // BEFORE gateway.start(), so the backend resolves and the readiness prober's
  // own immediate warm-up pass (readiness.js start()'s tick()) has already run
  // by the time real traffic can possibly arrive. Best-effort: a failure here
  // must never block boot -- the existing self-healing/queue-gate machinery
  // still covers a genuinely unreachable backend exactly as before.
  try { await brain.status() } catch (e) { console.error('[worker] boot-time readiness warm-up failed (continuing, self-heals on first real turn):', e.message) }
  await casey.start()
  return casey
}
