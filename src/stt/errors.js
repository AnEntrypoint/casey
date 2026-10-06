export const STT_FAILURE = Object.freeze({
  DISABLED: 'disabled',
  NO_AUDIO: 'no_audio',
  AUTH: 'auth',
  QUOTA: 'quota',
  UNAVAILABLE: 'unavailable',
  TIMEOUT: 'timeout',
  BAD_AUDIO: 'bad_audio',
  TOO_LONG: 'too_long',
  FFMPEG_MISSING: 'ffmpeg_missing',
  NO_SPEECH: 'no_speech',
  LOW_CONFIDENCE: 'low_confidence',
  UNSUPPORTED_LANGUAGE: 'unsupported_language',
})

export class SttError extends Error {
  constructor(kind, message) {
    super(message)
    this.name = 'SttError'
    this.kind = kind
  }
}

export function failureKindOf(e) {
  return e instanceof SttError ? e.kind : STT_FAILURE.UNAVAILABLE
}
