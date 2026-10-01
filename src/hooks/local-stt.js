

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const MAX_BYTES = 5 * 1024 * 1024
const MAX_QUEUE = 4
const SUPPORTED_LANGS = new Set(String(process.env.CASEY_LOCAL_STT_LANGS || 'en,af').split(',').map(s => s.trim().toLowerCase()).filter(Boolean))

let running = false
const waiters = []

export function localSttEnabled() { return process.env.CASEY_LOCAL_STT !== '0' }

function cfg() {
  const dir = process.env.CASEY_LOCAL_STT_DIR || '/config/stt'
  const model = process.env.CASEY_LOCAL_STT_MODEL || 'base'
  return {
    ffmpeg: path.join(dir, 'bin', 'ffmpeg'),
    whisper: path.join(dir, 'src', 'whisper.cpp', 'build', 'bin', 'whisper-cli'),
    model: path.isAbsolute(model) ? model : path.join(dir, 'models', `ggml-${model}.bin`),
    timeoutMs: Number(process.env.CASEY_LOCAL_STT_TIMEOUT_MS) || 60000,
    threads: String(Math.min(8, Math.max(1, Number(process.env.CASEY_LOCAL_STT_THREADS) || 2))),
    engine: ['omni', 'whisper'].includes(process.env.CASEY_LOCAL_STT_ENGINE) ? process.env.CASEY_LOCAL_STT_ENGINE : 'auto',
    python: path.join(dir, 'venv', 'bin', 'python'),
    omniScript: fileURLToPath(new URL('../../scripts/omni-asr.py', import.meta.url)),
    omniDir: path.join(dir, 'models', 'omni', process.env.CASEY_LOCAL_STT_OMNI_MODEL || 'sherpa-onnx-omnilingual-asr-1600-languages-1B-ctc-v2-int8-2026-02-05'),
  }
}

function inputFormat(mimeType) {
  const t = String(mimeType || '').toLowerCase()
  if (/ogg|opus/.test(t)) return 'ogg'
  if (/mpeg|mp3/.test(t)) return 'mp3'
  if (/mp4|m4a/.test(t)) return 'mov,mp4,m4a,3gp,3g2,mj2'
  if (/aac/.test(t)) return 'aac'
  if (/amr/.test(t)) return 'amr'
  if (/flac/.test(t)) return 'flac'
  if (/webm/.test(t)) return 'matroska,webm'
  if (/wav/.test(t)) return 'wav'
  return ''
}

function run(file, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...opts, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true, env: { PATH: '/usr/bin:/bin', LANG: 'C', HOME: opts.cwd } }, (err, stdout) => {
      if (err) reject(err.killed ? new Error(`timed out after ${opts.timeout}ms`) : new Error(`${path.basename(file)} exited ${err.code ?? err.signal ?? 'abnormally'}`))
      else resolve(String(stdout || ''))
    })
  })
}

function cleanText(raw) {
  return String(raw || '').replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ').replace(/\s+/g, ' ').trim()
}

const omniReady = (c) => [c.python, c.omniScript, path.join(c.omniDir, 'model.int8.onnx'), path.join(c.omniDir, 'tokens.txt')].every(p => fs.existsSync(p))
const whisperReady = (c) => [c.whisper, c.model].every(p => fs.existsSync(p))

async function transcribeNow(buffer, mimeType, c, deadline) {
  const left = () => deadline - Date.now()
  const fmt = inputFormat(mimeType)
  if (!fmt) return { text: '', error: 'local stt: unsupported audio type' }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'casey-stt-'))
  try {
    fs.chmodSync(dir, 0o700)
    const inFile = path.join(dir, 'in.bin'), wav = path.join(dir, 'in.wav'), out = path.join(dir, 'out')
    fs.writeFileSync(inFile, buffer, { mode: 0o600 })
    if (left() < 1000) return { text: '', error: 'local stt: timed out waiting' }
    await run(c.ffmpeg, ['-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file', '-f', fmt, '-i', inFile, '-t', '300', '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { cwd: dir, timeout: Math.max(1000, left()) })
    if (left() < 1000) return { text: '', error: 'local stt: timed out' }

    if (c.engine !== 'whisper' && omniReady(c)) {
      try {
        const out = await run(c.python, [c.omniScript, c.omniDir, wav, c.threads], { cwd: dir, timeout: Math.max(1000, left()) })
        const text = String(JSON.parse(out.trim().split('\n').pop()).text || '').replace(/\s+/g, ' ').trim()
        if (text) return { text, error: '', provider: 'local-omnilingual', language: null, languageSupported: true }
      } catch {  }
      if (c.engine === 'omni' || !whisperReady(c) || left() < 4000) return { text: '', error: 'local stt: no intelligible speech', provider: 'local-omnilingual' }
    }

    await run(c.whisper, ['-m', c.model, '-f', wav, '-l', 'auto', '-t', c.threads, '-nt', '-np', '-bs', '1', '-bo', '1', '-oj', '-of', out], { cwd: dir, timeout: Math.max(1000, left()) })
    const j = JSON.parse(fs.readFileSync(`${out}.json`, 'utf8'))
    const text = cleanText((j.transcription || []).map(s => s?.text || '').join(' '))
    const language = String(j?.result?.language || '').toLowerCase() || null
    if (!text) return { text: '', error: 'local stt: no intelligible speech', language }
    return { text, error: '', language, languageSupported: SUPPORTED_LANGS.has(language) }
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {  } }
}

function acquire(deadline) {
  if (!running) { running = true; return Promise.resolve() }
  if (waiters.length >= MAX_QUEUE) return Promise.reject(new Error('busy (queue full)'))
  return new Promise((resolve, reject) => {
    const w = { resolve }
    w.timer = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); reject(new Error('timed out waiting in queue')) }, Math.max(0, deadline - Date.now()))
    waiters.push(w)
  })
}
function release() {
  const next = waiters.shift()
  if (next) { clearTimeout(next.timer); next.resolve() } else running = false
}

export function localSttAvailable() {
  if (!localSttEnabled()) return false
  const c = cfg()
  try { return fs.existsSync(c.ffmpeg) && ((c.engine !== 'whisper' && omniReady(c)) || (c.engine !== 'omni' && whisperReady(c))) } catch { return false }
}

export async function transcribeLocal(buffer, mimeType) {
  const t0 = Date.now()
  const done = (r) => ({ provider: 'local-whisper', ms: Date.now() - t0, ...r })
  try {
    if (!localSttEnabled()) return done({ text: '', error: 'local stt disabled (CASEY_LOCAL_STT=0)' })
    if (!buffer?.length) return done({ text: '', error: 'no audio bytes' })
    if (buffer.length > MAX_BYTES) return done({ text: '', error: `local stt: audio over ${MAX_BYTES} bytes` })
    if (!localSttAvailable()) return done({ text: '', error: 'local stt not installed (run scripts/setup-local-stt.sh)' })
    const c = cfg()
    const deadline = t0 + c.timeoutMs
    try { await acquire(deadline) } catch (e) { return done({ text: '', error: `local stt: ${e.message}` }) }
    try { return done(await transcribeNow(buffer, mimeType, c, deadline)) } finally { release() }
  } catch (e) {
    return done({ text: '', error: `local stt: ${String(e?.message || e)}` })
  }
}
