import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { SttError, STT_FAILURE } from './errors.js'

const FFMPEG_ENV = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C' }

function runFfmpeg(ffmpeg, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, ['-nostdin', '-hide_banner', ...args], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, env: FFMPEG_ENV }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return reject(new SttError(STT_FAILURE.FFMPEG_MISSING, `ffmpeg not found (${ffmpeg}); install it to split notes longer than one minute`))
      if (err && err.killed) return reject(new SttError(STT_FAILURE.TIMEOUT, 'ffmpeg timed out'))
      resolve({ code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

export function parseProbe(stderr) {
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  const durationSec = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null
  const silences = []
  let start = null
  for (const m of stderr.matchAll(/silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g)) {
    const t = Number(m[2])
    if (m[1] === 'start') start = Math.max(0, t)
    else if (start !== null) { silences.push({ start, end: t, mid: (start + t) / 2 }); start = null }
  }
  return { durationSec, silences }
}

export function planChunks(durationSec, silences, { chunkSeconds, minSeconds = chunkSeconds * 0.5 }) {
  const plan = []
  let at = 0
  while (durationSec - at > chunkSeconds) {
    const cut = silences.filter(s => s.mid >= at + minSeconds && s.mid <= at + chunkSeconds).map(s => s.mid).pop()
    const end = cut ?? at + chunkSeconds
    plan.push({ start: at, end })
    at = end
  }
  plan.push({ start: at, end: durationSec })
  return plan
}

export async function splitAudio(buffer, { ffmpeg, chunkSeconds, maxSeconds, deadline }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'casey-stt-'))
  try {
    fs.chmodSync(dir, 0o700)
    const input = path.join(dir, 'in.bin')
    fs.writeFileSync(input, buffer, { mode: 0o600 })
    const left = () => Math.max(1000, deadline - Date.now())
    const probe = await runFfmpeg(ffmpeg, ['-i', input, '-vn', '-af', 'silencedetect=noise=-35dB:d=0.35', '-f', 'null', '-'], left())
    const { durationSec, silences } = parseProbe(probe.stderr)
    if (!durationSec) throw new SttError(STT_FAILURE.BAD_AUDIO, 'ffmpeg could not read this audio')
    if (durationSec > maxSeconds) throw new SttError(STT_FAILURE.TOO_LONG, `audio is ${Math.round(durationSec)}s, over the ${maxSeconds}s limit`)
    const plan = planChunks(durationSec, silences, { chunkSeconds })
    const chunks = []
    for (const [i, p] of plan.entries()) {
      const out = path.join(dir, `c${i}.flac`)
      const r = await runFfmpeg(ffmpeg, ['-y', '-v', 'error', '-ss', String(p.start), '-t', String(p.end - p.start), '-i', input, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'flac', out], left())
      if (r.code || !fs.existsSync(out)) throw new SttError(STT_FAILURE.BAD_AUDIO, 'ffmpeg could not cut the audio')
      chunks.push({ content: fs.readFileSync(out), startSec: p.start, endSec: p.end })
    }
    return { durationSec, chunks }
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) { process.emitWarning(`stt temp cleanup failed: ${e.message}`) } }
}
