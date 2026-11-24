

import { truncate } from './heuristics.js'
import { googleSttEnabled } from '../stt/config.js'
import { transcribeVoiceNote } from '../stt/voice-note.js'
import { recordStt } from '../stt/metrics.js'
import { STT_FAILURE } from '../stt/errors.js'
import { googleVoiceRepliesEnabled, voiceReplyEligible, synthesizeGoogle } from '../stt/tts.js'
import { parseReport } from '../timestamp.js'
import { dataPolicyMode } from '../llm-data-policy.js'
import { caseyText } from '../deployment-text.js';

const MEDIA_TOOL_TIMEOUT_MS = Number(process.env.CASEY_MEDIA_TOOL_TIMEOUT_MS) || 12000

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`media tool timed out after ${ms}ms`)), ms)
    promise.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

export async function transcribeAudioDetailed(buffer, mimeType, { hintLanguage = null, callLLM = null, redact = null } = {}) {
  const t0 = Date.now()
  let tr
  if (process.env.CASEY_TRANSCRIBE_VOICE_NOTES === '0') {
    tr = { engine: null, text: '', error: caseyText("src/hooks/media.js#1"), failureKind: STT_FAILURE.DISABLED }
  } else if (!googleSttEnabled()) {
    tr = { engine: null, text: '', error: caseyText("src/hooks/media.js#s6"), failureKind: STT_FAILURE.DISABLED }
  } else if (!buffer?.length) {
    tr = { engine: null, text: '', error: caseyText("src/hooks/media.js#s4"), failureKind: STT_FAILURE.NO_AUDIO }
  } else {
    tr = await transcribeVoiceNote(buffer, mimeType, { hintLanguage, callLLM, redact })
  }
  tr.ms = Date.now() - t0
  recordStt(tr)
  return tr
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
