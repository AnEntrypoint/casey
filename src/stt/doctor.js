import { execFile } from 'node:child_process'
import { googleSttConfig, googleSttEnabled } from './config.js'
import { accessToken, projectId } from './gcp-auth.js'
import { googleVoiceRepliesEnabled, TTS_VOICES } from './tts.js'
import { SA_LANGUAGES } from './languages.js'

const MODEL_LOCATIONS = { chirp_3: ['us', 'eu'], chirp_2: ['us-central1', 'europe-west4', 'asia-southeast1'], long: ['global', 'us', 'eu'], short: ['global', 'us', 'eu'] }

const ffmpegPresent = (bin) => new Promise(resolve => execFile(bin, ['-version'], { timeout: 4000 }, (err) => resolve(!err)))

export async function sttDoctorRows({ offline = false, env = process.env, hasOtherEngine = false } = {}) {
  const rows = []
  if (!googleSttEnabled(env)) {
    rows.push(hasOtherEngine
      ? { level: 'skip', text: 'voice transcription: legacy engines (OpenRouter chat audio, local whisper); set CASEY_STT_ENGINE=google for Google Cloud Speech-to-Text' }
      : { level: 'warn', text: 'voice transcription: NO engine is configured, so every voice note is saved untranscribed and the person is asked to type', fix: 'set CASEY_STT_ENGINE=google on a GCP host (service account needs roles/speech.client) or install the local engine' })
  } else {
    const cfg = googleSttConfig(env)
    const allowed = MODEL_LOCATIONS[cfg.model]
    if (allowed && !allowed.includes(cfg.location)) rows.push({ level: 'fail', text: `STT model ${cfg.model} is not offered in location ${cfg.location} (offered in ${allowed.join(', ')})`, fix: 'fix CASEY_STT_GOOGLE_MODEL / CASEY_STT_GOOGLE_LOCATION' })
    else rows.push({ level: 'ok', text: `voice transcription: Google Cloud Speech-to-Text ${cfg.model} in ${cfg.location}, language ${cfg.languageCodes.join(',')}; audio goes to Google under this project's own account (no data-logging opt-in is used)` })
    const chirp = SA_LANGUAGES.filter(l => l.chirp).map(l => l.label).join(', ')
    const long = SA_LANGUAGES.filter(l => !l.chirp).map(l => l.label).join(', ')
    rows.push({ level: 'skip', text: `languages: ${chirp} on ${cfg.model} with detection; ${long} only through the older long model when the case already records that language (no confidence score, always read back)` })
    if (offline) rows.push({ level: 'skip', text: 'service-account token not checked (offline mode)' })
    else {
      try { await accessToken(); rows.push({ level: 'ok', text: `service-account token available for project ${await projectId()}` }) }
      catch (e) { rows.push({ level: 'fail', text: `no Google service-account token: ${e.message}`, fix: 'run on the GCP VM, or unset CASEY_STT_ENGINE' }) }
    }
    rows.push(await ffmpegPresent(cfg.ffmpeg)
      ? { level: 'ok', text: `ffmpeg present (${cfg.ffmpeg}): notes longer than ${cfg.chunkSeconds}s are split on silence, up to ${cfg.maxSeconds}s` }
      : { level: 'warn', text: `ffmpeg not found (${cfg.ffmpeg}): voice notes over ${cfg.chunkSeconds}s fail with a truthful message`, fix: 'apt-get install ffmpeg (deploy/gcp/vm/startup.sh installs it)' })
  }
  if (googleVoiceRepliesEnabled(env)) rows.push({ level: 'skip', text: `voice replies ON (Google Text-to-Speech): only cases tagged voice-replies, only languages with a real voice (${Object.keys(TTS_VOICES).join(', ')}), never for opted-out or needs-human cases, text always sent too` })
  return rows
}
