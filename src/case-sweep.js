

import { classifyCaseHealth, healthTag, ALL_HEALTH_TAGS, BREACH_LABEL, DEFAULT_THRESHOLDS } from './case-health.js'
import { flushDroppedIntake } from './hooks/dropped-intake.js'

import { tsMs, tagList } from './timestamp.js'

const HEALTH_SET = new Set(ALL_HEALTH_TAGS)

const writeFailureRetryAt = new Map()
const WRITE_FAILURE_RETRY_MS = 15 * 60_000

function detectCoverageGap(cases, eventsByCaseId, roster = [], now = Date.now(), { windowMs = 60 * 60 * 1000 } = {}) {
  const get = id => (eventsByCaseId?.get?.(id)) || (eventsByCaseId ? eventsByCaseId[id] : null) || []
  let openBreaches = 0
  let repliesInWindow = 0
  const windowStart = now - windowMs
  for (const c of cases || []) {
    if (c.status === 'closed' || c.status === 'resolved') continue
    const tags = tagList(c)
    if (!tags.some(t => HEALTH_SET.has(t))) continue
    openBreaches++
    for (const e of get(c.id)) {
      if (e.kind === 'outbound' && e.actor === 'operator') {
        const m = tsMs(e.created_at ?? e.ts)
        if (Number.isFinite(m) && m >= windowStart) repliesInWindow++
      }
    }
  }
  const rosterSize = Array.isArray(roster) ? roster.length : 0
  const gap = rosterSize > 0 && openBreaches > 0 && repliesInWindow === 0
  return {
    gap, open_breaches: openBreaches, replies_in_window: repliesInWindow,
    roster_size: rosterSize, window_ms: windowMs,
    reason: gap
      ? `${openBreaches} open case(s) need attention and no one on the team of ${rosterSize} has replied in the last ${Math.round(windowMs / 60000)} minutes`
      : '',
  }
}

export async function sweepCases(store, now = Date.now(), thresholds = DEFAULT_THRESHOLDS, { log = null, notifyBreach = null } = {}) {
  const summary = { scanned: 0, flagged: 0, cleared: 0, breaches: {}, errors: [] }

  try { flushDroppedIntake(store, log || console, now) } catch {  }

  const openStatuses = typeof store.getOpenStatuses === 'function' ? new Set(store.getOpenStatuses()) : null
  const effThresholds = openStatuses ? { ...thresholds, openStatuses } : thresholds

  const sweepOpenStatuses = typeof store.getOpenStatuses === 'function' ? store.getOpenStatuses() : null
  const cases = await store.listCases(sweepOpenStatuses ? { status: { $in: sweepOpenStatuses } } : {}, { limit: 10000 })

  if (cases.length >= 10000) log?.warn?.('[sweep] hit case-fetch cap; some cases may be unclassified', { fetched: cases.length })

  const openIds = new Set(cases.map(c => c.id))
  for (const id of writeFailureRetryAt.keys()) if (!openIds.has(id)) writeFailureRetryAt.delete(id)
  for (const c of cases) {

    if (c.status === 'closed' || c.channel === 'system') continue
    summary.scanned++
    let breaches
    try { breaches = classifyCaseHealth(c, now, effThresholds) }
    catch (e) {
      log?.warn?.('[sweep] classify failed', { caseId: c.id, error: e.message })
      summary.errors.push({ caseId: c.id, error: e.message, phase: 'classify' })

      if (summary.errors.length > 100) {
        log?.error?.('[sweep] aborted', { error_count: summary.errors.length, reason: 'too many errors, sweep halted for safety' })
        summary.errors.push({ phase: 'aborted', reason: 'too many errors, sweep halted for safety' })
        break
      }
      continue
    }
    if (summary.errors.length > 100) {
      log?.error?.('[sweep] aborted', { error_count: summary.errors.length, reason: 'too many errors, sweep halted for safety' })
      summary.errors.push({ phase: 'aborted', reason: 'too many errors, sweep halted for safety' })
      break
    }
    const desired = new Set(breaches.map(b => healthTag(b.breach)))

    const current = tagList(c)
    const currentHealth = new Set(current.filter(t => HEALTH_SET.has(t)))

    const keep = current.filter(t => !HEALTH_SET.has(t))
    const nextTags = [...keep, ...desired]

    const added = [...desired].filter(t => !currentHealth.has(t))
    const removed = [...currentHealth].filter(t => !desired.has(t))
    if (!added.length && !removed.length) continue

    const retryAt = writeFailureRetryAt.get(c.id)
    if (retryAt && now < retryAt) continue

    try {

      for (const b of breaches) {
        if (added.includes(healthTag(b.breach))) {
          await store.appendEvent(c.id, {
            kind: 'observation', actor: 'system', touch: false,

            text: `This report ${BREACH_LABEL[b.breach] || b.breach} -- ${b.detail}.`,
            data: { guardrail: b.breach, since_ms: b.since_ms },
          })
          summary.breaches[b.breach] = (summary.breaches[b.breach] || 0) + 1
          if (notifyBreach) {
            try { await notifyBreach(c.id, b.breach, b.detail) }
            catch (ne) { log?.warn?.('[sweep] notifyBreach failed', { caseId: c.id, breach: b.breach, error: ne.message }) }
          }
        }
      }

      let writeTags = nextTags
      let expectedVersion = c._version
      let conflictRetried = false
      for (;;) {
        try {
          await store.updateCaseQuiet(c.id, { tags: writeTags.join(',') }, undefined, { expectedVersion })
          break
        } catch (e) {
          if (e.code !== 'conflict' || conflictRetried) throw e
          conflictRetried = true
          const fresh = await store.getCase(c.id)
          if (!fresh) break

          const freshBreaches = classifyCaseHealth(fresh, now, effThresholds)
          const freshDesired = new Set(freshBreaches.map(b => healthTag(b.breach)))
          const freshCurrent = tagList(fresh)
          const freshKeep = freshCurrent.filter(t => !HEALTH_SET.has(t))
          writeTags = [...freshKeep, ...freshDesired]
          expectedVersion = fresh._version
        }
      }
      writeFailureRetryAt.delete(c.id)
      summary.flagged += added.length
      summary.cleared += removed.length
    } catch (e) {
      log?.warn?.('[sweep] reconcile failed', { caseId: c.id, error: e.message })
      summary.errors.push({ caseId: c.id, error: e.message })
      writeFailureRetryAt.set(c.id, now + WRITE_FAILURE_RETRY_MS)
    }
  }
  log?.info?.('[sweep] pass complete', summary)
  return summary
}

export { detectCoverageGap }
