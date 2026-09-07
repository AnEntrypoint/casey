// Casey's own transcription/vision/tts functions, calling acptoapi directly.
// Ported from freddie's plugins/tools/media/lib/{transcription,vision,tts}.js
// (freddie's plugin-host surface was removed in a later upstream rewrite --
// see AGENTS.md's freddie-port PRD rows). Plain functions, not Cordis tools:
// dispatched ONLY by casey's own deterministic code (src/hooks/media.js),
// never through freddie's agent loop / ctx.tools, so they are never
// model-visible or model-callable -- matching the prior security invariant
// with no allowlist dependency at all (the strongest form of the guarantee).
import fs from 'node:fs'
import { callLLM, getAcptoapiUrl } from './acptoapi-bridge.js'

export async function transcribe({ file_path, model = 'whisper-1' }) {
  if (!fs.existsSync(file_path)) return { error: 'file not found: ' + file_path }
  const base = (getAcptoapiUrl() || '').replace(/\/v1\/?$/, '')
  const blob = new Blob([fs.readFileSync(file_path)])
  const fd = new FormData()
  fd.append('file', blob, file_path.split(/[\\/]/).pop())
  fd.append('model', model)
  const r = await fetch(base + '/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: 'Bearer none' },
    body: fd,
  })
  return await r.json()
}

export async function describeImage({ image_url, prompt = 'Describe this image.', model }) {
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: image_url } },
    ],
  }]
  try {
    const r = await callLLM({ messages, model: model || 'openai/gpt-4o-mini' })
    return { content: r.content, raw: r.raw }
  } catch (e) {
    return { error: e.message, via: getAcptoapiUrl() }
  }
}

export async function synthesizeSpeech({ text, provider = 'openai', voice = 'alloy' }) {
  const base = (getAcptoapiUrl() || '').replace(/\/v1\/?$/, '')
  const body = provider === 'elevenlabs'
    ? { text, voice: voice || '21m00Tcm4TlvDq8ikWAM', provider: 'elevenlabs' }
    : { model: 'tts-1', input: text, voice }
  const xProv = provider === 'elevenlabs' ? 'tts.elevenlabs' : 'speech.openai'
  const r = await fetch(base + '/v1/audio/speech', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-provider': xProv, authorization: 'Bearer none' },
    body: JSON.stringify(body),
  })
  const buf = Buffer.from(await r.arrayBuffer())
  return { status: r.status, contentType: r.headers.get('content-type'), audio_base64: buf.toString('base64'), bytes: buf.byteLength }
}
