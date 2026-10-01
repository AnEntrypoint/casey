

const DEFAULT_FLUSH_WINDOW_MS = 15 * 60_000

export const DROP_REASONS = {
  rate_limited_contact: 'one contact sent more than their allowed messages in the window',
  rate_limited_global: 'all contacts together sent more than the global allowance in the window',
  burst_buffer_full: 'a contact sent faster than a turn could finish and the hold buffer filled up',
  store_not_ready: 'the store was not initialized, so the message could not be recorded at all',
  case_resolve_failed: 'the store could not be read or written to open or find the report, so the message reached no record at all (the sending platform was acked already and will never redeliver it)',
  inbound_record_failed: 'the report was opened but the message itself could not be appended to it, so that report exists with the message missing from its timeline',
  gateway_gap_unresumable: 'the gateway reconnected but could not resume the previous session, so anything sent during that disconnect window was never delivered (a count of windows, not of messages -- how many were in one is not knowable)',
  gateway_identity_unknown: 'a guild message arrived before the gateway reported casey own user id, so the mention filter could not evaluate it and failed closed',
}

const tallies = new Map()

function tally(reason) {
  let t = tallies.get(reason)
  if (!t) { t = { total: 0, sinceFlush: 0, firstAt: null, lastAt: null, channels: new Map(), lastFlushAt: 0, note: null }; tallies.set(reason, t) }
  return t
}

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

export function recordDroppedInbound(reason, { channel = 'unknown', store = null, log = console, now = Date.now(), flushWindowMs = DEFAULT_FLUSH_WINDOW_MS, note = null } = {}) {
  const t = tally(reason)
  t.total += 1
  t.sinceFlush += 1
  if (t.firstAt == null) t.firstAt = now
  t.lastAt = now
  if (note) t.note = note
  t.channels.set(channel, (t.channels.get(channel) || 0) + 1)
  if (store) flushIfDue(reason, { store, log, now, flushWindowMs })
}

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
      text: `INTAKE DROPPED ${count} message(s), ${t.total} since start -- ${DROP_REASONS[reason] || reason} (${channels})${t.note ? ` [${t.note}]` : ''}`,
      data: { dropped_inbound: reason, count, total: t.total, note: t.note || undefined },
    }))
    .catch(e => log?.error?.('[casey] dropped-intake audit write failed', { reason, error: e.message }))
}

export function flushDroppedIntake(store, log = console, now = Date.now()) {
  if (!store) return
  for (const reason of tallies.keys()) flushIfDue(reason, { store, log, now, flushWindowMs: 0, force: true })
}

export function snapshotDroppedIntake() {
  const reasons = {}
  let total = 0
  let firstAt = null
  let lastAt = null
  for (const [reason, t] of tallies) {
    if (!t.total) continue
    reasons[reason] = { count: t.total, detail: DROP_REASONS[reason] || reason, channels: Object.fromEntries(t.channels), note: t.note || undefined }
    total += t.total
    if (firstAt == null || t.firstAt < firstAt) firstAt = t.firstAt
    if (lastAt == null || t.lastAt > lastAt) lastAt = t.lastAt
  }
  return { total, first_at: firstAt, last_at: lastAt, reasons }
}

export function _resetDroppedIntake() { tallies.clear(); dropCaseIdP = null }
