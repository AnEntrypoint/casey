// hooks/dropped-intake.js -- the record of every inbound message casey turned
// away BEFORE it reached recordInbound, so a lost report is not merely a log
// line on a headless box nobody reads.
//
// FOUR PATHS DROP AN INBOUND ABOVE THE STORE WRITE, and all four are deliberate:
//
//   rate_limited_contact  one contact over CASEY_RATE_LIMIT_MSGS in the window
//   rate_limited_global   everyone together over CASEY_GLOBAL_RATE_LIMIT_MSGS
//   burst_buffer_full     more than BUFFER_CAP messages held for one contact
//                         while a turn was in flight; the OLDEST is discarded
//   store_not_ready       the store is not initialized, so nothing can be written
//
// WHY THIS IS AGGREGATE AND NOT ONE ROW PER MESSAGE. The rate limiters exist
// precisely to stop a flood driving unbounded store writes (hooks/
// case-intake.js's checkAdmission says so in its own words), so recording each
// dropped message as its own row would hand the flood the exact amplification
// the limiter was put there to deny -- a signature-verified flood would then
// cost one write per message instead of none. Counting in memory and flushing a
// SUMMARY at most once per window per reason keeps the write cost bounded by
// wall-clock time rather than by message volume. The cost of that choice, stated
// rather than hidden: an operator learns that twelve messages were dropped and
// why, never which twelve.
//
// NO CONTACT KEY IS EVER RECORDED HERE. The same discipline bin/
// worker-runtime-events.js states for the runtime audit ("reason-only ... so
// nothing here can leak it") applies for the same reason: this is a system-level
// aggregate, and AGENTS.md's rule is that aggregate rollups never emit
// external_id. Channel is recorded because it is not identifying and is the
// first thing an operator needs in order to act.
//
// Module-level state, read back through an exported getter, is the pattern
// hooks/notifiers.js already uses for webhook delivery status -- the alternative
// is threading a recorder through four layers that have no other reason to know
// about it.

const DEFAULT_FLUSH_WINDOW_MS = 15 * 60_000

export const DROP_REASONS = {
  rate_limited_contact: 'one contact sent more than their allowed messages in the window',
  rate_limited_global: 'all contacts together sent more than the global allowance in the window',
  burst_buffer_full: 'a contact sent faster than a turn could finish and the hold buffer filled up',
  store_not_ready: 'the store was not initialized, so the message could not be recorded at all',
}

// reason -> { total, sinceFlush, firstAt, lastAt, channels: Map<channel, count>, lastFlushAt }
const tallies = new Map()

function tally(reason) {
  let t = tallies.get(reason)
  if (!t) { t = { total: 0, sinceFlush: 0, firstAt: null, lastAt: null, channels: new Map(), lastFlushAt: 0 }; tallies.set(reason, t) }
  return t
}

// The singleton system case every summary is appended to. Same shape and same
// reasoning as bin/worker-runtime-events.js's runtime:supervisor case: a
// channel:'system' case is excluded from listContacts AND from the case list
// (case-store.js filters `channel: {$ne:'system'}` in both), so this is a
// durable audit trail rather than something that clutters an operator's queue.
// The operator-facing surface is /api/health, which reads snapshotDroppedIntake
// below.
let dropCaseIdP = null
async function dropCaseId(store) {
  if (!dropCaseIdP) {
    dropCaseIdP = store.findOrCreateCase({
      channel: 'system', external_id: 'intake:dropped',
      contact: { display_name: 'casey intake', handle: 'intake' },
    }).then(r => {
      if (r.created && !r.case.subject) {
        store.updateCase(r.case.id, { subject: 'inbound messages dropped before they were recorded' }).catch(() => {})
      }
      return r.case.id
    }).catch((e) => { dropCaseIdP = null; throw e })
  }
  return dropCaseIdP
}

// Count one dropped inbound. Synchronous and allocation-cheap on purpose: this
// runs on the flood path itself, so it must not add an await, a store round
// trip, or anything that could fail, to the path whose whole job is to be cheap.
// The store write is fired separately and best-effort by flushIfDue.
export function recordDroppedInbound(reason, { channel = 'unknown', store = null, log = console, now = Date.now(), flushWindowMs = DEFAULT_FLUSH_WINDOW_MS } = {}) {
  const t = tally(reason)
  t.total += 1
  t.sinceFlush += 1
  if (t.firstAt == null) t.firstAt = now
  t.lastAt = now
  t.channels.set(channel, (t.channels.get(channel) || 0) + 1)
  if (store) flushIfDue(reason, { store, log, now, flushWindowMs })
}

// One summary per reason per window, carrying everything accumulated since the
// last one. Deliberately fire-and-forget: a failed audit write must never turn a
// dropped message into a thrown error on the inbound path, and the in-memory
// tally that /api/health reads is unaffected either way.
//
// The running total goes in the text as well as the count for this summary,
// because the two answer different questions and only one of them survives a
// missed flush: "17 more since the last line" is what changed, "412 since this
// process started" is what an operator has actually lost.
function flushIfDue(reason, { store, log, now, flushWindowMs, force = false }) {
  const t = tally(reason)
  if (!t.sinceFlush) return
  if (!force && t.lastFlushAt && now - t.lastFlushAt < flushWindowMs) return
  const count = t.sinceFlush
  const channels = [...t.channels.entries()].map(([c, n]) => `${c}:${n}`).join(', ')
  t.sinceFlush = 0
  t.lastFlushAt = now
  dropCaseId(store)
    .then(id => store.appendEvent(id, {
      kind: 'observation', actor: 'system',
      text: `INTAKE DROPPED ${count} message(s), ${t.total} since start -- ${DROP_REASONS[reason] || reason} (${channels})`,
      data: { dropped_inbound: reason, count, total: t.total },
    }))
    .catch(e => log?.error?.('[casey] dropped-intake audit write failed', { reason, error: e.message }))
}

// Write out whatever has accumulated since the last summary, window or no
// window. Called from the periodic guardrail sweep (case-sweep.js), which is the
// only thing in this process that already runs on a clock and already holds the
// store -- adding a timer here would make this module own a lifecycle it has no
// other reason to have.
//
// Without this the audit trail loses its last partial window entirely: a flood
// that stops leaves its remaining count sitting in memory with nothing to
// trigger the next flush, so the very case that matters most -- the flood that
// ended -- is the one that would never be written down. Measured before this
// existed: 81 dropped messages produced three rows each claiming one message.
export function flushDroppedIntake(store, log = console, now = Date.now()) {
  if (!store) return
  for (const reason of tallies.keys()) flushIfDue(reason, { store, log, now, flushWindowMs: 0, force: true })
}

// What /api/health reports. Totals are since process start, which is the honest
// bound: the tallies are in memory, and saying "since this process started"
// is true where "in the last hour" would not be.
export function snapshotDroppedIntake() {
  const reasons = {}
  let total = 0
  let firstAt = null
  let lastAt = null
  for (const [reason, t] of tallies) {
    if (!t.total) continue
    reasons[reason] = { count: t.total, detail: DROP_REASONS[reason] || reason, channels: Object.fromEntries(t.channels) }
    total += t.total
    if (firstAt == null || t.firstAt < firstAt) firstAt = t.firstAt
    if (lastAt == null || t.lastAt > lastAt) lastAt = t.lastAt
  }
  return { total, first_at: firstAt, last_at: lastAt, reasons }
}

// Test-free reset hook for a live probe against a copy of the store. Not called
// by any production path.
export function _resetDroppedIntake() { tallies.clear(); dropCaseIdP = null }
