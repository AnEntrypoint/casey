

import { truncate } from './heuristics.js'
import { observation, raiseOperatorItem } from './case-writes.js'
import { transcribeAudioDetailed, describePhoto } from './media.js'
import { loadDomainConfig } from '../config-loader.js'
import { withoutIssuedCodes } from '../role-invites.js'
import { parseReport } from '../timestamp.js'
import { languageOf } from '../stt/languages.js'
import { unheardKind } from '../stt/readback.js'
import { googleSttConfig } from '../stt/config.js'
import { failureKindOf } from '../stt/errors.js'

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

function unheardTail(tr) {
  const guess = tr.text ? `; the machine's untrusted guess was: "${truncate(tr.text, 300)}"` : ''
  return ` -- NOT understood by the AI helper (${tr.unheard}${tr.error ? `: ${truncate(tr.error, 120)}` : ''}), staff should listen to the saved audio${guess}`
}

function inboundAudioNote(msg, tr = { text: '', error: '' }) {
  const r = msg.raw || {}

  const tail = tr.unheard ? unheardTail(tr)
    : tr.text ? transcriptTail(tr)
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

const PERSISTED_CHOICE_KEYS = ['chosen', 'source', 'confidence', 'llm_model', 'decided_at', 'note']

function persistedCandidates(tr) {
  if (!Array.isArray(tr.candidates)) return {}
  const choice = tr.stt_choice
  return {
    stt_candidates: tr.candidates.map(({ text, ...meta }) => ({ ...meta, has_text: !!text })),
    stt_choice: choice ? Object.fromEntries(PERSISTED_CHOICE_KEYS.filter(k => k in choice).map(k => [k, choice[k]])) : null,
  }
}

export function inboundAudioData(msg, typedText) {
  const tr = msg._transcript
  if (!tr) return {}
  const base = { typed_chars: typedText.length }
  const candidates = persistedCandidates(tr)
  if (tr.unheard) return { ...base, ...candidates, stt_verdict: tr.text ? 'unheard' : 'failed', stt_failure: tr.unheard }
  return { ...base, ...candidates, stt_verdict: 'heard', transcribed: true, transcribed_by: 'ai_helper', stt: sttProvenance(tr) }
}

export async function transcribeInboundAudio({ store, log, caseId, msg, callLLM = null }) {
  if (msg._transcript) return msg._transcript
  const audioItem = pickMediaItem(msg, 'audio')
  if (!audioItem) return { text: '', error: '' }
  let tr
  try {
    const redact = (text) => withoutIssuedCodes(store, text).then(clean => (clean != null ? clean : text))
    tr = await transcribeAudioDetailed(audioItem.buffer, audioItem.mimeType, { hintLanguage: await languageHint(store, log, caseId), callLLM, redact })
    if (tr.text) {
      try { const clean = await withoutIssuedCodes(store, tr.text); if (clean != null) tr.text = clean }
      catch (e) { log.error?.('[casey] transcript code redaction failed', { caseId, error: e.message }); tr.text = ''; tr.error = tr.error || 'transcript withheld' }
    }
  } catch (e) {
    log.error?.('[casey] voice.transcribe_threw', { code: 'voice.transcribe_threw', caseId, failureKind: failureKindOf(e) })
    tr = { text: '', error: String(e.message || e), failureKind: failureKindOf(e) }
  }
  tr.unheard = unheardKind(tr, googleSttConfig().minConfidence)
  Object.defineProperty(msg, '_transcript', { value: tr, enumerable: false, configurable: true })
  return tr
}

async function recordArrival({ store, log, caseId, field, note, kind, mediaItem, eventPrefix, relay = null }) {
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
      await raiseOperatorItem({ store, log, caseId, code: 'report.corrupted', level: 'error', fields: { kind } })
    }
  } catch {
    await raiseOperatorItem({ store, log, caseId, code: 'media.record_failed', level: 'error', fields: { kind } })
  }
}

const AREA_ASK_NOTE = (question) => `\n\n[System note: the location pin they shared was NOT stored. The team keeps only the general town or area of a report, never a map pin, coordinates, GPS numbers or directions, so do not say you have their location and do not ask for a pin, coordinates or directions. In this reply ask ONE question, in their language, in one short natural sentence: "${question}"]`
export async function recordInboundLocation({ store, log, caseId, msg }) {
  if (!msg.location) return ''
  try { await store.appendEvent(caseId, observation('LOCATION PIN NOT STORED: a map pin was shared. Only the general town or area is recorded, so nothing was saved from it.')) }
  catch (e) { log.warn?.('[casey] location pin note failed', { caseId, error: e.message }) }
  return AREA_ASK_NOTE(loadDomainConfig().persona.areaQuestion)
}

export async function recordInboundMedia({ store, log, caseId, msg, relay = null }) {
  const photoItem = pickMediaItem(msg, 'photo')
  const audioItem = pickMediaItem(msg, 'audio')

  const photoNote = inboundImageNote(msg)
  if (photoNote) {
    await recordArrival({
      store, log, caseId, field: 'photos', note: photoNote, kind: 'photo',
      mediaItem: photoItem,
      eventPrefix: 'PHOTO RECEIVED', relay,
    })
  }

  const tr = audioItem ? await transcribeInboundAudio({ store, log, caseId, msg }) : { text: '', error: '' }
  if (audioItem) {

    if (tr.unheard) await raiseOperatorItem({ store, log, caseId, code: `voice.${tr.unheard}`, fields: { transcribed: !!tr.text } })
    log.info?.('[casey] voice note received', { caseId, mime: audioItem.mimeType, bytes: audioItem.buffer?.length || 0, provider: tr.provider, transcribed: !!tr.text && !tr.unheard, transcriptChars: tr.text.length, language: tr.language || undefined, confidence: tr.confidence ?? undefined, durationSec: tr.durationSec ?? undefined, ms: tr.ms, failureKind: tr.unheard || tr.failureKind || undefined, error: tr.error || undefined })
  }
  const audioNote = inboundAudioNote(msg, tr)
  if (audioNote) {
    await recordArrival({
      store, log, caseId, field: 'audio', note: audioNote, kind: 'audio',
      mediaItem: audioItem,
      eventPrefix: 'AUDIO RECEIVED', relay,
    })
  }
}
