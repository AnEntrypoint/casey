import { execFile } from 'node:child_process'
import { googleSttConfig, googleSttEnabled } from './config.js'
import { accessToken, projectId } from './gcp-auth.js'
import { googleVoiceRepliesEnabled, TTS_VOICES } from './tts.js'
import { SA_LANGUAGES } from './languages.js'
import { specialistEndpoints, SPECIALIST_KEYS } from './specialist.js'
import { caseyText } from '../deployment-text.js';

const MODEL_LOCATIONS = { chirp_3: ['us', 'eu'], chirp_2: ['us-central1', 'europe-west4', 'asia-southeast1'], long: ['global', 'us', 'eu'], short: ['global', 'us', 'eu'] }

const ffmpegPresent = (bin) => new Promise(resolve => execFile(bin, ['-version'], (err) => resolve(!err)))

export async function sttDoctorRows({ offline = false, env = process.env } = {}) {
  const rows = []
  if (!googleSttEnabled(env)) {
    rows.push({ level: 'warn', text: caseyText("src/stt/doctor.js#1"), fix: caseyText("src/stt/doctor.js#2") })
  } else {
    const cfg = googleSttConfig(env)
    const allowed = MODEL_LOCATIONS[cfg.model]
    if (allowed && !allowed.includes(cfg.location)) rows.push({ level: 'fail', text: caseyText("src/stt/doctor.js#3", [cfg.model, cfg.location, allowed.join(', ')]), fix: caseyText("src/stt/doctor.js#4") })
    else rows.push({ level: 'ok', text: caseyText("src/stt/doctor.js#5", [cfg.model, cfg.location, cfg.languageCodes.join(',')]) })
    const chirp = SA_LANGUAGES.filter(l => l.chirp).map(l => l.label).join(', ')
    const long = SA_LANGUAGES.filter(l => !l.chirp).map(l => l.label).join(', ')
    rows.push({ level: 'skip', text: caseyText("src/stt/doctor.js#6", [chirp, cfg.model, long]) })
    if (offline) rows.push({ level: 'skip', text: caseyText("src/stt/doctor.js#7") })
    else {
      try { await accessToken(); rows.push({ level: 'ok', text: caseyText("src/stt/doctor.js#8", [await projectId()]) }) }
      catch (e) { rows.push({ level: 'fail', text: caseyText("src/stt/doctor.js#s0", [e.message]), fix: caseyText("src/stt/doctor.js#9") }) }
    }
    rows.push(await ffmpegPresent(cfg.ffmpeg)
      ? { level: 'ok', text: caseyText("src/stt/doctor.js#10", [cfg.ffmpeg, cfg.chunkSeconds, cfg.maxSeconds]) }
      : { level: 'warn', text: caseyText("src/stt/doctor.js#11", [cfg.ffmpeg, cfg.chunkSeconds]), fix: caseyText("src/stt/doctor.js#12") })
    const configured = specialistEndpoints(env)
    const wired = SPECIALIST_KEYS.filter(k => configured.has(k))
    rows.push(wired.length === SPECIALIST_KEYS.length
      ? { level: 'ok', text: caseyText("src/stt/doctor.js#14", [['google', ...SPECIALIST_KEYS].join(', ')]) }
      : { level: 'warn', text: caseyText("src/stt/doctor.js#15", [wired.length, SPECIALIST_KEYS.length, SPECIALIST_KEYS.filter(k => !configured.has(k)).join(', ')]), fix: caseyText("src/stt/doctor.js#16") })
  }
  if (googleVoiceRepliesEnabled(env)) rows.push({ level: 'skip', text: caseyText("src/stt/doctor.js#13", [Object.keys(TTS_VOICES).join(', ')]) })
  return rows
}
