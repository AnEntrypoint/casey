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

// caseId -> last-attempted-ms, for breaches whose updateCaseQuiet write keeps
// failing (a persistently locked/broken row). Without this, the observation +
// notifyBreach page above re-fires every sweep interval indefinitely while the
// write never succeeds (currentHealth is only ever updated on a SUCCESSFUL
// write, so "added" never shrinks) -- an unbounded duplicate/page storm rather
// than the intended "at worst one visible duplicate on retry". Gate re-attempts
// to once per this interval regardless of sweep cadence.
const writeFailureRetryAt = new Map()
const WRITE_FAILURE_RETRY_MS = 15 * 60_000

// Normalize a thatcher/ISO timestamp to epoch ms (thatcher persists unix-seconds as
// a number; events/ISO strings parse directly). Mirrors attn.js tsMs/case-health.js
// ms so every surface reads the same epoch. NaN when unknown.
function tsMs(raw) {
  if (raw == null || raw === '') return NaN
  if (typeof raw === 'number') return raw < 1e12 ? raw * 1000 : raw
  // The store hands back a numeric timestamp as a STRING ("1782977388" --
  // busybase binds values as text); Date.parse on a bare digit string is NaN,
  // so coerce all-digit strings to a number first (matches attn.js tsMs /
  // case-health.js ms / format.js toDate). Without this, an operator reply
  // whose created_at is a numeric string is dropped from the coverage window,
  // producing a false TEAM-COVERAGE page while operators are in fact replying.
  if (/^\d+$/.test(String(raw))) { const n = Number(raw); return n < 1e12 ? n * 1000 : n }
  const t = Date.parse(raw)
  return Number.isNaN(t) ? NaN : t
}

// Coverage gap: a TEAM-level signal distinct from a per-case breach. The per-case
// path pages when one case breaches; this fires when the WHOLE roster is idle while
// breaches pile up -- nobody is covering, so the team-lead must be paged even though
// each individual case is already (separately) flagged. The condition is deliberately
// conservative: at least one open case carries a health:* breach tag AND zero operator
// replies (outbound, actor=operator) landed anywhere in the coverage window. A roster
// of zero is treated as "no one is expected to cover", so an unstaffed deployment does
// not page on every quiet hour -- the gap needs someone who SHOULD be replying.
// "Replies-in-window" counts operator outbound ON THE BREACHING CASES ONLY: a reply to
// some unrelated open case is not the team covering the breaches that are piling up, so
// only a reply touching a flagged case clears the gap.
// Pure (inputs, now): the caller owns the page + the once-only dedup.
function detectCoverageGap(cases, eventsByCaseId, roster = [], now = Date.now(), { windowMs = 60 * 60 * 1000 } = {}) {
  const get = id => (eventsByCaseId?.get?.(id)) || (eventsByCaseId ? eventsByCaseId[id] : null) || []
  let openBreaches = 0
  let repliesInWindow = 0
  const windowStart = now - windowMs
  for (const c of cases || []) {
    if (c.status === 'closed' || c.status === 'resolved') continue
    const tags = String(c.tags || '').split(',').map(s => s.trim()).filter(Boolean)
    if (!tags.some(t => HEALTH_SET.has(t))) continue   // only breaching cases bear on the gap
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

// Run one full pass. Pure-ish: all mutation goes through the store, `now` is
// injected. Returns a summary { scanned, flagged, cleared, breaches:{type:count} }.
export async function sweepCases(store, now = Date.now(), thresholds = DEFAULT_THRESHOLDS, { log = null, notifyBreach = null } = {}) {
  const summary = { scanned: 0, flagged: 0, cleared: 0, breaches: {}, errors: [] }
  // Prefer the live workflow's open-stage set over case-health.js's literal
  // fallback, so a stage added/renamed in thatcher.config.yml is picked up with
  // no code edit here.
  const openStatuses = typeof store.getOpenStatuses === 'function' ? new Set(store.getOpenStatuses()) : null
  const effThresholds = openStatuses ? { ...thresholds, openStatuses } : thresholds
  // activeWorkStatuses/visitCritical, when present on `thresholds` (see
  // thresholds.js mergeThresholds), ride straight through -- classifyCaseHealth
  // reads them off effThresholds with its own literal fallback, same pattern as
  // openStatuses above.
  // Only open cases can be unhealthy; a closed case is finished. listCases with no
  // filter returns recency-sorted; we classify each and skip closed defensively.
  const cases = await store.listCases({}, { limit: 10000 })
  for (const c of cases) {
    // The settings/fleet-health/shift singleton pseudo-cases (channel:'system',
    // created by CaseStore's internal bookkeeping) are not farmer reports -- they
    // have no report, no real contact, and no operator ever replies to them, so
    // classifyCaseHealth's staleness/abandonment rules would misfire on them and
    // notifyBreach would page the on-call team about a case that does not exist.
    if (c.status === 'closed' || c.channel === 'system') continue
    summary.scanned++
    let breaches
    try { breaches = classifyCaseHealth(c, now, effThresholds) }
    catch (e) { log?.warn?.('[sweep] classify failed', { caseId: c.id, error: e.message }); summary.errors.push({ caseId: c.id, error: e.message, phase: 'classify' }); continue }
    if (summary.errors.length > 100) {
      log?.error?.('[sweep] aborted', { error_count: summary.errors.length, reason: 'too many errors, sweep halted for safety' })
      summary.errors.push({ phase: 'aborted', reason: 'too many errors, sweep halted for safety' })
      break
    }
    const desired = new Set(breaches.map(b => healthTag(b.breach)))

    const current = String(c.tags || '').split(',').map(s => s.trim()).filter(Boolean)
    const currentHealth = new Set(current.filter(t => HEALTH_SET.has(t)))
    // Preserve every non-health tag exactly; reconcile only the health:* set.
    const keep = current.filter(t => !HEALTH_SET.has(t))
    const nextTags = [...keep, ...desired]

    const added = [...desired].filter(t => !currentHealth.has(t))
    const removed = [...currentHealth].filter(t => !desired.has(t))
    if (!added.length && !removed.length) continue   // nothing changed for this case

    // A prior pass already tried (and failed) to persist this exact change
    // recently -- skip re-appending/re-paging until the retry interval elapses,
    // so a persistently failing write degrades to bounded periodic retries
    // instead of an unbounded per-sweep-interval spam.
    const retryAt = writeFailureRetryAt.get(c.id)
    if (retryAt && now < retryAt) continue

    try {
      // Append the observation(s) BEFORE writing the health tags. The tag is the
      // dedup key ("one observation per newly-entered breach"), so if the tag
      // write succeeded but the observation failed, the next pass would see the
      // tag already present and never append -- a silently missing observation.
      // Doing the event first means a partial failure costs at worst a visible
      // duplicate observation on retry, never a silent loss (P9).
      for (const b of breaches) {
        if (added.includes(healthTag(b.breach))) {
          await store.appendEvent(c.id, {
            kind: 'observation', actor: 'system', touch: false,
            text: `GUARDRAIL [${b.breach}]: ${b.detail}. Needs attention.`,
            data: { guardrail: b.breach, since_ms: b.since_ms },
          })
          summary.breaches[b.breach] = (summary.breaches[b.breach] || 0) + 1
          if (notifyBreach) {
            try { await notifyBreach(c.id, b.breach, b.detail) }
            catch (ne) { log?.warn?.('[sweep] notifyBreach failed', { caseId: c.id, breach: b.breach, error: ne.message }) }
          }
        }
      }
      // Quiet update: setting health tags must NOT touch last_event_at, or the
      // sweep would make every stale case it flags look freshly active.
      await store.updateCaseQuiet(c.id, { tags: nextTags.join(',') })
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
