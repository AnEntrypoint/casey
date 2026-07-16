// hooks/media.js -- casey's opt-in media enrichment pipeline (voice/photo/tts).
//
// Split out of gateway-hooks.js (see AGENTS.md's Source map for the file's
// role). Each function here is dispatched DIRECTLY by casey's own
// deterministic code -- never exposed to the agent's own enabledToolsets, so
// this never reopens the tool-access security fix documented in AGENTS.md's
// "pi tool surface" section. Moved verbatim; only the physical location
// changed.

import { truncate } from './heuristics.js'

// Best-effort voice-note transcription via freddie's transcription tool (an
// acptoapi /v1/audio/transcriptions Whisper passthrough) -- OPT-IN, degrades
// silently to the operator-listens fallback that already existed when
// OPENAI_API_KEY is unset or the request fails, matching the no-fallback-text
// invariant's spirit (the transcript is an ENHANCEMENT to the recorded note,
// never something the reply pipeline depends on existing). A field worker's
// voice note is the single most valuable one-shot artifact on the intake path
// (AGENTS.md), so an automatic transcript folded into the case timeline lets
// the team read it immediately instead of waiting for someone to listen.
// Writes to a temp file because freddie's tool takes a file_path, not a
// buffer; the file is removed in a finally so a crash never leaks it.
export async function transcribeAudio(buffer, mimeType) {
  if (process.env.CASEY_TRANSCRIBE_VOICE_NOTES !== '1') return ''
  if (!process.env.OPENAI_API_KEY) return ''
  let tmpPath = ''
  try {
    const os = await import('node:os')
    const path = await import('node:path')
    const fs = await import('node:fs')
    const ext = /ogg/.test(mimeType || '') ? 'ogg' : /mp3|mpeg/.test(mimeType || '') ? 'mp3' : 'wav'
    tmpPath = path.join(os.tmpdir(), `casey-voice-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`)
    fs.writeFileSync(tmpPath, buffer)
    const { host } = await import('freddie')
    const h = host()
    const result = await h.pi.dispatchTool('transcription', { file_path: tmpPath })
    const parsed = typeof result === 'string' ? JSON.parse(result) : result
    return typeof parsed?.text === 'string' ? parsed.text.trim() : ''
  } catch {
    return '' // best-effort only -- a transcription failure never blocks the reply path
  } finally {
    if (tmpPath) { try { (await import('node:fs')).unlinkSync(tmpPath) } catch { /* best effort cleanup */ } }
  }
}

// Best-effort photo description via freddie's vision tool (an acptoapi
// multimodal chat-completion passthrough) -- OPT-IN, same shape as
// transcribeAudio above: dispatched DIRECTLY by casey's own deterministic
// code (never exposed to the agent's own enabledToolsets, so this does not
// reopen the tool-access security fix), degrades silently to the original
// operator-opens-the-photo fallback on any failure/absence. A photo of a
// sick/dead animal is the single most valuable on-site artifact (AGENTS.md);
// an automatic description (visible lesions, swelling, lameness) folded into
// the case timeline lets the team see what matters immediately, not only
// once an operator manually opens the saved file. Passes the image as a
// base64 data: URI (freddie's vision tool forwards image_url verbatim to
// acptoapi's multimodal chat) rather than a file path -- no temp file, no
// dependency on casey's own /media static route being reachable from
// wherever acptoapi's provider call actually executes.
export async function describePhoto(buffer, mimeType) {
  if (process.env.CASEY_DESCRIBE_PHOTOS !== '1') return ''
  if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) return ''
  try {
    const mime = /png/.test(mimeType || '') ? 'image/png' : /gif/.test(mimeType || '') ? 'image/gif' : /webp/.test(mimeType || '') ? 'image/webp' : 'image/jpeg'
    const dataUri = `data:${mime};base64,${buffer.toString('base64')}`
    const { host } = await import('freddie')
    const h = host()
    const result = await h.pi.dispatchTool('vision', {
      image_url: dataUri,
      prompt: 'This is a photo of livestock a field worker sent while reporting a possible animal-health incident. Describe only what is visibly relevant to animal health: any visible signs of illness or injury (e.g. lesions, swelling, discharge, lameness, posture), the apparent species, and how many animals are visible. Do not speculate on a diagnosis.',
    })
    const parsed = typeof result === 'string' ? JSON.parse(result) : result
    return typeof parsed?.content === 'string' ? parsed.content.trim() : ''
  } catch {
    return '' // best-effort only -- a vision-call failure never blocks the reply path
  }
}

// Best-effort voice REPLY via freddie's tts tool (an acptoapi /v1/audio/speech
// passthrough) -- OPT-IN, the exact mirror of transcribeAudio's voice-note-IN
// path. A rural reporter who can send a voice note but struggles to READ a text
// reply is the single most under-served contact on the intake path; speaking the
// reply back to them in their own words closes that gap. Dispatched DIRECTLY by
// casey's deterministic code (never exposed to the agent's enabledToolsets, same
// security discipline as transcribeAudio/describePhoto), and it runs AFTER the
// degraded/blanked-reply gate so a turn that correctly sent nothing never speaks.
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
    const { host } = await import('freddie')
    const h = host()
    const result = await h.pi.dispatchTool('tts', { text: truncate(spoken, 600), provider })
    const parsed = typeof result === 'string' ? JSON.parse(result) : result
    if (!parsed?.audio_base64) return null
    return { data_base64: parsed.audio_base64, mime: parsed.contentType || 'audio/mpeg' }
  } catch {
    return null // best-effort only -- a tts failure never blocks the text reply
  }
}
