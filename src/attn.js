

import { tsMs, tagList, parseReport } from './timestamp.js'
import { healthTag } from './case-health.js'
import { OPTED_OUT_TAG } from './hooks/heuristics.js'
import { SEVERITY_SIGNAL_FIELDS } from './store/report-shape.js'
import { canQueryCases } from './contact-tiers.js'

function ageHours(c, now) {
  const t = tsMs(c?.last_event_at || c?.created_at)
  if (!Number.isFinite(t) || !Number.isFinite(now)) return 0
  const h = (now - t) / 3.6e6
  return h > 0 ? h : 0
}

function touchMs(c) {
  const t = tsMs(c?.last_event_at || c?.created_at)
  return Number.isFinite(t) ? t : 0
}

function snoozedUntil(c) {
  for (const t of tagList(c)) {
    if (t.startsWith('snoozed-until:')) {
      const v = parseInt(t.slice('snoozed-until:'.length), 10)
      if (Number.isFinite(v)) return v
    }
  }
  return null
}

const WAITING_TAGS = ['needs-human', healthTag('unanswered_handoff'), healthTag('unanswered_handoff_escalated'), 'unsent_draft', healthTag('unsent_draft'), 'draft-pending']
function waitingOnUs(c) {
  if (!c) return false
  if (c.status === 'resolved' || c.status === 'closed') return false
  const tags = tagList(c)
  if (tags.includes(OPTED_OUT_TAG)) return false
  if (c.status === 'waiting') return true
  return WAITING_TAGS.some(t => tags.includes(t))
}

function waitAgeMs(c, now = Date.now()) {
  if (!waitingOnUs(c)) return null
  const t = touchMs(c)
  if (!t || !Number.isFinite(now)) return null
  const d = now - t
  return d > 0 ? d : 0
}

function atRiskCount(cases, now = Date.now(), targetMs = 30 * 60 * 1000) {
  let n = 0
  for (const c of cases || []) {

    const tags = tagList(c)
    const snooze = snoozedUntil(c)
    if (snooze && Number.isFinite(now) && now < snooze && !tags.includes('needs-human')) continue
    const w = waitAgeMs(c, now)
    if (w != null && w >= targetMs) n++
  }
  return n
}

function attnScore(c, now = Date.now()) {
  if (!c) return 0
  if (c.status === 'resolved' || c.status === 'closed') return 0
  const tags = tagList(c)
  if (tags.includes(OPTED_OUT_TAG)) return 0

  const snooze = snoozedUntil(c)
  if (snooze && Number.isFinite(now) && now < snooze) {

    if (!tags.includes('needs-human')) return 0
  }
  let s = 0
  if (tags.includes('needs-human')) s += 100
  if (tags.includes(healthTag('unanswered_handoff'))) s += 60
  if (tags.includes(healthTag('unanswered_handoff_escalated'))) s += 80
  if (tags.includes(healthTag('incomplete_critical'))) s += 40
  if (tags.includes(healthTag('abandoned_intake'))) s += 35
  if (tags.includes(healthTag('premature_complete'))) s += 30
  if (tags.includes('unsent_draft') || tags.includes(healthTag('unsent_draft'))) s += 50
  if (tags.includes('draft-pending')) s += 50
  if (c.status === 'waiting' && ageHours(c, now) >= 24) s += 40
  if (tags.includes(healthTag('stuck'))) s += 20
  if (tags.includes(healthTag('stale'))) s += 10

  if (tags.includes(healthTag('timestamp_corrupt'))) s += 25

  if (tags.includes('degraded-turn-seen')) s += 12
  if (c.autonomy === 'observe') s += 20
  if (c.autonomy === 'assisted') s += 15
  if (c.priority === 'urgent') s += 15
  else if (c.priority === 'high') s += 8

  if (canQueryCases(c.reporter_tier)) s += 5

  if (SEVERITY_SIGNAL_FIELDS.length) {
    const rep = parseReport(c)
    const stated = (v) => {
      if (v == null) return false
      const text = String(v).trim()
      if (text === '') return false
      const n = Number(text)
      return !(Number.isFinite(n) && n === 0)
    }
    if (SEVERITY_SIGNAL_FIELDS.some(k => stated(rep[k]))) s += 7
  }
  s += Math.min(20, Math.floor(ageHours(c, now)))
  return s
}

function caseHints(c, now = Date.now()) {
  const tags = tagList(c)

  if (tags.includes(OPTED_OUT_TAG)) return { reason: 'This person asked to stop.', todo: 'This person asked to stop. Do not message them. Leave this one alone.' }
  if (c.status === 'closed') return { reason: 'This one is finished.', todo: 'This one is finished. Nothing to do.' }

  if (tags.includes('needs-human')) return { reason: 'This person asked to talk to a real person.', todo: 'This person asked for a real person. Reply to them below.' }
  if (tags.includes(healthTag('unanswered_handoff_escalated'))) return { reason: 'A person was asked for a long time ago and still no one has replied. Please step in.', todo: 'A person was asked for a long time ago and still no one has replied. Step in below.' }
  if (tags.includes(healthTag('unanswered_handoff'))) return { reason: 'A person was asked for and no one has replied yet.', todo: 'A person was asked for and no one has replied. Reply below to take this one on.' }
  if (tags.includes('draft-pending') || tags.includes('unsent_draft') || tags.includes(healthTag('unsent_draft'))) return { reason: 'The AI helper drafted a reply. Review it, then send or change it.', todo: 'The AI helper prepared a reply but waits for a person. Check it, then send.' }
  if (tags.includes(healthTag('incomplete_critical'))) return { reason: `Still active but the visit-critical facts are missing. Reach the reporter now.`, todo: 'The visit-critical facts are still missing and this one is still active. Try to reach the reporter now -- once they move on some facts cannot be recovered.' }
  if (tags.includes(healthTag('premature_complete'))) return { reason: 'The AI helper marked this done, but most of the visit facts are still blank. Worth a check.', todo: 'The conversation was marked complete, but most of the visit-critical facts were never recorded. Check the report -- it may need a follow-up message.' }
  if (tags.includes(healthTag('abandoned_intake'))) return { reason: 'The reporter may have moved on. On-site facts are still missing.', todo: 'On-site facts are still missing and the reporter may be gone. Check if they are still reachable and ask for the most important detail (location or how to find the place).' }
  if (c.status === 'waiting' && ageHours(c, now) >= 24) return { reason: 'No answer for over a day. A check-in may help.', todo: 'No answer for over a day. A check-in may help -- reply below.' }

  if (tags.includes(healthTag('timestamp_corrupt'))) return { reason: 'This one\'s own dates are unreadable, so nothing can tell how long it has been waiting.', todo: 'The stored dates on this one are unreadable, so the usual "going cold" and "stuck too long" checks never ran on it. Open it and judge it by its messages instead.' }
  if (tags.includes(healthTag('stuck'))) return { reason: 'This one has been in the same stage too long.', todo: 'This one has been in the same stage for a while. Check if it needs a push or can be closed.' }
  if (tags.includes(healthTag('stale'))) return { reason: 'No activity in a while. A check may be due.', todo: 'No activity for a while. Check if anything needs following up.' }

  if (c.autonomy === 'observe') return { reason: 'The AI helper is only listening here. A reply has to come from you.', todo: 'This one is waiting for you. Read it and reply, or set Who answers to "Answer on its own" so it can answer.' }
  if (c.autonomy === 'assisted') return { reason: 'The AI helper can draft, but you send. Open it to check.', todo: 'The AI helper can draft, but you send. Open it and check the draft.' }

  if (c.status === 'resolved') return { reason: 'This one is marked done.', todo: 'This one is marked done. Close it if you are finished.' }
  if (c.status === 'waiting') return { reason: 'Waiting on the person to reply.', todo: 'Waiting on the person to reply. Nothing to do until they answer.' }
  if (c.status === 'new' || c.status === 'triaging') return { reason: 'A new message came in.', todo: 'A new message came in. The AI helper is sorting it out.' }
  return { reason: 'This one is worth a look.', todo: 'The AI helper is handling this one on its own. Step in only if you need to.' }
}

function attnReason(c, now = Date.now()) { return caseHints(c, now).reason }

function rankAttention(cases, now = Date.now(), { limit = 0, offset = 0, slaTargetMs = 30 * 60 * 1000 } = {}) {
  const ranked = (cases || [])
    .map(c => ({ c, score: attnScore(c, now), reason: attnReason(c), waitMs: waitAgeMs(c, now) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || touchMs(b.c) - touchMs(a.c))
  const total = ranked.length

  const atRisk = atRiskCount(cases, now, slaTargetMs)
  const sliced = limit > 0 ? ranked.slice(offset, offset + limit) : ranked.slice(offset)
  return { total, items: sliced, atRisk, slaTargetMs }
}

export { rankAttention, tagList, atRiskCount, snoozedUntil }
