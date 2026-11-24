import { SttError, STT_FAILURE, failureKindOf } from './errors.js'
import { googleSttConfig } from './config.js'
import { oggOpusDurationSeconds } from './ogg.js'
import { splitAudio } from './chunker.js'
import { recognizeChunk, mergeSegments } from './google-recognize.js'
import { languageOf, longModelLanguage } from './languages.js'
import { runSpecialists } from './specialist.js'
import { caseyText } from '../deployment-text.js';

const MAX_INLINE_BYTES = 9 * 1024 * 1024

function routeFor(cfg, hintLanguage) {
  const long = longModelLanguage(hintLanguage)
  if (long) return { model: 'long', location: 'global', languageCodes: [long.code], hinted: long.key }
  return { model: cfg.model, location: cfg.location, languageCodes: cfg.languageCodes, hinted: null }
}

async function recognizeGoogle(buffer, cfg, target) {
  if (!buffer?.length) throw new SttError(STT_FAILURE.NO_AUDIO, caseyText("src/stt/engine.js#s0"))
  const ogg = oggOpusDurationSeconds(buffer)
  let durationSec = ogg
  let chunks
  if (ogg !== null && ogg <= cfg.chunkSeconds && buffer.length <= MAX_INLINE_BYTES) {
    chunks = [{ content: buffer, startSec: 0, endSec: ogg }]
  } else {
    const split = await splitAudio(buffer, { ffmpeg: cfg.ffmpeg, chunkSeconds: cfg.chunkSeconds, maxSeconds: cfg.maxSeconds })
    durationSec = split.durationSec
    chunks = split.chunks
  }
  const results = await Promise.all(chunks.map((c) => recognizeChunk({ content: c.content, target, cfg })))
  const merged = mergeSegments(results)
  const lang = languageOf(target.hinted ? target.languageCodes[0] : merged.language)
  return { merged, lang, durationSec, chunks: chunks.length }
}

async function runGoogle(buffer, { hintLanguage, env }) {
  const t0 = Date.now()
  const cfg = googleSttConfig(env)
  const target = routeFor(cfg, hintLanguage)
  const provider = `google-${target.model}`
  try {
    const rec = await recognizeGoogle(buffer, cfg, target)
    const text = rec.merged.text
    return {
      id: 'google', engine: 'google', provider, ms: Date.now() - t0, text,
      error: text ? '' : caseyText("src/stt/engine.js#s3"), status: null, failureKind: text ? '' : STT_FAILURE.NO_SPEECH,
      language: rec.merged.language || (target.hinted ? target.languageCodes[0] : null),
      languages: rec.merged.languages, languageKey: rec.lang?.key || null,
      durationSec: rec.durationSec, chunks: rec.chunks,
    }
  } catch (e) {
    return {
      id: 'google', engine: 'google', provider, ms: Date.now() - t0, text: '',
      error: caseyText("src/stt/engine.js#s2", [String(e?.message || e)]), status: null, failureKind: failureKindOf(e),
      language: null, languages: [], languageKey: null, durationSec: null, chunks: 0,
    }
  }
}

export async function transcribeEngines(buffer, mimeType, { hintLanguage = null, env = process.env } = {}) {
  const [google, specialists] = await Promise.all([
    runGoogle(buffer, { hintLanguage, env }),
    runSpecialists(buffer, mimeType, { env }),
  ])
  return { google, engines: [google, ...specialists] }
}
