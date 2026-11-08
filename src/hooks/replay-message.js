import { evData } from '../safe.js'
import { splitExternalId } from './handler.js'

function replayedTranscript(ev, typedChars) {
  const d = evData(ev)
  if (!d.stt_verdict) return null
  if (d.stt_verdict === 'heard') {
    const stt = d.stt || {}
    return {
      text: String(ev.text || '').slice(typedChars).trim(), engine: stt.engine, model: stt.model, language: stt.language,
      languages: stt.languages, confidence: stt.confidence ?? undefined, durationSec: stt.duration_s ?? undefined, unheard: '',
    }
  }
  return { text: '', error: '', failureKind: d.stt_failure, unheard: d.stt_failure }
}

export function replayMessage(c, ev, flags) {
  const { container, author } = splitExternalId(c.external_id)
  const d = evData(ev)
  const typedChars = Number.isInteger(d.typed_chars) ? d.typed_chars : null
  const msg = {
    from: author,
    text: typedChars === null ? (ev.text || '') : String(ev.text || '').slice(0, typedChars),
    platform: c.channel,
    ...flags,
    raw: { channel_id: container, id: ev.msg_id, author: {} },
  }
  const tr = typedChars === null ? null : replayedTranscript(ev, typedChars)
  if (tr) Object.defineProperty(msg, '_transcript', { value: tr, enumerable: false, configurable: true })
  return msg
}
