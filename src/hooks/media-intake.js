

import { truncate } from './heuristics.js'
import { observation, raiseOperatorItem } from './case-writes.js'
import { transcribeAudioDetailed, describePhoto } from './media.js'
import { loadDomainConfig } from '../config-loader.js'
import { withoutIssuedCodes } from '../role-invites.js'
import { languageOf } from '../stt/languages.js'
import { unheardKind } from '../stt/readback.js'
import { failureKindOf } from '../stt/errors.js'
import { caseyText } from '../deployment-text.js';

const FIELD_TRANSCRIPT_CHARS = 1500

export function describeMedia(msg) {
  const r = msg.raw || {}
  if (Array.isArray(r.attachments) && r.attachments.length) return `${r.attachments.length} attachment(s)`

  if (msg.location) return caseyText("src/hooks/media-intake.js#s0")
  if (r.type === 'interactive') return ''
  if (r.type && r.type !== 'text') return `${/^[aeiou]/i.test(r.type) ? 'an' : 'a'} ${r.type} message`
  if (r.image) return caseyText("src/hooks/media-intake.js#s1")
  if (r.audio) return caseyText("src/hooks/media-intake.js#s2")
  if (r.sticker_items) return 'a sticker'
  return ''
}

function inboundImageNote(msg) {
  const r = msg.raw || {}
  if (r.image || r.type === 'image') return caseyText("src/hooks/media-intake.js#s3")
  const atts = Array.isArray(r.attachments) ? r.attachments : []
  const imgs = atts.filter(a => typeof (a?.content_type || a?.contentType || a?.mimetype) === 'string'
    && /^image\//i.test(a.content_type || a.contentType || a.mimetype))
  if (imgs.length) return imgs.length === 1 ? caseyText("src/hooks/media-intake.js#s4") : caseyText("src/hooks/media-intake.js#s5", [imgs.length])
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
  const shown = text.length > FIELD_TRANSCRIPT_CHARS ? caseyText("src/hooks/media-intake.js#0", [text.slice(0, FIELD_TRANSCRIPT_CHARS), text.length - FIELD_TRANSCRIPT_CHARS]) : text
  return caseyText("src/hooks/media-intake.js#1", [heardSummary(tr), shown])
}

function unheardTail(tr) {
  const guess = tr.text ? caseyText("src/hooks/media-intake.js#s6", [truncate(tr.text, 300)]) : ''
  return caseyText("src/hooks/media-intake.js#2", [tr.unheard, tr.error ? `: ${truncate(tr.error, 120)}` : '', guess])
}

function inboundAudioNote(msg, tr = { text: '', error: '' }) {
  const r = msg.raw || {}

  const tail = tr.unheard ? unheardTail(tr)
    : tr.text ? transcriptTail(tr)
      : tr.error ? caseyText("src/hooks/media-intake.js#s7", [truncate(tr.error, 120)]) : ''
  const base = caseyText("src/hooks/media-intake.js#3") + tail
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
  return caseyText("src/hooks/media-intake.js#s8", [relay.by, note.replace(/^farmer sent/, 'team member sent')])
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

export function inboundAudioData(msg, typedText) {
  const tr = msg._transcript
  if (!tr) return {}
  const base = { typed_chars: typedText.length }
  if (tr.unheard) return { ...base, stt_verdict: tr.text ? 'unheard' : 'failed', stt_failure: tr.unheard }
  return { ...base, stt_verdict: 'heard', transcribed: true, transcribed_by: 'ai_helper', stt: sttProvenance(tr) }
}

export async function transcribeInboundAudio({ store, log, caseId, msg }) {
  if (msg._transcript) return msg._transcript
  const audioItem = pickMediaItem(msg, 'audio')
  if (!audioItem) return { text: '', error: '' }
  let tr
  try {
    const redact = (text) => withoutIssuedCodes(store, text).then(clean => (clean != null ? clean : text))
    tr = await transcribeAudioDetailed(audioItem.buffer, audioItem.mimeType, { redact })
    if (tr.text) {
      try { const clean = await withoutIssuedCodes(store, tr.text); if (clean != null) tr.text = clean }
      catch (e) { log.error?.('[casey] transcript code redaction failed', { caseId, error: e.message }); tr.text = ''; tr.error = tr.error || caseyText("src/hooks/media-intake.js#s9") }
    }
  } catch (e) {
    log.error?.('[casey] voice.transcribe_threw', { code: 'voice.transcribe_threw', caseId, failureKind: failureKindOf(e) })
    tr = { text: '', error: String(e.message || e), failureKind: failureKindOf(e) }
  }
  tr.unheard = unheardKind(tr)
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

        if (description) text += caseyText("src/hooks/media-intake.js#4", [truncate(description, 500)])
      }
    }
    const r = await store.appendReportField(caseId, field, text)
    if (r?.appended || r?.error === 'observe') {
      await store.appendEvent(caseId, observation(`${eventPrefix}: ${text}${kind === 'photo' ? caseyText("src/hooks/media-intake.js#s10") : '.'}`,
        relay ? { on_behalf: true, relayed_by: relay.by, staff_contact_id: relay.contactId } : undefined))
    }
    if (r?.reportWasCorrupted) {
      await store.appendEvent(caseId, observation(caseyText("src/hooks/media-intake.js#5", [kind])))
      await raiseOperatorItem({ store, log, caseId, code: 'report.corrupted', level: 'error', fields: { kind } })
    }
  } catch {
    await raiseOperatorItem({ store, log, caseId, code: 'media.record_failed', level: 'error', fields: { kind } })
  }
}

const AREA_ASK_NOTE = (question) => caseyText("src/hooks/media-intake.js#6", [question])
export async function recordInboundLocation({ store, log, caseId, msg }) {
  if (!msg.location) return ''
  try { await store.appendEvent(caseId, observation(caseyText("src/hooks/media-intake.js#7"))) }
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
      eventPrefix: caseyText("src/hooks/media-intake.js#s11"), relay,
    })
  }

  const tr = audioItem ? await transcribeInboundAudio({ store, log, caseId, msg }) : { text: '', error: '' }
  if (audioItem) {

    if (tr.unheard) await raiseOperatorItem({ store, log, caseId, code: `voice.${tr.unheard}`, fields: { transcribed: !!tr.text } })
    log.info?.('[casey] voice note received', { caseId, mime: audioItem.mimeType, bytes: audioItem.buffer?.length || 0, provider: tr.provider, transcribed: !!tr.text && !tr.unheard, transcriptChars: tr.text.length, language: tr.language || undefined, confidence: tr.confidence ?? undefined, durationSec: tr.durationSec ?? undefined, ms: tr.ms, ...sttStageMs(tr), failureKind: tr.unheard || tr.failureKind || undefined, error: tr.error || undefined })
  }
  const audioNote = inboundAudioNote(msg, tr)
  if (audioNote) {
    await recordArrival({
      store, log, caseId, field: 'audio', note: audioNote, kind: 'audio',
      mediaItem: audioItem,
      eventPrefix: caseyText("src/hooks/media-intake.js#s12"), relay,
    })
  }
}
