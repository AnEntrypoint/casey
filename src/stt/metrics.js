const state = {
  count: 0, ok: 0, failed: 0, failureKinds: {}, engines: {}, languages: {},
  confidenceSum: 0, confidenceN: 0, audioSeconds: 0, msSum: 0, lastAt: null, lastFailureAt: null, lastError: null, readbackAsked: 0,
}

export function recordStt(tr) {
  state.count += 1
  state.lastAt = Date.now()
  const engine = tr.engine || tr.provider || 'unknown'
  state.engines[engine] = (state.engines[engine] || 0) + 1
  state.msSum += Number(tr.ms) || 0
  if (tr.text) {
    state.ok += 1
    state.audioSeconds += Number(tr.durationSec) || 0
    if (tr.languageKey || tr.language) state.languages[tr.languageKey || tr.language] = (state.languages[tr.languageKey || tr.language] || 0) + 1
    if (typeof tr.confidence === 'number') { state.confidenceSum += tr.confidence; state.confidenceN += 1 }
    return
  }
  state.failed += 1
  const kind = tr.failureKind || 'unknown'
  state.failureKinds[kind] = (state.failureKinds[kind] || 0) + 1
  state.lastFailureAt = Date.now()
  state.lastError = String(tr.error || '').slice(0, 200)
}

export function snapshotStt() {
  return {
    stt_count: state.count,
    stt_ok: state.ok,
    stt_failures: state.failed,
    stt_failure_kinds: { ...state.failureKinds },
    stt_avg_confidence: state.confidenceN ? Number((state.confidenceSum / state.confidenceN).toFixed(3)) : null,
    stt_languages: { ...state.languages },
    stt_engines: { ...state.engines },
    stt_audio_seconds: Math.round(state.audioSeconds),
    stt_avg_ms: state.count ? Math.round(state.msSum / state.count) : null,
    stt_last_at: state.lastAt,
    stt_last_failure_at: state.lastFailureAt,
    stt_last_error: state.lastError,
  }
}
