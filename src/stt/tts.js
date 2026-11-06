import { SttError, STT_FAILURE } from './errors.js'
import { accessToken } from './gcp-auth.js'
import { languageOf } from './languages.js'
import { tagList } from '../timestamp.js'

export const TTS_VOICES = Object.freeze({
  af: { languageCode: 'af-ZA', name: 'af-ZA-Standard-A' },
  en: { languageCode: 'en-GB', name: 'en-GB-Standard-A' },
})

const MAX_SPOKEN_CHARS = 400
const BLOCKING_TAGS = ['opted-out', 'needs-human', 'draft-pending']

export const googleVoiceRepliesEnabled = (env = process.env) => env.CASEY_VOICE_REPLIES === 'google'

export function voiceFor(languageValue) {
  const lang = languageOf(languageValue)
  return lang ? TTS_VOICES[lang.key] || null : null
}

export function voiceReplyEligible({ text, caseRow, language }) {
  const spoken = String(text || '').trim()
  if (!spoken || spoken.length > MAX_SPOKEN_CHARS) return false
  const tags = tagList(caseRow)
  if (!tags.includes('voice-replies') || tags.some(t => BLOCKING_TAGS.includes(t) || t.startsWith('stop-pending'))) return false
  return !!voiceFor(language)
}

export function buildSynthesizeRequest({ text, voice, origin = '' }) {
  return {
    url: `${origin || 'https://texttospeech.googleapis.com'}/v1/text:synthesize`,
    body: { input: { text }, voice, audioConfig: { audioEncoding: 'OGG_OPUS' } },
  }
}

export async function synthesizeGoogle({ text, language, env = process.env, timeoutMs = 8000 }) {
  const voice = voiceFor(language)
  if (!voice) throw new SttError(STT_FAILURE.UNSUPPORTED_LANGUAGE, `no Google voice for ${language}`)
  const req = buildSynthesizeRequest({ text, voice, origin: env.CASEY_TTS_ENDPOINT_ORIGIN || '' })
  const r = await fetch(req.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify(req.body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.audioContent) throw new SttError(STT_FAILURE.UNAVAILABLE, `tts ${r.status}: ${String(j?.error?.message || 'no audio').slice(0, 200)}`)
  return { data_base64: j.audioContent, mime: 'audio/ogg' }
}
