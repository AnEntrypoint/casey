// Attention ranking: which open cases need a HUMAN now, and why, in plain words.
// Deterministic, enum-derived (status/autonomy/tags/age); no LLM. Higher = more
// urgent. Lifted out of the dashboard SPA string so the SAME scoring runs
// server-side over ALL open cases (not just the page window the client fetched)
// and is shared by the dashboard, the CLI inbox, and the mobile view. The SPA
// re-injects attnScore/attnReason from here verbatim, so the two surfaces can
// never drift.
//
// `now` is passed in (never read from the clock here) so the score is a pure
// function of (case, now) -- testable and identical on every caller.

function tagList(c) {
  return String(c?.tags || '').split(',').map(t => t.trim()).filter(Boolean)
}

// Age in hours from the last-touch timestamp, relative to `now`. Tolerates a
// missing/corrupt timestamp (returns 0 -- a brand-new or unparseable case is not
// "old"), so a bad row never throws mid-sort.
function ageHours(c, now) {
  const raw = c?.updated_at || c?.created_at
  const t = raw ? Date.parse(raw) : NaN
  if (!Number.isFinite(t) || !Number.isFinite(now)) return 0
  const h = (now - t) / 3.6e6
  return h > 0 ? h : 0
}

// Last-touch epoch ms, for the recency tiebreak. 0 when unparseable.
function touchMs(c) {
  const raw = c?.updated_at || c?.created_at
  const t = raw ? Date.parse(raw) : NaN
  return Number.isFinite(t) ? t : 0
}

// Parse a snoozed-until:<epoch-ms> tag, if present. Returns the epoch or null.
function snoozedUntil(c) {
  for (const t of tagList(c)) {
    if (t.startsWith('snoozed-until:')) {
      const v = parseInt(t.slice('snoozed-until:'.length), 10)
      if (Number.isFinite(v)) return v
    }
  }
  return null
}

// attnScore: 0 means "no human action needed" (hidden from the inbox).
function attnScore(c, now = Date.now()) {
  if (!c) return 0
  if (c.status === 'resolved' || c.status === 'closed') return 0
  const tags = tagList(c)
  if (tags.includes('opted-out')) return 0            // contact left; never chase them
  // Snooze: a case an operator has seen but cannot finish yet drops out of the
  // inbox until the snooze expires -- UNLESS a newer inbound arrived after the
  // snooze was set (a fresh message un-snoozes). We approximate "set time" by the
  // snooze epoch itself: if the case was touched at/after the snooze target the
  // snooze is moot. Conservatively, a future snooze with no newer touch hides it.
  const snooze = snoozedUntil(c)
  if (snooze && Number.isFinite(now) && now < snooze) {
    // needs-human is never silently hidden: a person was explicitly asked for.
    if (!tags.includes('needs-human')) return 0
  }
  let s = 0
  if (tags.includes('needs-human')) s += 100              // contact explicitly asked for a person
  if (tags.includes('health:unanswered_handoff')) s += 60 // handoff request, no operator in window
  if (tags.includes('health:unanswered_handoff_escalated')) s += 80 // escalated: still no reply
  if (tags.includes('health:incomplete_critical')) s += 40 // active case, visit-critical facts still missing
  if (tags.includes('health:abandoned_intake')) s += 35    // stalled, on-site facts likely unrecoverable
  if (tags.includes('unsent_draft') || tags.includes('health:unsent_draft')) s += 50 // a drafted reply is waiting to be approved
  if (tags.includes('draft-pending')) s += 50              // assisted draft awaiting operator approval
  if (c.status === 'waiting' && ageHours(c, now) >= 24) s += 40 // genuinely stuck over a day
  if (tags.includes('health:stuck')) s += 20
  if (tags.includes('health:stale')) s += 10
  if (c.autonomy === 'observe') s += 20                    // casey only listens; soft nudge
  if (c.autonomy === 'assisted') s += 15                   // person in the loop; soft nudge
  if (c.priority === 'urgent') s += 15
  else if (c.priority === 'high') s += 8
  s += Math.min(20, Math.floor(ageHours(c, now)))
  return s
}

// One honest, plain reason this case is in the inbox. First match wins.
function attnReason(c) {
  const tags = tagList(c)
  if (tags.includes('needs-human')) return 'This person asked to talk to a real person.'
  if (tags.includes('draft-pending') || tags.includes('unsent_draft') || tags.includes('health:unsent_draft')) return 'casey drafted a reply. Review it, then send or change it.'
  if (tags.includes('health:unanswered_handoff_escalated')) return 'A person was asked for a long time ago and still no one has replied. Please step in.'
  if (tags.includes('health:unanswered_handoff')) return 'A person was asked for and no one has replied yet.'
  if (tags.includes('health:incomplete_critical')) return 'Active case but the visit-critical facts are still missing. Reach the farmer now.'
  if (tags.includes('health:abandoned_intake')) return 'The farmer may have left. On-site facts are still missing.'
  if (c.status === 'waiting' && ageHours(c, Date.now()) >= 24) return 'No answer for over a day. A check-in may help.'
  if (tags.includes('health:stuck')) return 'This one has been in the same stage too long.'
  if (tags.includes('health:stale')) return 'No activity in a while. A check may be due.'
  if (c.autonomy === 'observe') return 'casey is only listening here. A reply has to come from you.'
  if (c.autonomy === 'assisted') return 'casey can draft, but you send. Open it to check.'
  return 'This one is worth a look.'
}

// Rank a set of cases worst-first. Returns [{ c, score, reason }] for cases that
// need attention (score > 0), sorted by score then recency. `cases` should be the
// open pool; closed/resolved score 0 and drop out anyway.
function rankAttention(cases, now = Date.now(), { limit = 0, offset = 0 } = {}) {
  const ranked = (cases || [])
    .map(c => ({ c, score: attnScore(c, now), reason: attnReason(c) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || touchMs(b.c) - touchMs(a.c))
  const total = ranked.length
  const sliced = limit > 0 ? ranked.slice(offset, offset + limit) : ranked.slice(offset)
  return { total, items: sliced }
}

export { attnScore, attnReason, rankAttention, tagList, ageHours, touchMs, snoozedUntil }
