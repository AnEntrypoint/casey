import { googleVoiceRepliesEnabled, TTS_VOICES } from './tts.js'
import { caseyText } from '../deployment-text.js';

export async function sttDoctorRows({ env = process.env, hasOtherEngine = false } = {}) {
  const rows = []
  rows.push(hasOtherEngine
    ? { level: 'skip', text: caseyText("src/stt/doctor.js#0") }
    : { level: 'warn', text: caseyText("src/stt/doctor.js#1"), fix: caseyText("src/stt/doctor.js#2") })
  if (googleVoiceRepliesEnabled(env)) rows.push({ level: 'skip', text: caseyText("src/stt/doctor.js#13", [Object.keys(TTS_VOICES).join(', ')]) })
  return rows
}
