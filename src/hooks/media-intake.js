

import { truncate } from './heuristics.js'
import { observation } from './case-writes.js'
import { transcribeAudioDetailed, describePhoto } from './media.js'
import { isValidLatLon } from '../case-tools-shared.js'
import { withoutIssuedCodes } from '../role-invites.js'
import { parseReport } from '../timestamp.js'
import { languageOf } from '../stt/languages.js'

const FIELD_TRANSCRIPT_CHARS = 1500

export function describeMedia(msg) {
  const r = msg.raw || {}
  if (Array.isArray(r.attachments) && r.attachments.length) return `${r.attachments.length} attachment(s)`

  if (msg.location) return 'a location pin'
  if (r.type === 'interactive') return ''
  if (r.type && r.type !== 'text') return `${/^[aeiou]/i.test(r.type) ? 'an' : 'a'} ${r.type} message`
  if (r.image) return 'an image'
  if (r.audio) return 'an audio message'
  if (r.sticker_items) return 'a sticker'
  return ''
}

function inboundImageNote(msg) {
  const r = msg.raw || {}
  if (r.image || r.type === 'image') return 'farmer sent a photo'
  const atts = Array.isArray(r.attachments) ? r.attachments : []
  const imgs = atts.filter(a => typeof (a?.content_type || a?.contentType || a?.mimetype) === 'string'
    && /^image\//i.test(a.content_type || a.contentType || a.mimetype))
  if (imgs.length) return imgs.length === 1 ? 'farmer sent a photo' : `farmer sent ${imgs.length} photos`
  return ''
}

function heardSummary(tr) {
  const lang = languageOf(tr.language)
  const parts = [tr.provider || tr.engine || 'machine']
  if (lang || tr.language) parts.push(lang ? lang.label : tr.language)
  if (typeof tr.confidence === 'number') parts.push(`confidence ${tr.confidence.toFixed(2)}`)
  if (tr.durationSec) parts.push(`${Math.round(tr.durationSec)}s`)
  return parts.join(', ')
}

function transcriptTail(tr) {
  const text = tr.text
  const shown = text.length > FIELD_TRANSCRIPT_CHARS ? `${text.slice(0, FIELD_TRANSCRIPT_CHARS)} [... ${text.length - FIELD_TRANSCRIPT_CHARS} more characters: the full transcript is in the message on the timeline]` : text
  return ` -- auto-transcript by the AI helper, HEARD not verified (${heardSummary(tr)}; may be wrong, listen to check): "${shown}"`
}

function inboundAudioNote(msg, tr = { text: '', error: '' }) {
  const r = msg.raw || {}

  const tail = tr.text ? transcriptTail(tr)
    : tr.error ? ` -- no auto-transcript could be made (${truncate(tr.error, 120)})` : ''
  const base = 'farmer sent a voice note (listen and record what it says)' + tail
  if (r.audio || r.voice || r.type === 'audio' || r.type === 'voice') return base
  const atts = Array.isArray(r.attachments) ? r.attachments : []
  const auds = atts.filter(a => typeof (a?.content_type || a?.contentType || a?.mimetype) === 'string'
    && /^audio\//i.test(a.content_type || a.contentType || a.mimetype))
  if (auds.length) return base
  return ''
}

export function carriesArtifact(msg) {
  return !!(msg?.location || inboundImageNote(msg) || inboundAudioNote(msg))
}

function relayedNote(note, relay) {
  if (!relay) return note
  return `[relayed by ${relay.by} on the reporter's behalf] ${note.replace(/^farmer sent/, 'team member sent')}`
}

function pickMediaItem(msg, kind) {
  const list = Array.isArray(msg.media) ? msg.media : (msg.media ? [msg.media] : [])
  const wantAudio = kind === 'audio'
  return list.find(m => m?.buffer && (m.type === 'audio') === wantAudio) || null
}

export function sttProvenance(tr) {
  if (!tr?.text) return null
  return {
    engine: tr.engine || tr.provider, model: tr.model || null, language: tr.language || null, languages: tr.languages || undefined,
    confidence: typeof tr.confidence === 'number' ? Number(tr.confidence.toFixed(3)) : null,
    duration_s: tr.durationSec != null ? Math.round(tr.durationSec * 10) / 10 : null, chunks: tr.chunks || 1,
  }
}

async function languageHint(store, log, caseId) {
  try { return parseReport(await store.getCase(caseId)).language_detected || null }
  catch (e) { log.warn?.('[casey] language hint unavailable for transcription', { caseId, error: e.message }); return null }
}

export async function transcribeInboundAudio({ store, log, caseId, msg }) {
  if (msg._transcript) return msg._transcript
  const audioItem = pickMediaItem(msg, 'audio')
  if (!audioItem) return { text: '', error: '' }
  const tr = await transcribeAudioDetailed(audioItem.buffer, audioItem.mimeType, { hintLanguage: await languageHint(store, log, caseId) })
  if (tr.text) {
    try { const clean = await withoutIssuedCodes(store, tr.text); if (clean != null) tr.text = clean }
    catch (e) { log.error?.('[casey] transcript code redaction failed', { caseId, error: e.message }); tr.text = ''; tr.error = tr.error || 'transcript withheld' }
  }
  Object.defineProperty(msg, '_transcript', { value: tr, enumerable: false, configurable: true })
  return tr
}

async function recordArrival({ store, log, caseId, field, note, kind, mediaItem, eventPrefix, failLabel, relay = null }) {
  try {
    let text = relayedNote(note, relay)
    if (mediaItem) {
      const savedPath = store.saveMedia(caseId, mediaItem.buffer, { mimeType: mediaItem.mimeType, kind })
      text = `${text} (saved: ${savedPath})`
      if (kind === 'photo') {
        const description = await describePhoto(mediaItem.buffer, mediaItem.mimeType)

        if (description) text += ` -- auto-description by the AI helper (not the farmer's words): "${truncate(description, 500)}"`
      }
    }
    const r = await store.appendReportField(caseId, field, text)
    if (r?.appended || r?.error === 'observe') {
      await store.appendEvent(caseId, observation(`${eventPrefix}: ${text}${kind === 'photo' ? ' (recorded for the field team).' : '.'}`,
        relay ? { on_behalf: true, relayed_by: relay.by, staff_contact_id: relay.contactId } : undefined))
    }
    if (r?.reportWasCorrupted) {
      await store.appendEvent(caseId, observation(`WARNING: this case's stored report JSON was corrupted and has been reset before appending this ${kind} note -- some previously recorded fields may be lost.`))
    }
  } catch (e) { log.warn?.(`[casey] ${failLabel} failed`, { caseId, error: e.message }) }
}

const PIN_STORED = '\n\n[System note: the location pin they shared was saved on the map as their exact position. Do not ask for coordinates, GPS numbers or another pin, and do not write that coordinates were unreadable; ask about the place only if a name or landmark is still missing.]'
const PIN_NOT_STORED = (why) => `\n\n[System note: the location pin they shared ${why}, so NO position was stored. Do not say you have their location; tell them plainly it did not come through and ask where the animals are (a town or farm name, or send the pin again).]`
export async function recordInboundLocation({ store, log, caseId, msg }) {
  const pin = msg.location
  if (!pin) return ''

  if (!isValidLatLon(pin.lat, pin.lon)) {
    log.warn?.('[casey] location pin out of range; not recorded', { caseId, lat: pin.lat, lon: pin.lon })
    try { await store.appendEvent(caseId, observation(`LOCATION PIN REJECTED: the shared position was out of range (lat=${pin.lat}, lon=${pin.lon}) and was not recorded. Ask where they are.`)) }
    catch (e) { log.warn?.('[casey] location pin rejection note failed', { caseId, error: e.message }) }
    return PIN_NOT_STORED('was not a real position (it was out of range)')
  }
  const place = [pin.name, pin.address].filter(Boolean).join(', ')
  try {
    const res = await store.updateCaseChecked(caseId, { lat: pin.lat, lon: pin.lon, location_source: 'gps', location_confidence: 100 })
    if (res?.error && res.error !== 'observe') {
      log.warn?.('[casey] location pin write failed', { caseId, error: res.error })
      return PIN_NOT_STORED('could not be saved just now')
    }
    const recorded = res?.error === 'observe'
      ? 'not recorded on the map (a person is handling this themselves)'
      : 'recorded on the map as an exact GPS position'
    await store.appendEvent(caseId, observation(
      `LOCATION PIN RECEIVED: lat ${pin.lat}, lon ${pin.lon}${place ? ` -- WhatsApp labels this spot "${truncate(place, 200)}" (its own label, not the person's words)` : ''}. Read off the person's own device and ${recorded}.`,
    ))

    return res?.error === 'observe' ? '' : PIN_STORED
  } catch (e) { log.warn?.('[casey] location pin mark failed', { caseId, error: e.message }); return PIN_NOT_STORED('could not be saved just now') }
}

export async function recordInboundMedia({ store, log, caseId, msg, relay = null }) {
  const photoItem = pickMediaItem(msg, 'photo')
  const audioItem = pickMediaItem(msg, 'audio')

  const photoNote = inboundImageNote(msg)
  if (photoNote) {
    await recordArrival({
      store, log, caseId, field: 'photos', note: photoNote, kind: 'photo',
      mediaItem: photoItem,
      eventPrefix: 'PHOTO RECEIVED', failLabel: 'photo mark', relay,
    })
  }

  const tr = audioItem ? await transcribeInboundAudio({ store, log, caseId, msg }) : { text: '', error: '' }
  if (audioItem) {

    log.info?.('[casey] voice note received', { caseId, mime: audioItem.mimeType, bytes: audioItem.buffer?.length || 0, provider: tr.provider, transcribed: !!tr.text, transcriptChars: tr.text.length, language: tr.language || undefined, confidence: tr.confidence ?? undefined, durationSec: tr.durationSec ?? undefined, ms: tr.ms, failureKind: tr.failureKind || undefined, error: tr.error || undefined })
  }
  const audioNote = inboundAudioNote(msg, tr)
  if (audioNote) {
    await recordArrival({
      store, log, caseId, field: 'audio', note: audioNote, kind: 'audio',
      mediaItem: audioItem,
      eventPrefix: 'AUDIO RECEIVED', failLabel: 'audio mark', relay,
    })
  }
}
