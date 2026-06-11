// case-sweep.js  --  the periodic guardrail pass.
//
// classifyCaseHealth says what is wrong with one case at one instant; the sweep
// applies that across every open case and makes it OBSERVABLE and IDEMPOTENT:
// - desired health tags are recomputed from scratch each pass (execute-and-
//     inhibit -- never conditionally skip, always diff the full set), so a tag is
//     added when a breach starts and CLEARED when it resolves;
// - exactly one observation is appended when a breach is newly entered, never
//     re-spammed on subsequent passes while it persists;
// - only health:* tags are touched -- agent/operator tags (needs-human, merged,
//     split, ...) are preserved, never clobbered.
// A leaked or runaway sweep is itself an over-time failure, so the scheduler that
// drives this (casey.js) owns the interval and clears it on stop.

import { classifyCaseHealth, healthTag, ALL_HEALTH_TAGS, DEFAULT_THRESHOLDS } from './case-health.js'

const HEALTH_SET = new Set(ALL_HEALTH_TAGS)

// Run one full pass. Pure-ish: all mutation goes through the store, `now` is
// injected. Returns a summary { scanned, flagged, cleared, breaches:{type:count} }.
export async function sweepCases(store, now = Date.now(), thresholds = DEFAULT_THRESHOLDS, { log = null } = {}) {
  const summary = { scanned: 0, flagged: 0, cleared: 0, breaches: {} }
  // Only open cases can be unhealthy; a closed case is finished. listCases with no
  // filter returns recency-sorted; we classify each and skip closed defensively.
  const cases = await store.listCases({}, { limit: 10000 })
  for (const c of cases) {
    if (c.status === 'closed') continue
    summary.scanned++
    let breaches
    try { breaches = classifyCaseHealth(c, now, thresholds) }
    catch (e) { log?.warn?.('[sweep] classify failed', { caseId: c.id, error: e.message }); continue }
    const desired = new Set(breaches.map(b => healthTag(b.breach)))

    const current = String(c.tags || '').split(',').map(s => s.trim()).filter(Boolean)
    const currentHealth = new Set(current.filter(t => HEALTH_SET.has(t)))
    // Preserve every non-health tag exactly; reconcile only the health:* set.
    const keep = current.filter(t => !HEALTH_SET.has(t))
    const nextTags = [...keep, ...desired]

    const added = [...desired].filter(t => !currentHealth.has(t))
    const removed = [...currentHealth].filter(t => !desired.has(t))
    if (!added.length && !removed.length) continue   // nothing changed for this case

    try {
      // Quiet update: setting health tags must NOT touch last_event_at, or the
      // sweep would make every stale case it flags look freshly active.
      await store.updateCaseQuiet(c.id, { tags: nextTags.join(',') })
      // One observation per NEWLY entered breach -- not on every pass it persists.
      for (const b of breaches) {
        if (added.includes(healthTag(b.breach))) {
          await store.appendEvent(c.id, {
            kind: 'observation', actor: 'system', touch: false,
            text: `GUARDRAIL [${b.breach}]: ${b.detail}. Needs attention.`,
            data: { guardrail: b.breach, since_ms: b.since_ms },
          })
          summary.breaches[b.breach] = (summary.breaches[b.breach] || 0) + 1
        }
      }
      summary.flagged += added.length
      summary.cleared += removed.length
    } catch (e) {
      log?.warn?.('[sweep] reconcile failed', { caseId: c.id, error: e.message })
    }
  }
  log?.info?.('[sweep] pass complete', summary)
  return summary
}
