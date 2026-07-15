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

// tagList/tsMs moved to timestamp.js (one shared implementation, was
// independently duplicated here/case-health.js/case-sweep.js).
import { tsMs, tagList } from './timestamp.js'

// Age in hours from the last-touch timestamp, relative to `now`. Tolerates a
// missing/corrupt timestamp (returns 0 -- a brand-new or unparseable case is not
// "old"), so a bad row never throws mid-sort.
function ageHours(c, now) {
  const t = tsMs(c?.updated_at || c?.created_at)
  if (!Number.isFinite(t) || !Number.isFinite(now)) return 0
  const h = (now - t) / 3.6e6
  return h > 0 ? h : 0
}

// Last-touch epoch ms, for the recency tiebreak. 0 when unparseable.
function touchMs(c) {
  const t = tsMs(c?.updated_at || c?.created_at)
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

// A case is "waiting on us" -- the contact has spoken and is now awaiting a human
// reply -- when status is `waiting`, or a tag marks an unanswered ask (needs-human,
// either handoff tier, or a draft sitting unsent). For those, the SLA clock is real:
// the contact is counting the minutes. A case casey is actively handling (auto, no
// such tag) is NOT waiting on us, so it has no SLA clock (returns null) rather than a
// misleading "waited 40m" when no one owes a reply.
const WAITING_TAGS = ['needs-human', 'health:unanswered_handoff', 'health:unanswered_handoff_escalated', 'unsent_draft', 'health:unsent_draft', 'draft-pending']
function waitingOnUs(c) {
  if (!c) return false
  if (c.status === 'resolved' || c.status === 'closed') return false
  const tags = tagList(c)
  if (tags.includes('opted-out')) return false
  if (c.status === 'waiting') return true
  return WAITING_TAGS.some(t => tags.includes(t))
}

// Milliseconds the contact has been waiting on a human reply, from the last touch.
// null when the case is not waiting on us (no SLA clock to show) or the timestamp is
// unparseable. Pure (case, now) like the rest of this module -- the last-touch epoch
// stands in for last-inbound, which is correct here because an inbound IS a touch and
// a case waiting-on-us has had no outbound since (an operator reply clears the wait
// state). A negative/zero age clamps to 0.
function waitAgeMs(c, now = Date.now()) {
  if (!waitingOnUs(c)) return null
  const t = touchMs(c)
  if (!t || !Number.isFinite(now)) return null
  const d = now - t
  return d > 0 ? d : 0
}

// How many open cases have been waiting on a human past the SLA target (default
// 30 min). Aggregate-only -- a single count for the team header, no per-contact rows.
function atRiskCount(cases, now = Date.now(), targetMs = 30 * 60 * 1000) {
  let n = 0
  for (const c of cases || []) {
    // A snoozed case is invisible in the inbox list (attnScore hides it below);
    // the at-risk header count must apply the same exemption or it reports a
    // number the operator cannot actually act on -- needs-human is never
    // snooze-exempted (a person was explicitly asked for), matching attnScore.
    const tags = tagList(c)
    const snooze = snoozedUntil(c)
    if (snooze && Number.isFinite(now) && now < snooze && !tags.includes('needs-human')) continue
    const w = waitAgeMs(c, now)
    if (w != null && w >= targetMs) n++
  }
  return n
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

// Single ordered state->{reason, todo} policy. ONE first-match-wins ladder feeds
// both the inbox "why" line (terse) and the detail "what to do now" line
// (actionable), so the two surfaces can never disagree about a case's state or
// contradict each other -- the bug of maintaining two parallel ladders with
// different branch orderings. Inbox-relevant states come first in the SAME order
// attnScore weights them (needs-human highest), so the worst-first sort and the
// reason line agree; the trailing states (opted-out/closed/resolved/waiting/new)
// never reach the inbox (they score 0) but DO show in the detail "to do" line, so
// they live at the end of the ladder where only caseHints(...).todo reads them.
// `now` is injected (default Date.now()) to keep the waiting-over-a-day branch a
// pure function for tests.
function caseHints(c, now = Date.now()) {
  const tags = tagList(c)
  // Detail-only terminal/quiet states first: these are not inbox reasons (they
  // score 0) but the detail line must still say the right thing about them.
  if (tags.includes('opted-out')) return { reason: 'This person asked to stop.', todo: 'This person asked to stop. Do not message them. Leave this one alone.' }
  if (c.status === 'closed') return { reason: 'This one is finished.', todo: 'This one is finished. Nothing to do.' }
  // Inbox states, in attnScore weight order so why-line and sort agree.
  if (tags.includes('needs-human')) return { reason: 'This person asked to talk to a real person.', todo: 'This person asked for a real person. Reply to them below.' }
  if (tags.includes('health:unanswered_handoff_escalated')) return { reason: 'A person was asked for a long time ago and still no one has replied. Please step in.', todo: 'A person was asked for a long time ago and still no one has replied. Step in below.' }
  if (tags.includes('health:unanswered_handoff')) return { reason: 'A person was asked for and no one has replied yet.', todo: 'A person was asked for and no one has replied. Reply below to take this one on.' }
  if (tags.includes('draft-pending') || tags.includes('unsent_draft') || tags.includes('health:unsent_draft')) return { reason: 'casey drafted a reply. Review it, then send or change it.', todo: 'casey prepared a reply but waits for a person. Check it, then send.' }
  if (tags.includes('health:incomplete_critical')) return { reason: 'Active case but the visit-critical facts are still missing. Reach the farmer now.', todo: 'The visit-critical facts are still missing and the case is active. Try to reach the farmer now -- once they leave the site some facts cannot be recovered.' }
  if (tags.includes('health:abandoned_intake')) return { reason: 'The farmer may have left. On-site facts are still missing.', todo: 'On-site facts are still missing and the farmer may be gone. Check if they are still reachable and ask for the most important detail (location or how to find the place).' }
  if (c.status === 'waiting' && ageHours(c, now) >= 24) return { reason: 'No answer for over a day. A check-in may help.', todo: 'No answer for over a day. A check-in may help -- reply below.' }
  if (tags.includes('health:stuck')) return { reason: 'This one has been in the same stage too long.', todo: 'This case has been in the same stage for a while. Check if it needs a push or can be closed.' }
  if (tags.includes('health:stale')) return { reason: 'No activity in a while. A check may be due.', todo: 'No activity for a while. Check if anything needs following up.' }
  if (c.autonomy === 'observe') return { reason: 'casey is only listening here. A reply has to come from you.', todo: 'This one is waiting for you. Read it and reply, or set Who answers to auto so casey can answer.' }
  if (c.autonomy === 'assisted') return { reason: 'casey can draft, but you send. Open it to check.', todo: 'casey can draft, but you send. Open it and check the draft.' }
  // Trailing detail-only states.
  if (c.status === 'resolved') return { reason: 'This one is marked done.', todo: 'This one is marked done. Close it if you are finished.' }
  if (c.status === 'waiting') return { reason: 'Waiting on the person to reply.', todo: 'Waiting on the person to reply. Nothing to do until they answer.' }
  if (c.status === 'new' || c.status === 'triaging') return { reason: 'A new message came in.', todo: 'A new message came in. casey is sorting it out.' }
  return { reason: 'This one is worth a look.', todo: 'casey is handling this one on its own. Step in only if you need to.' }
}

// One honest, plain reason this case is in the inbox. Thin wrapper over the
// shared policy so the inbox why-line and the detail to-do line never diverge.
function attnReason(c, now = Date.now()) { return caseHints(c, now).reason }

// Rank a set of cases worst-first. Returns [{ c, score, reason }] for cases that
// need attention (score > 0), sorted by score then recency. `cases` should be the
// open pool; closed/resolved score 0 and drop out anyway.
function rankAttention(cases, now = Date.now(), { limit = 0, offset = 0, slaTargetMs = 30 * 60 * 1000 } = {}) {
  const ranked = (cases || [])
    .map(c => ({ c, score: attnScore(c, now), reason: attnReason(c), waitMs: waitAgeMs(c, now) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || touchMs(b.c) - touchMs(a.c))
  const total = ranked.length
  // Aggregate at-risk count over the WHOLE open pool, not just the page slice, so the
  // team header is honest even when the operator is paging through the list.
  const atRisk = atRiskCount(cases, now, slaTargetMs)
  const sliced = limit > 0 ? ranked.slice(offset, offset + limit) : ranked.slice(offset)
  return { total, items: sliced, atRisk, slaTargetMs }
}

export { attnScore, attnReason, caseHints, rankAttention, tagList, ageHours, touchMs, waitAgeMs, atRiskCount, snoozedUntil }
