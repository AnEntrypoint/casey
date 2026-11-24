import { transcribeEngines } from './engine.js'
import { synthesizeVoiceNote } from './synthesis.js'
import { STT_FAILURE } from './errors.js'

function failureFor(engines, synthesis) {
  if (synthesis.verdict === 'heard') return ''
  if (synthesis.error) return STT_FAILURE.UNAVAILABLE
  if (engines.some((e) => e.text)) return STT_FAILURE.NO_SPEECH
  return engines.find((e) => e.failureKind)?.failureKind || STT_FAILURE.NO_SPEECH
}

export async function transcribeVoiceNote(buffer, mimeType, { hintLanguage = null, callLLM = null, redact = null, env = process.env } = {}) {
  const { google, engines } = await transcribeEngines(buffer, mimeType, { hintLanguage, env })
  const redacted = redact
    ? await Promise.all(engines.map(async (e) => (e.text ? { ...e, text: await redact(e.text) } : e)))
    : engines
  const synthesis = await synthesizeVoiceNote(redacted, { callLLM, caseLanguage: google.language || hintLanguage || null })
  const text = synthesis.verdict === 'heard' && redact ? await redact(synthesis.transcript) : synthesis.transcript
  const failureKind = failureFor(redacted, synthesis)
  return {
    engine: 'synthesis',
    provider: `synthesis:${synthesis.llm_model || 'llm'}`,
    model: synthesis.llm_model,
    text,
    error: synthesis.error,
    failureKind,
    language: google.language || hintLanguage || null,
    languages: google.languages,
    languageKey: google.languageKey,
    durationSec: google.durationSec,
    chunks: google.chunks,
    engines: redacted,
    synthesis: { verdict: synthesis.verdict, agreed: synthesis.agreed, reason: synthesis.reason, llm_model: synthesis.llm_model, decided_at: synthesis.decided_at, error: synthesis.error },
  }
}
