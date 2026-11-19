import { caseyText } from '../deployment-text.js';


const DEFAULT_FLUSH_WINDOW_MS = 15 * 60_000

export const DROP_REASONS = {
  rate_limited_contact: caseyText("src/hooks/dropped-intake.js#0"),
  rate_limited_global: caseyText("src/hooks/dropped-intake.js#1"),
  burst_buffer_full: caseyText("src/hooks/dropped-intake.js#2"),
  store_not_ready: caseyText("src/hooks/dropped-intake.js#3"),
  case_resolve_failed: caseyText("src/hooks/dropped-intake.js#4"),
  inbound_record_failed: caseyText("src/hooks/dropped-intake.js#5"),
  gateway_gap_unresumable: caseyText("src/hooks/dropped-intake.js#6"),
  gateway_identity_unknown: caseyText("src/hooks/dropped-intake.js#7"),
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
      contact: { display_name: caseyText("src/hooks/dropped-intake.js#s0"), handle: 'intake' },
    }).then(r => {
      if (r.created && !r.case.subject) {
        store.updateCase(r.case.id, { subject: caseyText("src/hooks/dropped-intake.js#8") }).catch(() => {})
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
      text: caseyText("src/hooks/dropped-intake.js#9", [count, t.total, DROP_REASONS[reason] || reason, channels, t.note ? ` [${t.note}]` : '']),
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
