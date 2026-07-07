// Per-operator workload + accountability rollup over the case + event history.
// Pure and deterministic, in the mould of src/overview.js: given the case rows,
// their events, the operator roster, and `now`, it returns one aggregate card per
// operator -- how much each person is holding and how responsive they have been --
// so management sees overload and staleness at a glance without opening a case.
//
// Aggregate-only: no per-contact rows and no external_id ever leave here. Stored
// event times are unix SECONDS; every duration returned is MILLISECONDS so the
// SAST formatters and the ms threshold config agree (same contract as overview.js).
//
// Attribution model (cooperative, set elsewhere in the app, only read here):
//   - a case carries `assignee` = an operator id once claimed.
//   - an operator reply is an event { kind:'outbound', actor:'operator', data.by }.
//   - the `agent`/empty assignee is the unclaimed pseudo-owner, never a person.

import { median, firstResponseMs, evData } from './overview.js'
import { tagList, snoozedUntil } from './attn.js'

const SEC = 1000

// created_at is unix seconds -> ms, or null if missing/corrupt (never throws).
function evMs(e) {
  const v = e?.created_at
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n * SEC : null
}

// Newest event time on a case, in ms, or the case created_at, or null.
function lastActivityMs(caseRow, events) {
  let max = evMs({ created_at: caseRow?.created_at })
  for (const e of events || []) {
    const m = evMs(e)
    if (m != null && (max == null || m > max)) max = m
  }
  return max
}

// An owner string that names a real person, else '' (unclaimed / the agent).
function personOwner(caseRow) {
  const a = String(caseRow?.assignee || '').trim()
  return a && a !== 'agent' ? a : ''
}

// Build the workload rollup. `cases` are the rows; `eventsByCaseId` maps
// id -> events[]; `roster` is [{id,name}] from parseOperators (may be empty);
// `staleMs` is how long an open claimed case may sit untouched before it counts
// as a stale claim (default 24h). Returns { now, stale_ms, operators: [card...] }
// sorted worst-first: most stale claims, then most open, so the card that needs
// management attention is first.
export function buildWorkload(cases, eventsByCaseId, roster = [], now = Date.now(), staleMs = 24 * 3600 * SEC) {
  // Seed a card per rostered operator so a configured-but-idle person shows zeros
  // rather than vanishing. Cards are keyed by operator id.
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

  const replyWindowStart = now - 24 * 3600 * SEC

  for (const c of cases || []) {
    const events = eventsByCaseId.get?.(c.id) || eventsByCaseId[c.id] || []
    const isClosed = c.status === 'resolved' || c.status === 'closed'

    // Replies sent in the last 24h, attributed to the operator who sent them.
    // Read from events regardless of who currently owns the case, so a person
    // gets credit for answering even a case later reassigned.
    for (const e of events) {
      if (e.kind === 'outbound' && e.actor === 'operator') {
        const by = String(evData(e).by || '').trim()
        if (!by) continue
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
      // A deliberately snoozed case (an operator who can't finish it yet, not a
      // dropped one) must not count as a stale claim -- same exemption attn.js's
      // attnScore already applies, needs-human never exempted (a person was
      // explicitly asked for).
      const snooze = snoozedUntil(c)
      const isSnoozed = snooze && Number.isFinite(now) && now < snooze && !tagList(c).includes('needs-human')
      if (waited != null && waited >= staleMs && !isSnoozed) k.stale_claims++
      // Oldest still-open case this person holds, by time since last activity.
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
    return k
  })
  // Worst-first: stale claims dominate (a dropped case is the real failure),
  // then raw open load, then oldest-waiting as the final tie-break.
  operators.sort((a, b) =>
    (b.stale_claims - a.stale_claims) ||
    (b.open_assigned - a.open_assigned) ||
    ((b.oldest_waiting_ms || 0) - (a.oldest_waiting_ms || 0)))

  return { now, stale_ms: staleMs, operators }
}
