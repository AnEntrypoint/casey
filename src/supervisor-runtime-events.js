

import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_CAP = 50

export const DEFAULT_MAX_LOG_BYTES = 2 * 1024 * 1024

export function createRuntimeEventBuffer({ log, logPath, deliver, cap = DEFAULT_CAP, maxLogBytes }) {
  const pending = []
  const maxBytes = maxLogBytes
    || Number(process.env.CASEY_RUNTIME_EVENT_LOG_MAX_BYTES)
    || DEFAULT_MAX_LOG_BYTES

  let writeFailures = 0
  let lastWriteError = null

  function rotateIfNeeded(incomingBytes) {
    let size = 0
    try { size = fs.statSync(logPath).size } catch { return }
    if (size === 0) return
    if (size + incomingBytes <= maxBytes) return
    const dir = path.dirname(logPath)
    const base = path.basename(logPath, '.jsonl')
    let stamp = Date.now()
    let archive = path.join(dir, `${base}.${stamp}.jsonl`)
    while (fs.existsSync(archive)) archive = path.join(dir, `${base}.${++stamp}.jsonl`)
    fs.renameSync(logPath, archive)
    log.warn?.('[supervisor] runtime_event_log_rotated', { archive: path.basename(archive), bytes: size })
  }

  function appendLog(entry) {
    const line = JSON.stringify(entry) + '\n'
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true })
      rotateIfNeeded(Buffer.byteLength(line, 'utf8'))
      fs.appendFileSync(logPath, line)
    } catch (e) {
      writeFailures += 1
      lastWriteError = e.message

      log.error?.('[supervisor] runtime_event_log_append_failed', { error: e.message, write_failures: writeFailures })
    }
  }

  function flush() {
    while (pending.length) {
      if (!deliver(pending[0])) return
      pending.shift()
    }
  }

  function emit(entry) {
    pending.push(entry)
    if (pending.length > cap) pending.shift()
    appendLog(entry)
    flush()
  }

  function stats() {
    let bytes = 0
    try { bytes = fs.statSync(logPath).size } catch { bytes = 0 }
    let archives = 0
    try {
      const base = path.basename(logPath, '.jsonl')
      const re = new RegExp(`^${base}\\.(\\d+)\\.jsonl$`)
      archives = fs.readdirSync(path.dirname(logPath)).filter(n => re.test(n)).length
    } catch { archives = 0 }
    return {
      pending: pending.length,
      cap,
      log_bytes: bytes,
      max_log_bytes: maxBytes,
      archive_count: archives,
      write_failures: writeFailures,
      last_write_error: lastWriteError,
    }
  }

  return { emit, flush, stats }
}
