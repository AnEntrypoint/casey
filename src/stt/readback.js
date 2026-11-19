import { STT_FAILURE } from './errors.js'
import { languageOf } from './languages.js'
import { caseyText } from '../deployment-text.js';

export const MIN_HEARD_NON_SPACE_CHARS = 8

export function unheardKind(tr, minConfidence) {
  if (!tr?.text) return tr?.failureKind || STT_FAILURE.UNAVAILABLE
  if (tr.languageSupported === false || (tr.language && !languageOf(tr.language))) return STT_FAILURE.UNSUPPORTED_LANGUAGE
  if (typeof tr.confidence === 'number' && tr.confidence < minConfidence) return STT_FAILURE.LOW_CONFIDENCE
  if (tr.text.replace(/\s/g, '').length < MIN_HEARD_NON_SPACE_CHARS) return STT_FAILURE.LOW_CONFIDENCE
  return ''
}

const heardLine = (tr) => {
  const lang = languageOf(tr.language)
  const parts = []
  if (tr.engine) parts.push(`engine ${tr.provider || tr.engine}`)
  parts.push(caseyText("src/stt/readback.js#s0", [lang ? lang.label : (tr.language || 'unknown')]))
  if (tr.languages?.length > 1) parts.push(caseyText("src/stt/readback.js#0", [tr.languages.join(', ')]))
  parts.push(typeof tr.confidence === 'number' ? `confidence ${tr.confidence.toFixed(2)}` : caseyText("src/stt/readback.js#s1"))
  if (tr.durationSec) parts.push(caseyText("src/stt/readback.js#s2", [Math.round(tr.durationSec)]))
  return parts.join(', ')
}

const UNHEARD = caseyText("src/stt/readback.js#1")

const TYPED_ONLY_CONTROLS = caseyText("src/stt/readback.js#2")

export function voiceNote(tr, { staff = false } = {}) {
  const header = caseyText("src/stt/readback.js#3", [heardLine(tr)])
  const who = staff
    ? caseyText("src/stt/readback.js#4")
    : caseyText("src/stt/readback.js#5")
  return caseyText("src/stt/readback.js#6", [header, UNHEARD, who, TYPED_ONLY_CONTROLS])
}

const FAILURE_WORDS = {
  [STT_FAILURE.TIMEOUT]: caseyText("src/stt/readback.js#7"),
  [STT_FAILURE.QUOTA]: caseyText("src/stt/readback.js#s3"),
  [STT_FAILURE.UNAVAILABLE]: caseyText("src/stt/readback.js#s4"),
  [STT_FAILURE.AUTH]: caseyText("src/stt/readback.js#8"),
  [STT_FAILURE.TOO_LONG]: caseyText("src/stt/readback.js#9"),
  [STT_FAILURE.BAD_AUDIO]: caseyText("src/stt/readback.js#s5"),
  [STT_FAILURE.FFMPEG_MISSING]: caseyText("src/stt/readback.js#10"),
  [STT_FAILURE.NO_SPEECH]: caseyText("src/stt/readback.js#s6"),
  [STT_FAILURE.DISABLED]: caseyText("src/stt/readback.js#11"),
  [STT_FAILURE.NO_AUDIO]: caseyText("src/stt/readback.js#s7"),
  [STT_FAILURE.LOW_CONFIDENCE]: caseyText("src/stt/readback.js#12"),
  [STT_FAILURE.UNSUPPORTED_LANGUAGE]: caseyText("src/stt/readback.js#13"),
}

export function voiceFailureNote(kind) {
  const why = FAILURE_WORDS[kind] || caseyText("src/stt/readback.js#s8")
  return caseyText("src/stt/readback.js#14", [why, TYPED_ONLY_CONTROLS, kind === STT_FAILURE.TOO_LONG ? caseyText("src/stt/readback.js#15") : ''])
}
