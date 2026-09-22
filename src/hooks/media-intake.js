// hooks/media-intake.js -- one-shot capture of whatever a message carried
// BESIDES text, recorded as explicit case state at ingress.
//
// A photo of a sick or dead animal, and a voice note from a worker who speaks
// rather than types, are the two most valuable on-site artifacts and neither can
// be recovered once the worker leaves. So neither is left to the agent turn to
// notice and record -- on a media-only message it may not narrate them at all.
// This runs deterministically, before any LLM is involved, and MUST stay
// append-only: a worker routinely sends more than one photo across a
// conversation, and a fill-if-empty write silently discards every arrival after
// the first.
//
// Photo and audio share one parameterised path (save bytes -> compose note ->
// appendReportField -> observation -> corruption warning); the DIFFERENCES
// between them -- field name, enrichment step, wording -- are the only thing
// written twice.
//
// Nothing in here may block the reply path: every failure is a warn and a
// continue. In observe mode appendReportField refuses the report WRITE (that
// guard stays -- observe means no automatic field edits) but the ARRIVAL must
// still be visible on the timeline, since observe is exactly the mode with no
// LLM narration to compensate.

import { truncate } from './heuristics.js'
import { observation } from './case-writes.js'
import { transcribeAudio, describePhoto } from './media.js'
import { isValidLatLon } from '../case-tools-shared.js'

// Short description of any non-text content, so a media-only message is never
// summarised as "empty". Also feeds the new-case subject seed and the agent
// prompt, so it is exported rather than kept private here.
export function describeMedia(msg) {
  const r = msg.raw || {}
  if (Array.isArray(r.attachments) && r.attachments.length) return `${r.attachments.length} attachment(s)`
  // Named before the generic `r.type` branch below, which would say "a location
  // message" -- a pin is not a message with a location in it, it is a position,
  // and this string is what the agent prompt says the person sent when they sent
  // nothing else. The coordinates themselves are not repeated here: they are
  // already on the timeline as their own observation (recordInboundLocation),
  // which is where a value an operator may act on belongs.
  if (msg.location) return 'a location pin'
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
  // Attributed to the machine, explicitly. A bare 'transcript:' reads as a
  // record of what was said; this is the AI helper's transcription of audio it
  // may have got wrong, and an operator acting on a disease report needs to know
  // which of those they are reading. Same reason the photo note below names its
  // author: the machine must not present its own output as what someone entered.
  const tail = transcript ? ` -- auto-transcript by the AI helper (may be wrong, listen to check): "${truncate(transcript, 500)}"` : ''
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
// entry per attachment. Read msg.media through here, never directly: a bare
// msg.media.buffer is permanently undefined on Discord (arrays have no
// .buffer), which strands every Discord photo/voice note at the
// honest-degradation floor with real downloaded bytes sitting right there.
// Picking the first entry that actually HAS a buffer (a failed-download entry
// may be null/error-only) mirrors WhatsApp's own single-object degrade shape;
// Array.isArray is false for the WhatsApp object, so this is a no-op there.
//
// Module-private: recordInboundMedia below is its only caller anywhere in the
// tree. It was exported alongside describeMedia when this file was lifted out
// of makeCaseHandler, but describeMedia has real outside consumers (the
// new-case subject seed and the agent prompt) and this does not -- an export
// with no importer advertises a seam that isn't one, and invites a second
// reader of msg.media instead of a second caller of this.
// The downloaded bytes for ONE kind. Selecting a single item for both kinds
// loses the other's bytes: one message can carry a photo AND a voice note, they
// record into different report fields, and picking the first entry with a buffer
// meant that when the audio came first the photo recorded with no file saved and
// no auto-description -- silently, since the note still appended. A field photo
// of a dying animal is not recapturable, so the loss is permanent.
// An item with no `type` counts as a photo, as it always has.
function pickMediaItem(msg, kind) {
  const list = Array.isArray(msg.media) ? msg.media : (msg.media ? [msg.media] : [])
  const wantAudio = kind === 'audio'
  return list.find(m => m?.buffer && (m.type === 'audio') === wantAudio) || null
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
        // 'described:' alone reads as the farmer's own description of their photo.
        // It is the AI helper's, and on a report a vet may act on that difference
        // matters. Named rather than implied.
        if (description) text += ` -- auto-description by the AI helper (not the farmer's words): "${truncate(description, 500)}"`
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

// A SHARED LOCATION PIN, recorded deterministically at ingress for exactly the
// reason a photo is: it is a real reading off the person's own device, taken
// where they are standing right now, and it is not recapturable once they walk
// away. Left to the agent turn it would be lost twice over -- the model never
// sees the webhook payload, so it would either say nothing about the place or
// fill lat/lon with its OWN estimate from a name, which is the one thing the
// map's provenance ladder exists to keep apart from a real fix.
//
// location_source is 'gps', not 'estimated': the ladder's own meaning is HOW the
// position was arrived at (thatcher.config.yml, map-overlays.js), and this one
// came from a phone's GPS. 'confirmed' would be wrong too -- that rung means a
// person agreed with a coordinate somebody else proposed, and nobody proposed
// this one. 'estimated' is reserved for the model's own guess.
//
// Writes the case's own lat/lon COLUMNS, never a report field: the report blob is
// the person's own words and casey does no field extraction into it (AGENTS.md,
// "The LLM records the report"). The place NAME/ADDRESS Meta attaches to a pin is
// its own reverse-geocode label, not what the person said, so it goes on the
// timeline where its author is visible -- and the model reads that timeline, so
// it can acknowledge the spot and ask about the animals there.
//
// Same failure discipline as every other write in this file: best-effort, never
// blocking the reply. In observe mode the COLUMN write is correctly refused (no
// automatic edits) but the arrival still lands on the timeline, since observe is
// exactly the mode with no agent narration to compensate.
export async function recordInboundLocation({ store, log, caseId, msg }) {
  const pin = msg.location
  if (!pin) return
  // An out-of-range pair is surfaced, not silently treated as "no pin sent":
  // a map point that never appears with no explanation is the failure mode
  // case_report's own range check was added to close.
  if (!isValidLatLon(pin.lat, pin.lon)) {
    log.warn?.('[casey] location pin out of range; not recorded', { caseId, lat: pin.lat, lon: pin.lon })
    try { await store.appendEvent(caseId, observation(`LOCATION PIN REJECTED: the shared position was out of range (lat=${pin.lat}, lon=${pin.lon}) and was not recorded. Ask where they are.`)) }
    catch (e) { log.warn?.('[casey] location pin rejection note failed', { caseId, error: e.message }) }
    return
  }
  const place = [pin.name, pin.address].filter(Boolean).join(', ')
  try {
    const res = await store.updateCaseChecked(caseId, { lat: pin.lat, lon: pin.lon, location_source: 'gps' })
    if (res?.error && res.error !== 'observe') {
      log.warn?.('[casey] location pin write failed', { caseId, error: res.error })
      return
    }
    const recorded = res?.error === 'observe'
      ? 'not recorded on the map (a person is handling this themselves)'
      : 'recorded on the map as an exact GPS position'
    await store.appendEvent(caseId, observation(
      `LOCATION PIN RECEIVED: lat ${pin.lat}, lon ${pin.lon}${place ? ` -- WhatsApp labels this spot "${truncate(place, 200)}" (its own label, not the person's words)` : ''}. Read off the person's own device and ${recorded}.`,
    ))
  } catch (e) { log.warn?.('[casey] location pin mark failed', { caseId, error: e.message }) }
}

// Record every media artifact this message carried. Photo first, then audio,
// preserving the original ordering (transcription runs BEFORE the audio note is
// composed so a successful transcript is folded into the recorded field).
export async function recordInboundMedia({ store, log, caseId, msg }) {
  const photoItem = pickMediaItem(msg, 'photo')
  const audioItem = pickMediaItem(msg, 'audio')

  const photoNote = inboundImageNote(msg)
  if (photoNote) {
    await recordArrival({
      store, log, caseId, field: 'photos', note: photoNote, kind: 'photo',
      mediaItem: photoItem,
      eventPrefix: 'PHOTO RECEIVED', failLabel: 'photo mark',
    })
  }

  const transcript = audioItem ? await transcribeAudio(audioItem.buffer, audioItem.mimeType) : ''
  const audioNote = inboundAudioNote(msg, transcript)
  if (audioNote) {
    await recordArrival({
      store, log, caseId, field: 'audio', note: audioNote, kind: 'audio',
      mediaItem: audioItem,
      eventPrefix: 'AUDIO RECEIVED', failLabel: 'audio mark',
    })
  }
}
