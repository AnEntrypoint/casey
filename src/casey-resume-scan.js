

import { tagList, tsMs } from './timestamp.js'
import { evData } from './safe.js'

export function completesTurn(ev) {

  if (ev?.kind === 'observation' && typeof ev.text === 'string' && ev.text.startsWith('TURN-HANDED-OFF:')) return true
  if (ev?.kind !== 'outbound' && ev?.kind !== 'draft') return false
  return evData(ev).guaranteedFallback !== true
}

export const RESUME_DEGRADED_RETRY_CAP = 5

export function resumeMaxAgeMs() {
  return Number(process.env.CASEY_RESUME_MAX_AGE_MS) || 24 * 60 * 60 * 1000
}

export function isResumeCandidate(c, { openStatuses, adapters }) {

  if (openStatuses.size && !openStatuses.has(c.status)) return false

  if (!adapters[c.channel]?.send) return false
  if (tagList(c).includes('resume-exhausted')) return false
  return true
}

export function scanTurnMarkers(events) {
  const started = new Map()
  const completedAfter = new Set()
  const attemptCount = new Map()
  const degradedCount = new Map()
  const startsSinceAttempt = new Map()
  for (const ev of events) {
    if (ev.kind === 'inbound' && ev.msg_id) started.set(ev.msg_id, ev)
    else if (ev.kind === 'observation' && typeof ev.text === 'string') {
      let m = ev.text.match(/^resume-attempted:(.+)$/)
      if (m) { attemptCount.set(m[1], (attemptCount.get(m[1]) || 0) + 1); startsSinceAttempt.set(m[1], 0) }
      m = ev.text.match(/^resume-degraded:(.+)$/)
      if (m) degradedCount.set(m[1], (degradedCount.get(m[1]) || 0) + 1)
      m = ev.text.match(/^TURN-START:(.+)$/)
      if (m && startsSinceAttempt.has(m[1])) startsSinceAttempt.set(m[1], startsSinceAttempt.get(m[1]) + 1)
    }

    if (completesTurn(ev)) {
      for (const id of started.keys()) completedAfter.add(id)
      startsSinceAttempt.clear()
    }
  }
  const interrupted = new Set([...startsSinceAttempt].filter(([, n]) => n > 0).map(([id]) => id))
  return { started, completedAfter, attemptCount, degradedCount, interrupted }
}

export function selectPendingTurn({ started, completedAfter, attemptCount, degradedCount, interrupted }, nowMs) {
  const maxAgeMs = resumeMaxAgeMs()
  let pending = null
  let anyCapped = false
  for (const [id, ev] of started) {
    if (completedAfter.has(id)) continue
    const attempts = attemptCount.get(id) || 0
    const wasAttempted = attempts > 0 && !interrupted.has(id)
    const degraded = degradedCount.get(id) || 0
    if (wasAttempted && degraded === 0) continue

    const ageMs = nowMs - (tsMs(ev.created_at) || nowMs)

    if (Math.max(attempts, degraded) >= RESUME_DEGRADED_RETRY_CAP || ageMs >= maxAgeMs) { anyCapped = true; continue }

    if (!pending || tsMs(ev.created_at) >= tsMs(pending.ev.created_at)) pending = { id, ev }
  }
  return { pending, anyCapped }
}
