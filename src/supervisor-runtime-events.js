// supervisor-runtime-events.js  --  the buffer that gets a runtime bounce
// (CRASH / RELOAD / DEGRADED / BUDGET) into durable storage even though the
// process that DETECTS it is never the process that can store it.
//
// Why the buffer exists: the PARENT detects these events but only the WORKER
// holds the store -- and at CRASH time the worker that died is gone while the
// next is not yet up. So each event is buffered and flushed to the
// worker right after it sends READY (the same moment the state snapshot is
// pushed). A bounded ring (drop-oldest past the cap) keeps a respawn storm from
// growing this without limit; the per-event reason is reason-only (no
// external_id / PII).
//
// Why there is ALSO a JSONL sidecar: durability backstop for a sustained
// pre-READY crash loop. If every respawned worker crashes before ever reaching
// READY (e.g. thatcher's sqlite lock held by a stray process -- a known
// Windows failure mode for this project), the flush never runs (it
// requires a booted worker) and BUDGET_EXCEEDED stops respawning entirely, so
// the in-memory queue would otherwise sit there forever with only a single
// truncated lastCrashReason string externally visible via /api/runtime. Each
// event is appended to a plain JSONL file the moment it is buffered --
// reason-only, same no-PII shape as the in-memory event -- so an operator
// investigating a crash loop has a real, durable trail even when no worker ever
// came up to write it to the audited event store.

import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_CAP = 50

// THE CAP ABOVE BOUNDS THE IN-MEMORY RING, NOT THE FILE. `pending` is what has
// not yet reached a booted worker; the sidecar is written on every emit and had
// no bound at all, so it grew for the life of the deployment.
//
// Size, from this deployment's measured numbers: a real entry written through
// this buffer serializes to 164 bytes (20 entries with a real
// worker-exit reason string). The store's own 13.4-day history holds ZERO
// runtime events, so the steady-state rate here is nil -- this file only grows
// during trouble. Its two bursty producers bound differently:
// supervisor-crash-policy.js's budget stops respawning after 5 crashes in 60s,
// so a crash loop contributes about 1 KB and then halts; RELOAD_REQUESTED is
// mtime-driven and is the only genuinely open-ended producer, at roughly one
// entry per source save on a development host. 2 MB holds ~12,800 entries --
// about 2,500 full crash-budget episodes, or several weeks of continuous
// save-triggered reloads -- which is far past any window an operator would
// investigate, while keeping one file small enough to read end to end.
export const DEFAULT_MAX_LOG_BYTES = 2 * 1024 * 1024

/**
 * @param {object} opts
 * @param {object} opts.log        console-shaped logger
 * @param {string} opts.logPath    JSONL sidecar path
 * @param {(entry:object)=>boolean} opts.deliver
 *        Hands one entry to whatever can persist it. Returns false when nothing
 *        can right now, which holds this entry and every later one in order.
 * @param {number} [opts.cap]      ring size before drop-oldest
 * @param {number} [opts.maxLogBytes] sidecar size at which the file is archived
 */
export function createRuntimeEventBuffer({ log, logPath, deliver, cap = DEFAULT_CAP, maxLogBytes }) {
  const pending = []
  const maxBytes = maxLogBytes
    || Number(process.env.CASEY_RUNTIME_EVENT_LOG_MAX_BYTES)
    || DEFAULT_MAX_LOG_BYTES
  // Append failures, counted rather than only warned about. This file is the
  // durability backstop for a pre-READY crash loop, so the failure that matters
  // is the one where the disk is full: the buffer would go on emitting, every
  // write would fail, and the only trace would be a warn line in the log of a
  // process nobody is watching -- the crash recorder failing silently at exactly
  // the moment it is the only recorder left.
  let writeFailures = 0
  let lastWriteError = null

  // Archive, never truncate: rename the full file aside and start a new one, so
  // the bounded thing is one file's size and no entry is ever discarded. The
  // stamp in the name is the rotation time; nothing here unlinks anything.
  // Measured against the incoming entry's own length so no file is ever left
  // sitting over the limit waiting for the next emit.
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
      // error, not warn: a failing write here means the runtime audit trail is
      // gone for exactly the incident it exists to record.
      log.error?.('[supervisor] runtime_event_log_append_failed', { error: e.message, write_failures: writeFailures })
    }
  }

  // Drain in order, stopping the moment the sink says it cannot take one --
  // never skipping ahead, so the timeline keeps the order the events happened in.
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

  // The sidecar's own health, for a caller that puts it in front of a human
  // (the /api/runtime snapshot the parent pushes down is the natural place).
  // pending is the in-memory ring's depth; write_failures being non-zero means
  // runtime events are being lost as they happen.
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
