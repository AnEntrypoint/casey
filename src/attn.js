

import { tsMs, tagList, parseReport } from './timestamp.js'
import { healthTag } from './case-health.js'
import { OPTED_OUT_TAG } from './hooks/heuristics.js'
import { SEVERITY_SIGNAL_FIELDS } from './store/report-shape.js'
import { canQueryCases } from './contact-tiers.js'
import { caseyText } from './deployment-text.js';

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

  if (tags.includes(OPTED_OUT_TAG)) return { reason: caseyText("src/attn.js#w0"), todo: caseyText("src/attn.js#w1") }
  if (c.status === 'closed') return { reason: caseyText("src/attn.js#w2"), todo: caseyText("src/attn.js#w3") }

  if (tags.includes('needs-human')) return { reason: caseyText("src/attn.js#w4"), todo: caseyText("src/attn.js#w5") }
  if (tags.includes(healthTag('unanswered_handoff_escalated'))) return { reason: caseyText("src/attn.js#w6"), todo: caseyText("src/attn.js#w7") }
  if (tags.includes(healthTag('unanswered_handoff'))) return { reason: caseyText("src/attn.js#w8"), todo: caseyText("src/attn.js#w9") }
  if (tags.includes('draft-pending') || tags.includes('unsent_draft') || tags.includes(healthTag('unsent_draft'))) return { reason: caseyText("src/attn.js#w10"), todo: caseyText("src/attn.js#w11") }
  if (tags.includes(healthTag('incomplete_critical'))) return { reason: caseyText("src/attn.js#w12"), todo: caseyText("src/attn.js#w13") }
  if (tags.includes(healthTag('premature_complete'))) return { reason: caseyText("src/attn.js#w14"), todo: caseyText("src/attn.js#w15") }
  if (tags.includes(healthTag('abandoned_intake'))) return { reason: caseyText("src/attn.js#w16"), todo: caseyText("src/attn.js#w17") }
  if (c.status === 'waiting' && ageHours(c, now) >= 24) return { reason: caseyText("src/attn.js#w18"), todo: caseyText("src/attn.js#w19") }

  if (tags.includes(healthTag('timestamp_corrupt'))) return { reason: caseyText("src/attn.js#w20"), todo: caseyText("src/attn.js#w21") }
  if (tags.includes(healthTag('stuck'))) return { reason: caseyText("src/attn.js#w22"), todo: caseyText("src/attn.js#w23") }
  if (tags.includes(healthTag('stale'))) return { reason: caseyText("src/attn.js#w24"), todo: caseyText("src/attn.js#w25") }

  if (c.autonomy === 'observe') return { reason: caseyText("src/attn.js#w26"), todo: caseyText("src/attn.js#w27") }
  if (c.autonomy === 'assisted') return { reason: caseyText("src/attn.js#w28"), todo: caseyText("src/attn.js#w29") }

  if (c.status === 'resolved') return { reason: caseyText("src/attn.js#w30"), todo: caseyText("src/attn.js#w31") }
  if (c.status === 'waiting') return { reason: caseyText("src/attn.js#w32"), todo: caseyText("src/attn.js#w33") }
  if (c.status === 'new' || c.status === 'triaging') return { reason: caseyText("src/attn.js#w34"), todo: caseyText("src/attn.js#w35") }
  return { reason: caseyText("src/attn.js#w36"), todo: caseyText("src/attn.js#w37") }
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
