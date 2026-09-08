// hooks/media-intake.js -- one-shot capture of whatever a message carried
// BESIDES text, recorded as explicit case state at ingress.
//
// A photo of a sick or dead animal, and a voice note from a worker who speaks
// rather than types, are the two most valuable on-site artifacts and neither can
// be recovered once the worker leaves. So neither is left to the agent turn to
// notice and record -- on a media-only message it may not narrate them at all.
// This runs deterministically, before any LLM is involved, and is append-only:
// a worker routinely sends more than one photo across a conversation, and
// fill-if-empty silently discarded every arrival after the first.
//
// The photo and audio blocks were two near-identical 40-line copies inline in
// makeCaseHandler (save bytes -> compose note -> appendReportField -> observation
// -> corruption warning), differing only in field name, enrichment step and
// wording. They are one parameterised path here; the DIFFERENCES between them
// are now the only thing written twice.
//
// Nothing in here may block the reply path: every failure is a warn and a
// continue. In observe mode appendReportField refuses the report WRITE (that
// guard stays -- observe means no automatic field edits) but the ARRIVAL must
// still be visible on the timeline, since observe is exactly the mode with no
// LLM narration to compensate.

import { truncate } from './heuristics.js'
import { observation } from './case-writes.js'
import { transcribeAudio, describePhoto } from './media.js'

// Short description of any non-text content, so a media-only message is never
// summarised as "empty". Also feeds the new-case subject seed and the agent
// prompt, so it is exported rather than kept private here.
export function describeMedia(msg) {
  const r = msg.raw || {}
  if (Array.isArray(r.attachments) && r.attachments.length) return `${r.attachments.length} attachment(s)`
  if (r.type && r.type !== 'text') return `${/^[aeiou]/i.test(r.type) ? 'an' : 'a'} ${r.type} message`
  if (r.image) return 'an image'
  if (r.audio) return 'an audio message'
  if (r.sticker_items) return 'a sticker'
  return ''
}

// Returns a short note when THIS message carries a real image (not a sticker,
// not audio, not a generic attachment of unknown type), else ''.
// WhatsApp/Twilio surface images as raw.image, type 'image', or attachments with
// an image/* content type; all three are matched.
function inboundImageNote(msg) {
  const r = msg.raw || {}
  if (r.image || r.type === 'image') return 'farmer sent a photo'
  const atts = Array.isArray(r.attachments) ? r.attachments : []
  const imgs = atts.filter(a => typeof (a?.content_type || a?.contentType || a?.mimetype) === 'string'
    && /^image\//i.test(a.content_type || a.contentType || a.mimetype))
  if (imgs.length) return imgs.length === 1 ? 'farmer sent a photo' : `farmer sent ${imgs.length} photos`
  return ''
}

// Returns '' when THIS message carries no audio. A transcript, when one is
// available, is folded straight into the recorded note; without one the operator
// listens and fills the richer detail -- an honest degradation rung, not a
// silent drop.
function inboundAudioNote(msg, transcript = '') {
  const r = msg.raw || {}
  const tail = transcript ? ` -- transcript: "${truncate(transcript, 500)}"` : ''
  const base = 'farmer sent a voice note (listen and record what it says)' + tail
  if (r.audio || r.voice || r.type === 'audio' || r.type === 'voice') return base
  const atts = Array.isArray(r.attachments) ? r.attachments : []
  const auds = atts.filter(a => typeof (a?.content_type || a?.contentType || a?.mimetype) === 'string'
    && /^audio\//i.test(a.content_type || a.contentType || a.mimetype))
  if (auds.length) return base
  return ''
}

// Normalise msg.media across adapter shapes. WhatsApp's adapter resolves a
// SINGLE object ({type, mimeType, buffer}); Discord's resolves an ARRAY, one
// entry per attachment. Every read here used to assume the WhatsApp shape, so on
// Discord msg.media.buffer was permanently undefined (arrays have no .buffer)
// and every Discord photo/voice note was stuck at the honest-degradation floor
// with real downloaded bytes sitting right there. Picking the first entry that
// actually HAS a buffer (a failed-download entry may be null/error-only) mirrors
// WhatsApp's own single-object degrade shape; Array.isArray is false for the
// WhatsApp object, so this is a no-op there.
export function pickMediaItem(msg) {
  return Array.isArray(msg.media) ? (msg.media.find(m => m?.buffer) || msg.media[0]) : msg.media
}

// One arrival: save the bytes if the adapter actually downloaded any, append the
// note to its report field, and make the arrival visible on the timeline.
async function recordArrival({ store, log, caseId, field, note, kind, mediaItem, eventPrefix, failLabel }) {
  try {
    let text = note
    if (mediaItem) {
      const savedPath = store.saveMedia(caseId, mediaItem.buffer, { mimeType: mediaItem.mimeType, kind })
      text = `${note} (saved: ${savedPath})`
      if (kind === 'photo') {
        const description = await describePhoto(mediaItem.buffer, mediaItem.mimeType)
        if (description) text += ` -- described: "${truncate(description, 500)}"`
      }
    }
    const r = await store.appendReportField(caseId, field, text)
    if (r?.appended || r?.error === 'observe') {
      await store.appendEvent(caseId, observation(`${eventPrefix}: ${text}${kind === 'photo' ? ' (recorded for the field team).' : '.'}`))
    }
    if (r?.reportWasCorrupted) {
      await store.appendEvent(caseId, observation(`WARNING: this case's stored report JSON was corrupted and has been reset before appending this ${kind} note -- some previously recorded fields may be lost.`))
    }
  } catch (e) { log.warn?.(`[casey] ${failLabel} failed`, { caseId, error: e.message }) }
}

// Record every media artifact this message carried. Photo first, then audio,
// preserving the original ordering (transcription runs BEFORE the audio note is
// composed so a successful transcript is folded into the recorded field).
export async function recordInboundMedia({ store, log, caseId, msg }) {
  const mediaItem = pickMediaItem(msg)

  const photoNote = inboundImageNote(msg)
  if (photoNote) {
    const isPhotoMsg = mediaItem?.buffer && mediaItem.type !== 'audio'
    await recordArrival({
      store, log, caseId, field: 'photos', note: photoNote, kind: 'photo',
      mediaItem: isPhotoMsg ? mediaItem : null,
      eventPrefix: 'PHOTO RECEIVED', failLabel: 'photo mark',
    })
  }

  const isAudioMsg = mediaItem?.buffer && mediaItem.type === 'audio'
  const transcript = isAudioMsg ? await transcribeAudio(mediaItem.buffer, mediaItem.mimeType) : ''
  const audioNote = inboundAudioNote(msg, transcript)
  if (audioNote) {
    await recordArrival({
      store, log, caseId, field: 'audio', note: audioNote, kind: 'audio',
      mediaItem: isAudioMsg ? mediaItem : null,
      eventPrefix: 'AUDIO RECEIVED', failLabel: 'audio mark',
    })
  }
}
