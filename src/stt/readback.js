import { STT_FAILURE } from './errors.js'
import { languageOf } from './languages.js'

export function unheardKind(tr, minConfidence) {
  if (!tr?.text) return tr?.failureKind || STT_FAILURE.UNAVAILABLE
  if (tr.languageSupported === false) return STT_FAILURE.UNSUPPORTED_LANGUAGE
  if (typeof tr.confidence === 'number' && tr.confidence < minConfidence) return STT_FAILURE.LOW_CONFIDENCE
  return ''
}

const heardLine = (tr) => {
  const lang = languageOf(tr.language)
  const parts = []
  if (tr.engine) parts.push(`engine ${tr.provider || tr.engine}`)
  parts.push(`heard language ${lang ? lang.label : (tr.language || 'unknown')}`)
  if (tr.languages?.length > 1) parts.push(`several languages detected (${tr.languages.join(', ')}): the person may be mixing languages`)
  parts.push(typeof tr.confidence === 'number' ? `confidence ${tr.confidence.toFixed(2)}` : 'no confidence score from this engine')
  if (tr.durationSec) parts.push(`${Math.round(tr.durationSec)}s of audio`)
  return parts.join(', ')
}

const UNHEARD = 'do NOT act on it: record nothing from it (no case_report, no case_new, no case_update, no case_consent or case_clarify answer, no case_transition) and never guess a meaning. Tell them kindly, in their language, that you could not make out the voice note, that it is saved, and ask them to say it again in a short voice note or type it.'

const TYPED_ONLY_CONTROLS = 'Opting out and opting back in are done only by typing the single word STOP or HELP: if they say stop or help in a voice note, never treat it as that request, never call case_stop for it, and tell them to type the word.'

export function voiceNote(tr, { staff = false } = {}) {
  const header = `this message is an automatic transcript of a voice note, made by a machine (${heardLine(tr)}). It is HEARD text, never verified fact, and it can be wrong, cut off or nonsense. The voice note itself is saved with the report as the evidence.`
  const who = staff
    ? 'This is a team member dictating. Record routine notes as heard, but before you call case_transition or record an identified disease, a recommended resolution, an animal count or a record reference from it, say back in one or two short sentences exactly what you understood and wait for their yes or correction.'
    : 'Before you record ANY species, count (affected or dead), location or diagnosis taken from it, say back in their own language, in one or two short sentences, exactly what you understood (species, how many sick, how many dead, where) and ask them to answer yes or correct you. Numbers are what machines hear wrongly most often, so say each number plainly. Record those facts only after their next message confirms them (their yes, or their corrected figures); until then call no case_report, case_update or case_transition with them, and do not tell them anything was recorded. Anything in the note that is not one of those facts may be recorded as heard.'
  return `\n\n[System note: ${header} If it is garbled, nonsensical, contradicts itself or you are unsure what they meant, ${UNHEARD} If it mixes languages, answer in the language they used most. ${who} Put the read-back inside your one reply to this message; never send it as a separate message. ${TYPED_ONLY_CONTROLS}]`
}

const FAILURE_WORDS = {
  [STT_FAILURE.TIMEOUT]: 'the voice service was too slow to answer',
  [STT_FAILURE.QUOTA]: 'the voice service is busy right now',
  [STT_FAILURE.UNAVAILABLE]: 'the voice service did not answer',
  [STT_FAILURE.AUTH]: 'the voice service is not available to this assistant right now',
  [STT_FAILURE.TOO_LONG]: 'the voice note is longer than the assistant can listen to',
  [STT_FAILURE.BAD_AUDIO]: 'the audio could not be read',
  [STT_FAILURE.FFMPEG_MISSING]: 'a long voice note could not be prepared for listening',
  [STT_FAILURE.NO_SPEECH]: 'no speech could be made out in it',
  [STT_FAILURE.DISABLED]: 'voice notes are not being turned into text',
  [STT_FAILURE.NO_AUDIO]: 'the audio did not download',
  [STT_FAILURE.LOW_CONFIDENCE]: 'the machine is not confident it heard it correctly',
  [STT_FAILURE.UNSUPPORTED_LANGUAGE]: 'the machine heard a language it cannot follow reliably',
}

export function voiceFailureNote(kind) {
  const why = FAILURE_WORDS[kind] || 'it could not be turned into text'
  return `\n\n[System note: the voice note was saved but NOT understood: ${why}. Tell them truthfully, in two short sentences and in their language, that the voice note is saved but you could not listen to it yourself, and ask them to type the important facts or send a shorter voice note. Do not guess what it said and record nothing from it. Say this inside your one reply to this message. ${TYPED_ONLY_CONTROLS}${kind === STT_FAILURE.TOO_LONG ? ' Suggest a voice note of about a minute or two.' : ''}]`
}
