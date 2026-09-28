// hooks/media.js -- casey's opt-in media enrichment pipeline (voice/photo/tts).
//
// SECURITY: every function here is dispatched DIRECTLY by casey's own
// deterministic code. None of them is registered on freddie's ctx.tools or
// named in the agent's enabledToolsets, so none is model-visible or
// model-callable -- the guarantee holds with no allowlist dependency at all.
// Do not expose any of them as a tool: freddie's ctx.tools is one global
// registry (AGENTS.md, "Architecture"), so a registration here is reachable
// from a contact-facing conversation.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { truncate } from './heuristics.js'
import { fetchWithTimeout } from '../adapters/webhook-platform-base.js'

// None of the three dispatchTool calls below carry any timeout of their own
// (freddie's dispatch path and the bare fetch() calls beneath it are both
// unbounded), and transcribeAudio/describePhoto run BEFORE turnStartedAt is
// set (hooks/inbound-turn.js), so they sit entirely outside
// CASEY_TURN_HARD_DEADLINE_MS -- a half-open connection to the transcription/
// vision/tts provider would hang the whole inbound turn and the per-contact
// concurrency gate forever. Bounded well under the 60s turn hard-deadline
// (these three effectively steal from that same budget) so a stuck provider
// still lets the turn's own retry/fallback machinery run with real time left.
const MEDIA_TOOL_TIMEOUT_MS = Number(process.env.CASEY_MEDIA_TOOL_TIMEOUT_MS) || 12000

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`media tool timed out after ${ms}ms`)), ms)
    promise.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

// Best-effort voice-note transcription, ON whenever a provider key exists
// (CASEY_TRANSCRIBE_VOICE_NOTES=0 opts out -- it sends the audio bytes to an
// external API). Provider order: OpenAI Whisper via src/agent/media-tools.js's
// transcribe() when OPENAI_API_KEY is set, else an OpenRouter audio-capable
// chat model (WhatsApp voice notes are ogg/opus, which it takes as-is), so the
// deployment's one OPENROUTER_API_KEY is enough. Degrades to the operator-listens
// fallback on any failure, and the failure REASON is returned rather than
// swallowed, so the caller can log why a note has no transcript. The transcript
// is an ENHANCEMENT to the recorded note, never something the reply depends on.
// OpenRouter's dedicated /audio/transcriptions endpoint, tried in order. Chosen
// 2026-09-28 from OpenRouter's live model list + each vendor's language table:
// google/gemini-3.5-transcribe (~$0.003/min, 85+ languages incl. Afrikaans and
// Swahili, code-switching) is the best fit for a South African deployment;
// openai/whisper-large-v3 (~$0.0005/min, 99 languages) is the cheap second link.
// No dedicated OpenRouter STT model lists isiXhosa or isiZulu (MAI-Transcribe-2
// lacks even Afrikaans), so those are best-effort on either -- the note always
// says the transcript is the AI helper's and may be wrong. Override the chain
// with CASEY_TRANSCRIBE_MODEL (comma-separated).
const OPENROUTER_TRANSCRIBE_MODELS = (process.env.CASEY_TRANSCRIBE_MODEL || 'google/gemini-3.5-transcribe,openai/whisper-large-v3').split(',').map(x => x.trim()).filter(Boolean)

function openrouterKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY
  try {
    const m = /^OPENROUTER_API_KEY=(.+)$/m.exec(fs.readFileSync(path.join(os.homedir(), '.acptoapi', '.env'), 'utf8'))
    return m ? m[1].trim() : ''
  } catch { return '' }
}

function audioFormat(mimeType) {
  const t = mimeType || ''
  return /ogg|opus/.test(t) ? 'ogg' : /mp3|mpeg/.test(t) ? 'mp3' : /m4a|mp4|aac/.test(t) ? 'aac' : /flac/.test(t) ? 'flac' : /webm/.test(t) ? 'webm' : 'wav'
}

async function transcribeViaOpenrouter(buffer, mimeType, model) {
  const key = openrouterKey()
  if (!key) return { text: '', error: 'no OPENROUTER_API_KEY' }
  const r = await fetchWithTimeout('https://openrouter.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, input_audio: { data: buffer.toString('base64'), format: audioFormat(mimeType) } }),
  }, MEDIA_TOOL_TIMEOUT_MS)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { text: '', error: `${model} ${r.status}: ${truncate(j?.error?.message || '', 160)}` }
  const text = String(j?.text || '').trim()
  return { text, error: text ? '' : `${model}: no intelligible speech` }
}

// Returns {text, provider, ms, error}. `text` is '' on any failure or opt-out.
export async function transcribeAudioDetailed(buffer, mimeType) {
  const t0 = Date.now()
  if (process.env.CASEY_TRANSCRIBE_VOICE_NOTES === '0') return { text: '', provider: 'off', ms: 0, error: 'disabled (CASEY_TRANSCRIBE_VOICE_NOTES=0)' }
  if (!buffer?.length) return { text: '', provider: 'none', ms: 0, error: 'no audio bytes downloaded' }
  try {
    if (process.env.OPENAI_API_KEY) {
      const tmpPath = path.join(os.tmpdir(), `casey-voice-${Date.now()}-${Math.random().toString(36).slice(2)}.${audioFormat(mimeType) === 'ogg' ? 'ogg' : audioFormat(mimeType)}`)
      try {
        fs.writeFileSync(tmpPath, buffer)
        const { transcribe } = await import('../agent/media-tools.js')
        const parsed = await withTimeout(transcribe({ file_path: tmpPath }), MEDIA_TOOL_TIMEOUT_MS)
        const text = typeof parsed?.text === 'string' ? parsed.text.trim() : ''
        if (text) return { text, provider: 'whisper', ms: Date.now() - t0, error: '' }
      } finally { try { fs.unlinkSync(tmpPath) } catch { /* best effort cleanup */ } }
    }
    let last = { text: '', error: 'no transcription model configured', provider: 'none' }
    for (const model of OPENROUTER_TRANSCRIBE_MODELS) {
      let res
      try { res = await transcribeViaOpenrouter(buffer, mimeType, model) } catch (e) { res = { text: '', error: `${model}: ${String(e?.message || e)}` } }
      last = { ...res, provider: `openrouter:${model}` }
      if (res.text) break
    }
    return { ...last, ms: Date.now() - t0 }
  } catch (e) {
    return { text: '', provider: 'error', ms: Date.now() - t0, error: String(e?.message || e) } // never blocks the reply path
  }
}

export async function transcribeAudio(buffer, mimeType) {
  return (await transcribeAudioDetailed(buffer, mimeType)).text
}

// Best-effort photo description via src/agent/media-tools.js's describeImage()
// (an acptoapi multimodal chat-completion passthrough) -- OPT-IN, same shape as
// transcribeAudio above: degrades silently to the operator-opens-the-photo
// fallback on any failure/absence. Passes the image as a base64 data: URI
// (describeImage forwards image_url verbatim to acptoapi's multimodal chat)
// rather than a file path -- no temp file, and no dependency on casey's own
// /media static route being reachable from wherever acptoapi's provider call
// actually executes.
export async function describePhoto(buffer, mimeType) {
  if (process.env.CASEY_DESCRIBE_PHOTOS !== '1') return ''
  if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) return ''
  try {
    const mime = /png/.test(mimeType || '') ? 'image/png' : /gif/.test(mimeType || '') ? 'image/gif' : /webp/.test(mimeType || '') ? 'image/webp' : 'image/jpeg'
    const dataUri = `data:${mime};base64,${buffer.toString('base64')}`
    const { describeImage } = await import('../agent/media-tools.js')
    const parsed = await withTimeout(describeImage({
      image_url: dataUri,
      prompt: 'This is a photo of livestock a field worker sent while reporting a possible animal-health incident. Describe only what is visibly relevant to animal health: any visible signs of illness or injury (e.g. lesions, swelling, discharge, lameness, posture), the apparent species, and how many animals are visible. Do not speculate on a diagnosis.',
    }), MEDIA_TOOL_TIMEOUT_MS)
    return typeof parsed?.content === 'string' ? parsed.content.trim() : ''
  } catch {
    return '' // best-effort only -- a vision-call failure never blocks the reply path
  }
}

// Best-effort voice REPLY via src/agent/media-tools.js's synthesizeSpeech() (an
// acptoapi /v1/audio/speech passthrough) -- OPT-IN. It exists for the reporter
// who can send a voice note but struggles to READ a text reply.
// Called AFTER the degraded/blanked-reply gate in hooks/inbound-turn.js, so a turn
// that correctly sent nothing never speaks -- keep the call site below that gate.
// The audio is ADDITIVE -- the text always sends; a tts failure/absence degrades
// silently to text-only and never blocks the reply path. Length is capped so a
// long reply can't run up TTS cost/latency. Returns {data_base64, mime} for the
// adapter's reply.audio field, or null.
export async function synthesizeVoice(text) {
  if (process.env.CASEY_VOICE_REPLIES !== '1') return null
  if (!process.env.OPENAI_API_KEY && !process.env.ELEVENLABS_API_KEY) return null
  const spoken = (text || '').trim()
  if (!spoken) return null
  try {
    const provider = process.env.ELEVENLABS_API_KEY && !process.env.OPENAI_API_KEY ? 'elevenlabs' : 'openai'
    const { synthesizeSpeech } = await import('../agent/media-tools.js')
    const parsed = await withTimeout(synthesizeSpeech({ text: truncate(spoken, 600), provider }), MEDIA_TOOL_TIMEOUT_MS)
    if (!parsed?.audio_base64) return null
    return { data_base64: parsed.audio_base64, mime: parsed.contentType || 'audio/mpeg' }
  } catch {
    return null // best-effort only -- a tts failure never blocks the text reply
  }
}
