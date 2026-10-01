

const DEFAULT_MODEL = process.env.CASEY_LLM_MODEL || 'claude/sonnet'

function bridgeBackend(bridge, model) {

  return (req) => bridge.callLLM({ ...req, model: req.model || model })
}

export async function resolveCallLLM({ probe = true, model = DEFAULT_MODEL } = {}) {
  if (!probe) return { callLLM: null, source: 'none' }
  let bridge
  try {
    bridge = await import('./agent/acptoapi-bridge.js')
  } catch {
    return { callLLM: null, source: 'none' }
  }

  let reachable = await bridge.isReachable(undefined, model).catch(() => false)
  if (!reachable) {

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

export function makeResilientCallLLM({ probe = true, model = DEFAULT_MODEL, intervalMs = 30000, resolveDebounceMs = null, resolve = resolveCallLLM, now = null, slowMs = 20000, slowWindow = 5, onRecover = null } = {}) {
  let backend = null
  let last = { source: 'none', model: null, url: null }
  let inflight = null
  let lastAttempt = -Infinity

  const recent = []
  const recordTurn = (ms, ok) => { recent.push({ ms, ok, at: clock() }); if (recent.length > slowWindow) recent.shift() }

  const MIN_SAMPLES_FOR_DEGRADED = 2
  const completionHealth = () => {
    if (!recent.length) return { degraded: false, lastMs: null, recentSlow: 0, newestSampleAt: null }
    const slow = recent.filter(r => !r.ok || r.ms >= slowMs)
    const degraded = recent.length >= MIN_SAMPLES_FOR_DEGRADED && slow.length === recent.length
    return { degraded, lastMs: recent[recent.length - 1].ms, recentSlow: slow.length, newestSampleAt: recent[recent.length - 1].at }
  }

  const clock = now || (() => Date.now())

  async function resolveOnce() {
    const wasDown = !backend
    const r = await resolve({ probe, model }).catch(() => ({ callLLM: null, source: 'none' }))
    backend = r.callLLM || null
    last = { source: r.source || (backend ? 'acptoapi' : 'none'), model: r.model || null, url: r.url || null }

    if (wasDown && backend && typeof onRecover === 'function') {
      try { Promise.resolve(onRecover()).catch(() => {}) } catch {  }
    }
    return backend
  }

  const RESOLVE_DEBOUNCE_MS = resolveDebounceMs != null ? resolveDebounceMs : Math.min(intervalMs, 3000)
  async function ensure() {
    if (backend) return backend
    if (inflight) return inflight
    if (clock() - lastAttempt < RESOLVE_DEBOUNCE_MS) return backend
    lastAttempt = clock()
    inflight = resolveOnce().finally(() => { inflight = null })
    return inflight
  }

  const callLLM = async (req, { recordHealth = true } = {}) => {
    const b = await ensure()
    if (!b) throw new Error('AI helper offline (provider unreachable); no reply sent')

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

  const status = async () => {

    if (!backend && clock() - lastAttempt >= RESOLVE_DEBOUNCE_MS) await ensure()
    const health = completionHealth()

    if (backend && health.degraded && health.newestSampleAt != null && clock() - health.newestSampleAt >= intervalMs) {
      return { ...last, degraded: false, lastMs: health.lastMs, recentSlow: health.recentSlow, ok: true }
    }
    return { ...last, ...health, ok: !!backend && health.degraded !== true }
  }

  return { callLLM, status, _ensure: ensure }
}
