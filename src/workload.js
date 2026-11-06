

import { median, firstResponseMs, evData } from './overview.js'
import { tagList, snoozedUntil } from './attn.js'
import { isOpenCase } from './format.js'
import { UNCLAIMED_ASSIGNEE } from './case-store.js'

const SEC = 1000

function evMs(e) {
  const v = e?.created_at
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n * SEC : null
}

function lastActivityMs(caseRow, events) {
  let max = evMs({ created_at: caseRow?.created_at })
  for (const e of events || []) {
    const m = evMs(e)
    if (m != null && (max == null || m > max)) max = m
  }
  return max
}

function personOwner(caseRow) {
  const a = String(caseRow?.assignee || '').trim()
  return a && a !== UNCLAIMED_ASSIGNEE ? a : ''
}

export function buildWorkload(cases, eventsByCaseId, roster = [], now = Date.now(), staleMs = 24 * 3600 * SEC) {

  const cards = new Map()
  const card = (id, name) => {
    if (!cards.has(id)) {
      cards.set(id, {
        id, name: name || id,
        open_assigned: 0, stale_claims: 0, replies_24h: 0,
        first_reply_ms_median: null, oldest_waiting_ms: null,
        _firstReplies: [],
      })
    }
    return cards.get(id)
  }
  for (const r of roster || []) card(r.id, r.name)
  const rosterIds = new Set((roster || []).map(r => r.id))

  const replyWindowStart = now - 24 * 3600 * SEC

  for (const c of cases || []) {
    const events = eventsByCaseId.get?.(c.id) || eventsByCaseId[c.id] || []
    const isClosed = !isOpenCase(c)

    for (const e of events) {
      if (e.kind === 'outbound' && e.actor === 'operator') {
        const d = evData(e)

        const by = d.staff_contact_id ? `contact:${d.staff_contact_id}` : String(d.by || '').trim()
        if (!by || !rosterIds.has(by)) continue
        const m = evMs(e)
        if (m != null && m >= replyWindowStart) card(by).replies_24h++
      }
    }

    const owner = personOwner(c)
    if (owner && !isClosed) {
      const k = card(owner)
      k.open_assigned++
      const last = lastActivityMs(c, events)
      const waited = last != null ? now - last : null

      const snooze = snoozedUntil(c)
      const isSnoozed = snooze && Number.isFinite(now) && now < snooze && !tagList(c).includes('needs-human')
      if (waited != null && waited >= staleMs && !isSnoozed) k.stale_claims++

      if (waited != null && (k.oldest_waiting_ms == null || waited > k.oldest_waiting_ms)) {
        k.oldest_waiting_ms = waited
      }
      const fr = firstResponseMs(events)
      if (fr != null) k._firstReplies.push(fr)
    }
  }

  const operators = [...cards.values()].map(k => {
    k.first_reply_ms_median = median(k._firstReplies)
    delete k._firstReplies

    if (k.id.startsWith('contact:')) k.id = k.name
    return k
  })

  operators.sort((a, b) =>
    (b.stale_claims - a.stale_claims) ||
    (b.open_assigned - a.open_assigned) ||
    ((b.oldest_waiting_ms || 0) - (a.oldest_waiting_ms || 0)))

  return { now, stale_ms: staleMs, operators }
}
