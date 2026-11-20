

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { truncate } from './heuristics.js'
import { fetchWithTimeout } from '../adapters/webhook-platform-base.js'
import { transcribeLocal, localSttEnabled } from './local-stt.js'
import { recordStt } from '../stt/metrics.js'
import { STT_FAILURE } from '../stt/errors.js'
import { googleVoiceRepliesEnabled, voiceReplyEligible, synthesizeGoogle } from '../stt/tts.js'
import { parseReport } from '../timestamp.js'
import { dataPolicyMode, openrouterProviderField, auditWrite } from '../llm-data-policy.js'
import { caseyText } from '../deployment-text.js';

const MEDIA_TOOL_TIMEOUT_MS = Number(process.env.CASEY_MEDIA_TOOL_TIMEOUT_MS) || 12000

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`media tool timed out after ${ms}ms`)), ms)
    promise.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

const OPENROUTER_TRANSCRIBE_MODELS = (process.env.CASEY_TRANSCRIBE_MODEL || 'google/gemini-3.5-transcribe,openai/whisper-large-v3').split(',').map(x => x.trim()).filter(Boolean)

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
  if (!key) return { text: '', error: caseyText("src/hooks/media.js#s0") }
  const r = await fetchWithTimeout('https://openrouter.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, input_audio: { data: buffer.toString('base64'), format: audioFormat(mimeType) } }),
  }, MEDIA_TOOL_TIMEOUT_MS)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { text: '', error: `${model} ${r.status}: ${truncate(j?.error?.message || '', 160)}` }
  const text = String(j?.text || '').trim()
  return { text, error: text ? '' : caseyText("src/hooks/media.js#s1", [model]) }
}

async function transcribeViaOpenrouterChat(buffer, mimeType, model, providerField) {
  const key = openrouterKey()
  if (!key) return { text: '', error: caseyText("src/hooks/media.js#s2") }
  const r = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: 1024, provider: providerField,
      messages: [{ role: 'user', content: [
        { type: 'text', text: caseyText("src/hooks/media.js#0", [NO_SPEECH]) },
        { type: 'input_audio', input_audio: { data: buffer.toString('base64'), format: audioFormat(mimeType) } },
      ] }],
    }),
  }, MEDIA_TOOL_TIMEOUT_MS)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { text: '', error: `${model} ${r.status}: ${truncate(j?.error?.message || '', 160)}` }
  const raw = j?.choices?.[0]?.message?.content
  const text = String(Array.isArray(raw) ? raw.map(p => p?.text || '').join('') : (raw || '')).trim()
  if (!text || text === NO_SPEECH) return { text: '', error: caseyText("src/hooks/media.js#s3", [model]), noSpeech: true, served_by: j?.provider || null }
  return { text, error: '', served_by: j?.provider || null }
}

function failureKindFor(tr) {
  if (/disabled/.test(tr.error || '')) return STT_FAILURE.DISABLED
  if (/no audio bytes/.test(tr.error || '')) return STT_FAILURE.NO_AUDIO
  if (/no intelligible speech/.test(tr.error || '')) return STT_FAILURE.NO_SPEECH
  return STT_FAILURE.UNAVAILABLE
}

async function redactTranscripts(tr, redact) {
  if (!redact) return tr
  const text = tr.text ? await redact(tr.text) : tr.text
  return { ...tr, text }
}

export async function transcribeAudioDetailed(buffer, mimeType, { redact = null } = {}) {
  let tr = await transcribeLegacy(buffer, mimeType)
  if (tr.text) tr = { engine: tr.provider, failureKind: '', ...tr }
  else tr = { ...tr, failureKind: tr.failureKind || failureKindFor(tr) }
  tr = await redactTranscripts(tr, redact)
  recordStt(tr)
  return tr
}

async function transcribeLegacy(buffer, mimeType) {
  const t0 = Date.now()
  if (process.env.CASEY_TRANSCRIBE_VOICE_NOTES === '0') return { text: '', provider: 'off', ms: 0, error: caseyText("src/hooks/media.js#1") }
  if (!buffer?.length) return { text: '', provider: 'none', ms: 0, error: caseyText("src/hooks/media.js#s4") }
  try {
    if (process.env.OPENAI_API_KEY) {
      const tmpPath = path.join(os.tmpdir(), `casey-voice-${Date.now()}-${Math.random().toString(36).slice(2)}.${audioFormat(mimeType) === 'ogg' ? 'ogg' : audioFormat(mimeType)}`)
      try {
        fs.writeFileSync(tmpPath, buffer)
        const { transcribe } = await import('../agent/media-tools.js')
        const parsed = await withTimeout(transcribe({ file_path: tmpPath }), MEDIA_TOOL_TIMEOUT_MS)
        const text = typeof parsed?.text === 'string' ? parsed.text.trim() : ''
        if (text) return { text, provider: 'whisper', ms: Date.now() - t0, error: '' }
      } finally { try { fs.unlinkSync(tmpPath) } catch {  } }
    }
    let last = { text: '', error: caseyText("src/hooks/media.js#s5"), provider: 'none' }
    const mode = dataPolicyMode()
    const providerField = openrouterProviderField(mode)
    const chatPath = mode !== 'allow'

    const models = (!openrouterKey() && localSttEnabled()) ? [] : (chatPath ? OPENROUTER_TRANSCRIBE_CHAT_MODELS : OPENROUTER_TRANSCRIBE_MODELS)
    for (const model of models) {
      let res
      try { res = chatPath ? await transcribeViaOpenrouterChat(buffer, mimeType, model, providerField) : await transcribeViaOpenrouter(buffer, mimeType, model) } catch (e) { res = { text: '', error: `${model}: ${String(e?.message || e)}` } }
      last = { ...res, provider: `openrouter:${model}` }
      auditWrite({ event: 'transcribe', policy: mode, endpoint: chatPath ? 'chat/completions' : 'audio/transcriptions', provider_field: providerField, model, ok: !!res.text, served_by: res.served_by || null })

      if (res.text || res.noSpeech) break
    }
    if (!last.text && !last.noSpeech && localSttEnabled()) {

      const local = await transcribeLocal(buffer, mimeType)
      if (local.text) return { ...local, ms: Date.now() - t0 }
      last = { ...last, error: [last.error, local.error].filter(Boolean).join('; ') }
    }
    return { ...last, ms: Date.now() - t0 }
  } catch (e) {
    return { text: '', provider: 'error', ms: Date.now() - t0, error: String(e?.message || e) }
  }
}

export async function transcribeAudio(buffer, mimeType) {
  return (await transcribeAudioDetailed(buffer, mimeType)).text
}

export async function describePhoto(buffer, mimeType) {
  if (process.env.CASEY_DESCRIBE_PHOTOS !== '1') return ''
  if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) return ''
  try {
    const mime = /png/.test(mimeType || '') ? 'image/png' : /gif/.test(mimeType || '') ? 'image/gif' : /webp/.test(mimeType || '') ? 'image/webp' : 'image/jpeg'
    const dataUri = `data:${mime};base64,${buffer.toString('base64')}`
    const { describeImage } = await import('../agent/media-tools.js')
    const parsed = await withTimeout(describeImage({
      image_url: dataUri,
      prompt: caseyText("src/hooks/media.js#2"),
    }), MEDIA_TOOL_TIMEOUT_MS)
    return typeof parsed?.content === 'string' ? parsed.content.trim() : ''
  } catch {
    return ''
  }
}

async function synthesizeGoogleReply(text, caseRow, log) {
  const language = parseReport(caseRow).language_detected
  if (!voiceReplyEligible({ text, caseRow, language })) return null
  try { return await synthesizeGoogle({ text: String(text).trim(), language }) }
  catch (e) { log?.warn?.('[casey] voice reply not made; the text reply is sent alone', { caseId: caseRow?.id, error: e.message }); return null }
}

export async function synthesizeVoice(text, { caseRow = null, log = null } = {}) {
  if (googleVoiceRepliesEnabled()) return synthesizeGoogleReply(text, caseRow, log)
  if (process.env.CASEY_VOICE_REPLIES !== '1') return null
  if (!process.env.OPENAI_API_KEY && !process.env.ELEVENLABS_API_KEY) return null

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
    return null
  }
}
