const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)

const unit = (v, d) => (String(v ?? '').trim() !== '' && Number(v) >= 0 && Number(v) <= 1 ? Number(v) : d)

export function sttEngine(env = process.env) {
  return String(env.CASEY_STT_ENGINE || '').trim().toLowerCase()
}

export function googleSttEnabled(env = process.env) {
  return sttEngine(env) === 'google'
}

export function googleSttConfig(env = process.env) {
  const model = env.CASEY_STT_GOOGLE_MODEL || 'chirp_3'
  return {
    model,
    location: env.CASEY_STT_GOOGLE_LOCATION || 'us',
    languageCodes: String(env.CASEY_STT_LANGUAGE_CODES || 'auto').split(',').map(s => s.trim()).filter(Boolean),
    chunkSeconds: num(env.CASEY_STT_CHUNK_SECONDS, 50),
    maxSeconds: num(env.CASEY_STT_MAX_SECONDS, 600),
    budgetMs: num(env.CASEY_STT_BUDGET_MS, 60000),
    requestTimeoutMs: num(env.CASEY_STT_REQUEST_TIMEOUT_MS, 25000),
    concurrency: Math.min(6, num(env.CASEY_STT_CONCURRENCY, 3)),
    minConfidence: unit(env.CASEY_STT_MIN_CONFIDENCE, 0.5),
    ffmpeg: env.CASEY_STT_FFMPEG || 'ffmpeg',
    origin: env.CASEY_STT_ENDPOINT_ORIGIN || '',
    wordConfidence: model === 'chirp_2',
  }
}

export function speechHost(location) {
  return location === 'global' ? 'speech.googleapis.com' : `${location}-speech.googleapis.com`
}
