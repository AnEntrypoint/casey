import { createCaseyStore } from '../src/casey.js'

export async function openServingCasey(channels) {
  const { makeResilientCallLLM } = await import('../src/llm.js')
  const ref = { casey: null }
  const brain = makeResilientCallLLM({
    probe: true,
    onRecover: () => ref.casey?.drainQueuedTurns?.().catch(e => ref.casey?.log?.warn?.('[casey] recovery drain failed', { error: e.message })),
  })
  const casey = await createCaseyStore({
    channels,
    callLLM: brain.callLLM,
    llmStatus: brain.status,
    drainPollIntervalMs: process.env.CASEY_DRAIN_POLL_INTERVAL_MS != null ? Number(process.env.CASEY_DRAIN_POLL_INTERVAL_MS) : undefined,
  })
  ref.casey = casey
  casey.resilientStatus = brain.status
  casey.resilientCallLLM = brain.callLLM
  return { casey, brain }
}

export async function finishServingCasey({ casey, brain }) {
  await casey.init()
  try { await brain.status() } catch (e) { console.error('[worker] boot-time readiness warm-up failed (continuing, self-heals on first real turn):', e.message) }
  await casey.start()
  return casey
}
