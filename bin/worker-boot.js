import { createCasey } from '../src/casey.js'

export async function bootServingCasey(channels) {
  const { makeResilientCallLLM } = await import('../src/llm.js')
  let caseyRef = null
  const brain = makeResilientCallLLM({
    probe: true,
    onRecover: () => caseyRef?.drainQueuedTurns?.().catch(e => caseyRef?.log?.warn?.('[casey] recovery drain failed', { error: e.message })),
  })
  const casey = await createCasey({
    channels,
    callLLM: brain.callLLM,
    llmStatus: brain.status,
    drainPollIntervalMs: process.env.CASEY_DRAIN_POLL_INTERVAL_MS != null ? Number(process.env.CASEY_DRAIN_POLL_INTERVAL_MS) : undefined,
  })
  caseyRef = casey
  casey.resilientStatus = brain.status
  casey.resilientCallLLM = brain.callLLM
  try { await brain.status() } catch (e) { console.error('[worker] boot-time readiness warm-up failed (continuing, self-heals on first real turn):', e.message) }
  await casey.start()
  return casey
}
