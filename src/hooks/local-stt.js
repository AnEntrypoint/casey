// hooks/local-stt.js -- offline voice-note transcription on this machine, the FALLBACK
// behind hooks/media.js transcribeAudioDetailed. Nothing leaves the host: ffmpeg decodes
// the note to 16 kHz mono PCM and whisper.cpp (whisper-cli, a multilingual ggml model)
// transcribes it. Both are installed OUTSIDE the repo by scripts/setup-local-stt.sh
// (default /config/stt; CASEY_LOCAL_STT_DIR).
//
// ENGINES. 'omni' is Meta's Omnilingual ASR (CTC 1B, int8, via sherpa-onnx, scripts/omni-asr.py): 1600+ languages including
// isiZulu, isiXhosa, Setswana, Sepedi, Xitsonga and Afrikaans, which whisper does not cover; on FLEURS clips it measured
// 27% / 36% / 22% word error (zu / xh / af) where whisper base measured 150% / 141% / 76%, at about the same speed.
// 'whisper' is whisper.cpp as before. CASEY_LOCAL_STT_ENGINE = auto (default: omni when installed, then whisper if omni
// fails or hears nothing) | omni | whisper.
//
// Fail-open like every media tool: every failure returns {text: ''} with a reason and
// never throws. The audio and the transcript are never logged here. Child processes run
// via execFile with an argument array (no shell), a hard deadline, a minimal environment
// and a private 0700 temp dir that is removed afterwards. One job runs at a time (the box
// has 2 cores); a few more may wait, the rest are refused at once. The deadline covers
// queue wait plus run, so a reply is never held longer than the timeout.
//
// LANGUAGE: whisper auto-detects the language. It covers English and Afrikaans well and
// Swahili/Shona poorly; isiZulu, isiXhosa, Sesotho, Setswana, Sepedi, Xitsonga, Tshivenda,
// siSwati and isiNdebele are NOT whisper languages, so a note in one of them comes back
// garbled or as a wrong-language guess. The text is still returned (the note is always
// labelled an AI-helper auto-transcript that may be wrong); `language` and
// `languageSupported` say what whisper detected so a caller can judge.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const MAX_BYTES = 5 * 1024 * 1024
const MAX_QUEUE = 4 // waiting jobs beyond the one running
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

// Input container by MIME type. Naming the format (and whitelisting the file protocol)
// stops a crafted upload from steering ffmpeg into playlists, URLs or other demuxers.
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

// Whisper emits bracketed non-speech markers ([BLANK_AUDIO], (music), ...) for silence.
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
    // Omnilingual first (when installed and allowed); whisper when it is not, or when omni failed or heard nothing and time remains.
    if (c.engine !== 'whisper' && omniReady(c)) {
      try {
        const out = await run(c.python, [c.omniScript, c.omniDir, wav, c.threads], { cwd: dir, timeout: Math.max(1000, left()) })
        const text = String(JSON.parse(out.trim().split('\n').pop()).text || '').replace(/\s+/g, ' ').trim()
        if (text) return { text, error: '', provider: 'local-omnilingual', language: null, languageSupported: true }
      } catch { /* fall through to whisper */ }
      if (c.engine === 'omni' || !whisperReady(c) || left() < 4000) return { text: '', error: 'local stt: no intelligible speech', provider: 'local-omnilingual' }
    }
    // Greedy decoding (-bs 1 -bo 1): measured ~20% faster than beam search at the same text on 2 cores.
    await run(c.whisper, ['-m', c.model, '-f', wav, '-l', 'auto', '-t', c.threads, '-nt', '-np', '-bs', '1', '-bo', '1', '-oj', '-of', out], { cwd: dir, timeout: Math.max(1000, left()) })
    const j = JSON.parse(fs.readFileSync(`${out}.json`, 'utf8'))
    const text = cleanText((j.transcription || []).map(s => s?.text || '').join(' '))
    const language = String(j?.result?.language || '').toLowerCase() || null
    if (!text) return { text: '', error: 'local stt: no intelligible speech', language }
    return { text, error: '', language, languageSupported: SUPPORTED_LANGS.has(language) }
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort cleanup */ } }
}

// One job at a time; returns when this caller may run, or throws if the deadline hits first.
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

// Returns {text, provider: 'local-whisper', ms, error, language?, languageSupported?}.
export async function transcribeLocal(buffer, mimeType) {
  const t0 = Date.now()
  const done = (r) => ({ provider: 'local-whisper', ms: Date.now() - t0, ...r })   // a result names its own engine (local-omnilingual)
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
