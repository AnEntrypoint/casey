// Casey's own transcription/vision/tts tools, calling acptoapi directly.
// Ported from freddie's plugins/tools/media/lib/{transcription,vision,tts}.js
// (freddie's plugin-host surface was removed in a later upstream rewrite --
// see AGENTS.md's freddie-port PRD rows). Registered into casey's own tool
// registry under toolset 'creative', never the 'cases' toolset -- dispatched
// only by casey's own deterministic code (src/hooks/media.js), never
// agent-callable, matching the prior security invariant.
import fs from 'node:fs'
import { callLLM, getAcptoapiUrl } from './acptoapi-bridge.js'
import { registerTool } from './tool-registry.js'

export const transcriptionTool = {
  name: 'transcription',
  toolset: 'creative',
  schema: { name: 'transcription', description: 'Transcribe audio via acptoapi /v1/audio/transcriptions (OpenAI Whisper).', parameters: { type: 'object', properties: { file_path: { type: 'string' }, model: { type: 'string', default: 'whisper-1' } }, required: ['file_path'] } },
  handler: async ({ file_path, model = 'whisper-1' }) => {
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
  },
}

export const visionTool = {
  name: 'vision',
  toolset: 'creative',
  schema: { name: 'vision', description: 'Describe an image (URL or base64) via acptoapi chat-completions.', parameters: { type: 'object', properties: { image_url: { type: 'string' }, prompt: { type: 'string', default: 'Describe this image.' }, model: { type: 'string' } }, required: ['image_url'] } },
  handler: async ({ image_url, prompt = 'Describe this image.', model }) => {
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
  },
}

export const ttsTool = {
  name: 'tts',
  toolset: 'creative',
  schema: { name: 'tts', description: 'Synthesize speech (OpenAI tts-1 or ElevenLabs) via acptoapi.', parameters: { type: 'object', properties: { text: { type: 'string' }, provider: { type: 'string', enum: ['openai', 'elevenlabs'], default: 'openai' }, voice: { type: 'string' } }, required: ['text'] } },
  handler: async ({ text, provider = 'openai', voice = 'alloy' }) => {
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
  },
}

export function registerMediaTools() {
  registerTool(transcriptionTool)
  registerTool(visionTool)
  registerTool(ttsTool)
}
