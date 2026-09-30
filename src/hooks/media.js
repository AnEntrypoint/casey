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
import { transcribeLocal, localSttEnabled } from './local-stt.js'
import { dataPolicyMode, openrouterProviderField, auditWrite } from '../llm-data-policy.js'

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

// Best-effort voice-note transcription, ON whenever a provider key exists (or the
// offline local whisper fallback, hooks/local-stt.js, is installed: CASEY_LOCAL_STT=0 turns it off)
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

// DATA POLICY (CASEY_LLM_DATA_POLICY, src/llm-data-policy.js). OpenRouter's
// /audio/transcriptions IGNORES the request's provider object (measured
// 2026-09-29: a nonexistent provider.only still answered 200), so with the
// policy on, no dedicated transcription model can be held to no-training and
// none is used. Voice notes are transcribed instead through /chat/completions
// with an audio-capable chat model, where provider.data_collection / zdr are
// enforced (a nonexistent provider.only answers 404). CASEY_TRANSCRIBE_CHAT_MODEL
// overrides the comma-separated chain.
const OPENROUTER_TRANSCRIBE_CHAT_MODELS = (process.env.CASEY_TRANSCRIBE_CHAT_MODEL || 'google/gemini-2.5-flash,mistralai/voxtral-small-24b-2507').split(',').map(x => x.trim()).filter(Boolean)
const NO_SPEECH = 'NO_SPEECH'

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

async function transcribeViaOpenrouterChat(buffer, mimeType, model, providerField) {
  const key = openrouterKey()
  if (!key) return { text: '', error: 'no OPENROUTER_API_KEY' }
  const r = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: 1024, provider: providerField,
      messages: [{ role: 'user', content: [
        { type: 'text', text: `Transcribe this voice note verbatim in the language spoken. Output only the transcript. If there is no intelligible speech, output exactly ${NO_SPEECH}.` },
        { type: 'input_audio', input_audio: { data: buffer.toString('base64'), format: audioFormat(mimeType) } },
      ] }],
    }),
  }, MEDIA_TOOL_TIMEOUT_MS)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { text: '', error: `${model} ${r.status}: ${truncate(j?.error?.message || '', 160)}` }
  const raw = j?.choices?.[0]?.message?.content
  const text = String(Array.isArray(raw) ? raw.map(p => p?.text || '').join('') : (raw || '')).trim()
  if (!text || text === NO_SPEECH) return { text: '', error: `${model}: no intelligible speech`, noSpeech: true, served_by: j?.provider || null }
  return { text, error: '', served_by: j?.provider || null }
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
    const mode = dataPolicyMode()
    const providerField = openrouterProviderField(mode)
    const chatPath = mode !== 'allow'
    // No OpenRouter key and a local fallback switched on: skip the provider calls that cannot succeed.
    const models = (!openrouterKey() && localSttEnabled()) ? [] : (chatPath ? OPENROUTER_TRANSCRIBE_CHAT_MODELS : OPENROUTER_TRANSCRIBE_MODELS)
    for (const model of models) {
      let res
      try { res = chatPath ? await transcribeViaOpenrouterChat(buffer, mimeType, model, providerField) : await transcribeViaOpenrouter(buffer, mimeType, model) } catch (e) { res = { text: '', error: `${model}: ${String(e?.message || e)}` } }
      last = { ...res, provider: `openrouter:${model}` }
      auditWrite({ event: 'transcribe', policy: mode, endpoint: chatPath ? 'chat/completions' : 'audio/transcriptions', provider_field: providerField, model, ok: !!res.text, served_by: res.served_by || null })
      // A model that heard nothing is an answer; a second model asked about the same silence tends to invent words.
      if (res.text || res.noSpeech) break
    }
    if (!last.text && !last.noSpeech && localSttEnabled()) {
      // Offline fallback (hooks/local-stt.js): nothing leaves this machine, so the data policy does not apply.
      const local = await transcribeLocal(buffer, mimeType)
      if (local.text) return { ...local, ms: Date.now() - t0 }
      last = { ...last, error: [last.error, local.error].filter(Boolean).join('; ') }
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
  // ElevenLabs has no no-training guarantee casey can check: with the data policy on it is not used.
  if (!process.env.OPENAI_API_KEY && dataPolicyMode() !== 'allow') return null
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
