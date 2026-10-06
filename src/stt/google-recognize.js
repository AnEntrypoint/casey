import { SttError, STT_FAILURE } from './errors.js'
import { accessToken, projectId } from './gcp-auth.js'
import { speechHost } from './config.js'

export function buildRecognizeRequest({ project, location, model, languageCodes, content, wordConfidence, origin = '' }) {
  const features = { enableAutomaticPunctuation: true }
  if (wordConfidence) features.enableWordConfidence = true
  return {
    url: `${origin || `https://${speechHost(location)}`}/v2/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/recognizers/_:recognize`,
    body: {
      config: { autoDecodingConfig: {}, languageCodes, model, features },
      content: content.toString('base64'),
    },
  }
}

const meanOf = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

export function parseRecognizeResponse(json) {
  const segments = []
  for (const r of Array.isArray(json?.results) ? json.results : []) {
    const alt = r?.alternatives?.[0]
    const text = String(alt?.transcript || '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const wordConfs = (Array.isArray(alt.words) ? alt.words : []).map(w => Number(w?.confidence)).filter(c => c > 0)
    const own = Number(alt.confidence)
    segments.push({ text, language: r.languageCode || null, confidence: own > 0 ? own : meanOf(wordConfs) })
  }
  return segments
}

export function mergeSegments(chunks) {
  const segments = chunks.flat()
  const text = segments.map(s => s.text).join(' ').trim()
  const weight = {}
  for (const s of segments) if (s.language) weight[s.language] = (weight[s.language] || 0) + s.text.length
  const language = Object.entries(weight).sort((a, b) => b[1] - a[1])[0]?.[0] || null
  const scored = segments.filter(s => s.confidence != null)
  const chars = scored.reduce((a, s) => a + s.text.length, 0)
  const confidence = chars ? scored.reduce((a, s) => a + s.confidence * s.text.length, 0) / chars : null
  const languages = [...new Set(segments.map(s => s.language).filter(Boolean))]
  return { text, language, languages, confidence, segments }
}

function statusFailure(status) {
  if (status === 401 || status === 403) return STT_FAILURE.AUTH
  if (status === 429) return STT_FAILURE.QUOTA
  if (status === 400) return STT_FAILURE.BAD_AUDIO
  return STT_FAILURE.UNAVAILABLE
}

export async function recognizeChunk({ content, target, cfg, signalMs }) {
  const [token, project] = await Promise.all([accessToken(), projectId()])
  const req = buildRecognizeRequest({
    project, location: target.location, model: target.model, languageCodes: target.languageCodes,
    content, wordConfidence: target.model === 'chirp_2', origin: cfg.origin,
  })
  const attempt = async () => {
    let r
    try {
      r = await fetch(req.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(signalMs()),
      })
    } catch (e) {
      throw new SttError(e?.name === 'TimeoutError' ? STT_FAILURE.TIMEOUT : STT_FAILURE.UNAVAILABLE, `speech request failed: ${e.message}`)
    }
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new SttError(statusFailure(r.status), `speech ${r.status}: ${String(j?.error?.message || '').slice(0, 200)}`)
    return j
  }
  try { return parseRecognizeResponse(await attempt()) }
  catch (e) {
    if (e.kind !== STT_FAILURE.QUOTA && e.kind !== STT_FAILURE.UNAVAILABLE) throw e
    await new Promise(r => setTimeout(r, 400))
    return parseRecognizeResponse(await attempt())
  }
}
