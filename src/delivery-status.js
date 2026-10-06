

import { evData } from './safe.js'
import { mergeTag, dropTag } from './hooks/heuristics.js'

export const DELIVERY_FAILED_TAG = 'delivery-failed'
const SYSTEM = { id: 'system', role: 'system' }
const RANK = { sent: 1, delivered: 2, read: 3 }
const PARK_TTL_MS = 2 * 60e3
const PARK_CAP = 500

export const DELIVERY_ERROR_HINTS = Object.freeze({
  131047: 'the 24-hour window is closed: this person has not messaged in the last 24 hours, so WhatsApp refuses a free-form reply. Call them, or wait for them to message first',
  131026: 'undeliverable: the number is not on WhatsApp, has not accepted the terms, or is on an old version',
  131049: 'Meta withheld the message to protect recipient engagement; retrying immediately will not help',
  131048: 'spam rate limit hit on the sending number',
  131056: 'too many messages to this one person in a short time; wait and retry',
  130429: 'throughput limit reached on the sending number',
  131051: 'unsupported message type for this recipient',
  131052: 'the media the message carried could not be downloaded by WhatsApp',
  131053: 'the media the message carried could not be uploaded',
  131000: 'Meta reported an unspecified send error',
  131031: 'the sending account is locked or restricted by Meta',
  132000: 'a template parameter count mismatch',
})

const tally = { received: 0, applied: 0, duplicates: 0, failed: 0, recovered: 0, unmatched: 0, by_code: new Map(), last_failed_at: null, last_status_at: null }
const parked = new Map()

export function snapshotDeliveryStatus() {
  const by_code = {}
  for (const [k, v] of tally.by_code) by_code[k] = v
  return {
    statuses_received: tally.received, applied: tally.applied, duplicates: tally.duplicates,
    failed: tally.failed, recovered: tally.recovered, unmatched: tally.unmatched,
    parked_now: parked.size, failed_by_code: by_code,
    last_failed_at: tally.last_failed_at, last_status_at: tally.last_status_at,
  }
}

export function resetDeliveryStatus() {
  Object.assign(tally, { received: 0, applied: 0, duplicates: 0, failed: 0, recovered: 0, unmatched: 0, last_failed_at: null, last_status_at: null })
  tally.by_code.clear()
  parked.clear()
}

function park(st, now) {
  for (const [k, v] of parked) if (now - v.at > PARK_TTL_MS) parked.delete(k)
  if (parked.size >= PARK_CAP && !parked.has(st.id)) parked.delete(parked.keys().next().value)
  const p = parked.get(st.id) || { at: now, statuses: [] }
  if (p.statuses.length < 6) p.statuses.push(st)
  parked.set(st.id, p)
}

async function findByWamid(store, wamid) {
  const rows = await store.t.list('event', { msg_id: wamid }, { limit: 3 })
  const direct = rows.find(r => r.kind === 'outbound')
  if (direct) return direct
  const multipart = await store.t.list('event', { kind: 'outbound', data: { $like: `%${wamid}%` } }, { limit: 3 })
  return multipart[0] || null
}

async function findByRecentSend(store, recent, wamid) {
  if (!recent) return null
  const rec = typeof recent.get === 'function' ? recent.get(wamid) : recent[wamid]
  if (!rec || !rec.to) return null
  const cases = await store.t.list('case', { channel: 'whatsapp', external_id: rec.to }, { limit: 20 })
  let best = null
  for (const c of cases) {
    const evs = await store.t.list('event', { case_id: c.id, kind: 'outbound' }, { limit: 300 })
    for (const e of evs) {
      if (e.msg_id) continue
      if (rec.text && e.text !== rec.text) continue
      const at = Number(e.created_at) * 1000
      if (Number.isFinite(at) && rec.at && at < rec.at - 5 * 60e3) continue
      if (!best || Number(e.created_at) >= Number(best.created_at)) best = e
    }
  }
  return best
}

export async function attachWamids(store, ev, sendResult, { log, recentSends, now = Date.now() } = {}) {
  try {
    const wamids = Array.isArray(sendResult?.wamids) ? sendResult.wamids.filter(Boolean) : []
    if (!ev?.id || !wamids.length) return null
    await store._withLock(`delivery|${ev.id}`, async () => {
      const row = (await store.t.list('event', { id: ev.id }, { limit: 1 }))[0]
      if (!row) return
      const data = { ...evData(row), wamid: wamids[0], ...(wamids.length > 1 ? { wamids } : {}) }
      await store.t.update('event', ev.id, { msg_id: wamids[0], data: JSON.stringify(data) }, SYSTEM)
    })
    for (const w of wamids) {
      const p = parked.get(w)
      if (!p) continue
      parked.delete(w)
      for (const st of p.statuses) await applyDeliveryStatus(store, st, { log, recentSends, now, replay: true })
    }
    return wamids[0]
  } catch (e) {
    log?.warn?.('[casey] could not persist the wamid on the outbound event', { error: e?.message || String(e) })
    return null
  }
}

export async function applyDeliveryStatus(store, st, { log, recentSends = null, now = Date.now(), replay = false } = {}) {
  if (!st?.id || !st.status) return { ignored: 'malformed' }
  if (!replay) { tally.received += 1; tally.last_status_at = now }
  let row
  try { row = await findByWamid(store, st.id) || await findByRecentSend(store, recentSends, st.id) }
  catch (e) { log?.warn?.('[casey] delivery status lookup failed', { error: e?.message || String(e) }); return { ignored: 'lookup_failed' } }
  if (!row) {
    if (!replay) { if (!parked.has(st.id)) tally.unmatched += 1; park(st, now) }
    return { matched: false, parked: true }
  }
  return store._withLock(`delivery|${row.id}`, () => applyToRow(store, row.id, st, { log, now }))
}

async function applyToRow(store, eventId, st, { log, now }) {
  const row = (await store.t.list('event', { id: eventId }, { limit: 1 }))[0]
  if (!row) return { matched: false }
  const data = evData(row)
  const seen = { ...(data.status_seen || {}) }
  const known = Object.prototype.hasOwnProperty.call(seen, st.status)

  if (known && !data.notify_pending) { tally.duplicates += 1; return { matched: true, duplicate: true } }

  const at = st.at || now
  if (!known) seen[st.status] = at
  const hasProof = !!(seen.delivered || seen.read)
  const next = { ...data, wamid: data.wamid || st.id, status_seen: seen }
  const rank = Math.max(0, ...Object.keys(seen).map(k => RANK[k] || 0))
  next.delivery_status = Object.keys(RANK).find(k => RANK[k] === rank) || data.delivery_status || st.status
  let failedNow = false
  let recoveredNow = false
  const err = st.errors?.[0] || null

  if (st.status === 'failed') {
    if (hasProof) {

      next.failed_ignored = { at, code: err?.code ?? null }
    } else {
      failedNow = !data.delivery_failed
      const detail = err ? `${err.code ?? '?'}: ${err.title || err.message || 'delivery failed'}` : 'delivery failed'
      next.delivered = false
      next.delivery_failed = { at, code: err?.code ?? null, title: err?.title || '', message: err?.message || '', details: err?.details || '' }
      next.send_error = detail.slice(0, 300)
      if (failedNow) next.notify_pending = true
    }
  } else if ((st.status === 'delivered' || st.status === 'read') && data.delivery_failed) {

    recoveredNow = true
    next.delivered = true
    next.delivery_recovered = { at }
    delete next.send_error
    next.notify_pending = true
  }

  await store.t.update('event', eventId, { ...(row.msg_id ? {} : { msg_id: st.id }), data: JSON.stringify(next) }, SYSTEM)
  tally.applied += 1

  if (failedNow || (known && data.notify_pending && st.status === 'failed' && !recoveredNow)) {
    if (failedNow) {
      tally.failed += 1
      tally.last_failed_at = now
      const k = String(err?.code ?? 'unknown')
      tally.by_code.set(k, (tally.by_code.get(k) || 0) + 1)
    }
    await notifyFailure(store, row, next, err, { log })
    await clearPending(store, eventId, next)
  } else if (recoveredNow) {
    tally.recovered += 1
    await notifyRecovered(store, row, { log })
    await clearPending(store, eventId, next)
  }
  return { matched: true, duplicate: false, failed: failedNow, recovered: recoveredNow }
}

async function clearPending(store, eventId, next) {
  const done = { ...next }
  delete done.notify_pending
  try { await store.t.update('event', eventId, { data: JSON.stringify(done) }, SYSTEM) } catch {  }
}

async function notifyFailure(store, row, next, err, { log }) {
  try {
    const code = err?.code ?? null
    const hint = DELIVERY_ERROR_HINTS[code] || err?.details || err?.message || err?.title || 'no reason given'
    await store.appendEvent(row.case_id, {
      kind: 'observation', actor: 'system', touch: false,
      text: `DELIVERY FAILED: the reply was not delivered${code ? ` (WhatsApp error ${code})` : ''} -- ${hint}`,
      data: { delivery_failed: true, wamid: next.wamid, code, event_id: row.id },
    })
    await setCaseTag(store, row.case_id, DELIVERY_FAILED_TAG, true)
  } catch (e) { log?.warn?.('[casey] could not record a delivery failure on the case', { error: e?.message || String(e) }) }
}

async function notifyRecovered(store, row, { log }) {
  try {
    await store.appendEvent(row.case_id, {
      kind: 'observation', actor: 'system', touch: false,
      text: 'DELIVERY RECOVERED: a reply first reported as not delivered has now been delivered',
      data: { delivery_recovered: true, event_id: row.id },
    })

    const evs = await store.t.list('event', { case_id: row.case_id, kind: 'outbound' }, { limit: 500 })
    const stillBad = evs.some(e => e.id !== row.id && evData(e).delivered === false)
    if (!stillBad) await setCaseTag(store, row.case_id, DELIVERY_FAILED_TAG, false)
  } catch (e) { log?.warn?.('[casey] could not record a delivery recovery on the case', { error: e?.message || String(e) }) }
}

async function setCaseTag(store, caseId, tag, on) {
  const c = await store.getCase(caseId)
  if (!c) return
  await store._withLock(`${c.channel}|${c.external_id}`, async () => {
    const fresh = await store.getCase(caseId)
    if (!fresh) return
    const tags = on ? mergeTag(fresh.tags, tag) : dropTag(fresh.tags, tag)
    if (tags !== (fresh.tags || '')) await store.t.update('case', caseId, { tags }, SYSTEM)
  })
}

export async function countUndeliveredCases(store) {
  const rows = await store.t.list('case', { tags: { $like: `%${DELIVERY_FAILED_TAG}%` } }, { limit: 500 }).catch(() => null)
  if (rows) return rows.filter(c => c.status !== 'closed').length
  const all = await store.listCases({}, { limit: 10000 })
  return all.filter(c => c.status !== 'closed' && String(c.tags || '').split(',').includes(DELIVERY_FAILED_TAG)).length
}
