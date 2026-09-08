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

/**
 * @param {object} opts
 * @param {object} opts.log        console-shaped logger
 * @param {string} opts.logPath    JSONL sidecar path
 * @param {(entry:object)=>boolean} opts.deliver
 *        Hands one entry to whatever can persist it. Returns false when nothing
 *        can right now, which holds this entry and every later one in order.
 * @param {number} [opts.cap]      ring size before drop-oldest
 */
export function createRuntimeEventBuffer({ log, logPath, deliver, cap = DEFAULT_CAP }) {
  const pending = []

  function appendLog(entry) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true })
      fs.appendFileSync(logPath, JSON.stringify(entry) + '\n')
    } catch (e) { log.warn?.('[supervisor] runtime_event_log_append_failed', { error: e.message }) }
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

  return { emit, flush }
}
