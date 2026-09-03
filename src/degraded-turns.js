// degraded-turns.js -- turn failure tracking and observability
//
// Captures failed turns (timeout, provider down, retry exhausted, LLM refusal)
// and provides aggregation/query for the /api/turns/degraded endpoint.
//
// Write-shape contract (must match GET /api/turns/degraded, operations.js, and
// the direct appendEvent call sites in hooks/handler.js -- there is exactly one
// convention, not two): kind:'observation', actor:'system', data.degraded_turn
// === true (boolean, not a string), data.reason, plus contact_id/turn_ts here
// for the per-contact rollup queryDegradedTurns() below. `data` is passed as a
// plain object -- case-store.js's appendEvent() already does the ONE
// JSON.stringify on write (case-store.js line ~1408); stringifying here too
// double-encodes it, so a read-edge JSON.parse (safe.js evData()) yields a
// STRING back, not an object, silently losing every field. This previously
// used kind:'degraded_turn' with a pre-stringified `data`, which /api/turns/
// degraded's listAllEvents({kind:'observation', actor:'system'}) query could
// never see and evData() could never parse back to a real object even if it
// had -- the single largest degraded-turn path (hooks/handler.js's terminal
// guaranteed-response fallback) was writing an event no endpoint could ever
// read. Confirmed live via a real recordDegradedTurn() call against a store
// double replicating case-store.js's real appendEvent contract.

import { tsMs } from './timestamp.js'
import { evData } from './safe.js'

// Reason enum: matches the classification at the recording point
const FAILURE_REASONS = Object.freeze({
  PROVIDER: 'provider',           // acptoapi unreachable or returns error
  TIMEOUT: 'timeout',             // turn exceeded TURN_HARD_DEADLINE_MS
  RETRY_EXHAUSTED: 'retry-exhausted',  // all retries failed
  LLM_REFUSAL: 'llm-refusal',     // model refused to produce tool call (refusal/partial/blocked)
})

// Record a degraded turn event when a turn fails
export async function recordDegradedTurn(store, { caseId, contactId, reason, turnStartMs, channel }) {
  if (!store || !caseId || !contactId || !FAILURE_REASONS[reason?.toUpperCase().replace(/-/g, '_')]) {
    return null
  }
  try {
    const normalizedReason = Object.entries(FAILURE_REASONS).find(
      ([k, v]) => v === reason || k === reason?.toUpperCase().replace(/-/g, '_')
    )?.[1] || reason
    const event = await store.appendEvent(caseId, {
      kind: 'observation',
      actor: 'system',
      channel: channel || 'other',
      text: `Turn degraded: ${normalizedReason}`,
      data: {
        degraded_turn: true,
        contact_id: contactId,
        reason: normalizedReason,
        turn_ts: turnStartMs || Date.now(),
        recovery_ts: null,  // Updated on next successful turn
      },
    })
    return event
  } catch (e) {
    // Best-effort: never block the handler on event append failure
    return null
  }
}

// Query degraded turns for the /api/turns/degraded endpoint
// Aggregates recent failures with per-contact rollup
export async function queryDegradedTurns(store, { hours = 24, limit = 100 } = {}) {
  if (!store || typeof store.listAllEvents !== 'function') {
    return { turns: [], summary: { total: 0, last_failure_at: null, failures_in_last_hour: 0, by_reason: {} } }
  }

  const now = Date.now()
  const windowMs = hours * 3600000
  const thresholdMs = now - windowMs
  const lastHourMs = now - 3600000

  try {
    // Cross-case fetch: listEvents(caseId, ...) is scoped to ONE case (it
    // builds a where:{case_id} clause) -- passing null does not mean "every
    // case", it means "case_id === null", which matches nothing. listAllEvents
    // is the real cross-case query (case-store.js), pre-filtered server-side
    // to the observation/system rows this convention actually writes so the
    // over-fetch stays bounded the same way /api/turns/degraded's own route
    // already does.
    const { rows: allEvents } = await store.listAllEvents({ kind: 'observation', actor: 'system' }, { limit: 50000 }).catch(() => ({ rows: [] }))

    const degradedEvents = []
    const byReason = {}
    let lastFailureAt = null
    let lastHourCount = 0

    for (const event of allEvents) {
      // created_at is thatcher's unix-SECONDS convention (case-store.js
      // appendEvent), not ISO -- tsMs is the shared digit-string-aware
      // parser (timestamp.js); a bare `new Date(seconds).getTime()` here
      // previously misread every timestamp by a factor of 1000.
      const createdMs = tsMs(event.created_at)
      if (!Number.isFinite(createdMs) || createdMs < thresholdMs) continue

      const data = evData(event)
      if (data.degraded_turn !== true) continue

      degradedEvents.push({ event, createdMs, data })

      const reason = data.reason || 'unknown'
      byReason[reason] = (byReason[reason] || 0) + 1

      if (lastFailureAt == null || createdMs > lastFailureAt) lastFailureAt = createdMs
      if (createdMs > lastHourMs) lastHourCount += 1
    }

    // Group by contact and reason, keeping most recent
    const byContact = new Map()
    for (const { event, createdMs, data } of degradedEvents) {
      const contactId = data.contact_id || 'unknown'
      const reason = data.reason || 'unknown'
      const key = `${contactId}:${reason}`

      if (!byContact.has(key)) {
        byContact.set(key, { contact_id: contactId, reason, count: 0, last_at: event.created_at, last_at_ms: createdMs })
      }
      const entry = byContact.get(key)
      entry.count += 1
      if (createdMs > entry.last_at_ms) {
        entry.last_at = event.created_at
        entry.last_at_ms = createdMs
      }
    }

    const turns = Array.from(byContact.values())
      .sort((a, b) => b.last_at_ms - a.last_at_ms)
      .slice(0, limit)
      .map(({ last_at_ms, ...rest }) => rest)

    return {
      turns,
      summary: {
        total: degradedEvents.length,
        last_failure_at: lastFailureAt,
        failures_in_last_hour: lastHourCount,
        by_reason: byReason,
      },
    }
  } catch (e) {
    return { turns: [], summary: { total: 0, last_failure_at: null, failures_in_last_hour: 0, by_reason: {} } }
  }
}

// Calculate degradation rate: (degraded_turns_last_hour / total_turns_last_hour) * 100
export async function calculateDegradationRate(store, { hours = 1 } = {}) {
  if (!store || typeof store.listAllEvents !== 'function') return { rate: 0, degraded_count: 0, total_count: 0 }

  try {
    const now = Date.now()
    const windowMs = hours * 3600000
    const thresholdMs = now - windowMs

    // Two separate cross-case fetches, each pre-filtered server-side to the
    // rows this calculation actually needs (mirrors queryDegradedTurns' own
    // listAllEvents usage) rather than one unfiltered 50k-row pull scanned
    // twice in JS.
    const [{ rows: observations }, { rows: outbounds }] = await Promise.all([
      store.listAllEvents({ kind: 'observation', actor: 'system' }, { limit: 50000 }).catch(() => ({ rows: [] })),
      store.listAllEvents({ kind: 'outbound' }, { limit: 50000 }).catch(() => ({ rows: [] })),
    ])

    let degradedCount = 0
    let totalTurnCount = 0

    for (const event of observations) {
      const createdMs = tsMs(event.created_at)
      if (!Number.isFinite(createdMs) || createdMs < thresholdMs) continue
      if (evData(event).degraded_turn === true) degradedCount += 1
      // One turn attempt per TURN-START marker (handler.js), independent of
      // whether it ultimately succeeded or degraded.
      if (typeof event.text === 'string' && event.text.startsWith('TURN-START:')) totalTurnCount += 1
    }

    // Fallback: if no turn-start markers were found in the window (an older
    // deployment / a window predating this marker), approximate turn count
    // from real outbound sends plus the degraded turns that produced no send.
    if (totalTurnCount === 0) {
      const outboundCount = outbounds.filter(e => {
        const createdMs = tsMs(e.created_at)
        return Number.isFinite(createdMs) && createdMs >= thresholdMs
      }).length
      totalTurnCount = outboundCount + degradedCount
    }

    const rate = totalTurnCount > 0 ? (degradedCount / totalTurnCount) * 100 : 0

    return {
      rate: Number(rate.toFixed(2)),
      degraded_count: degradedCount,
      total_count: totalTurnCount,
    }
  } catch (e) {
    return { rate: 0, degraded_count: 0, total_count: 0 }
  }
}

export { FAILURE_REASONS }
