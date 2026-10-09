import { SttError, STT_FAILURE, failureKindOf } from './errors.js'
import { googleSttConfig } from './config.js'
import { oggOpusDurationSeconds } from './ogg.js'
import { splitAudio } from './chunker.js'
import { recognizeChunk, mergeSegments } from './google-recognize.js'
import { languageOf, longModelLanguage } from './languages.js'
import { specialistFor, transcribeSpecialist } from './specialist.js'

const MAX_INLINE_BYTES = 9 * 1024 * 1024

function routeFor(cfg, hintLanguage) {
  const long = longModelLanguage(hintLanguage)
  if (long) return { model: 'long', location: 'global', languageCodes: [long.code], hinted: long.key }
  return { model: cfg.model, location: cfg.location, languageCodes: cfg.languageCodes, hinted: null }
}

async function mapLimited(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i) } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export async function transcribeGoogle(buffer, mimeType, { hintLanguage = null, env = process.env } = {}) {
  const t0 = Date.now()
  const cfg = googleSttConfig(env)
  const target = routeFor(cfg, hintLanguage)
  const base = { engine: 'google', provider: `google-${target.model}`, model: target.model, location: target.location, hinted: target.hinted }
  try {
    if (!buffer?.length) throw new SttError(STT_FAILURE.NO_AUDIO, 'no audio bytes')
    const deadline = t0 + cfg.budgetMs
    const signalMs = () => {
      const left = deadline - Date.now()
      if (left < 500) throw new SttError(STT_FAILURE.TIMEOUT, `speech budget of ${cfg.budgetMs}ms spent`)
      return Math.min(cfg.requestTimeoutMs, left)
    }
    const ogg = oggOpusDurationSeconds(buffer)
    let durationSec = ogg
    let chunks
    if (ogg !== null && ogg <= cfg.chunkSeconds && buffer.length <= MAX_INLINE_BYTES) {
      chunks = [{ content: buffer, startSec: 0, endSec: ogg }]
    } else {
      const split = await splitAudio(buffer, { ffmpeg: cfg.ffmpeg, chunkSeconds: cfg.chunkSeconds, maxSeconds: cfg.maxSeconds, deadline })
      durationSec = split.durationSec
      chunks = split.chunks
    }
    const results = await mapLimited(chunks, cfg.concurrency, (c) => recognizeChunk({ content: c.content, target, cfg, signalMs }))
    const merged = mergeSegments(results)
    const lang = languageOf(target.hinted ? target.languageCodes[0] : merged.language)
    const common = {
      ...base, ms: Date.now() - t0, durationSec, chunks: chunks.length,
      language: merged.language || (target.hinted ? target.languageCodes[0] : null), languageKey: lang?.key || null,
      languages: merged.languages, languageSupported: !!lang, confidence: merged.confidence, segments: merged.segments,
    }
    const specialistUrl = merged.text && lang ? specialistFor(lang.key, env) : null
    if (specialistUrl) {
      const s = await transcribeSpecialist(specialistUrl, buffer, mimeType, { timeoutMs: cfg.requestTimeoutMs, env })
      if (s.text) return { ...common, engine: 'specialist', provider: `specialist-${lang.key}`, text: s.text, error: '', failureKind: '', google_text: merged.text, specialist_language: lang.key }
      return { ...common, text: merged.text, error: '', failureKind: '', specialist_error: s.error }
    }
    if (!merged.text) return { ...common, text: '', error: 'no intelligible speech', failureKind: STT_FAILURE.NO_SPEECH }
    return { ...common, text: merged.text, error: '', failureKind: '' }
  } catch (e) {
    return { ...base, text: '', ms: Date.now() - t0, error: `google stt: ${String(e?.message || e)}`, failureKind: failureKindOf(e) }
  }
}
