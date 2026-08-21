// degraded-turns.js -- turn failure tracking and observability
//
// Captures failed turns (timeout, provider down, retry exhausted, LLM refusal)
// and provides aggregation/query for the /api/turns/degraded endpoint.
// Records degraded_turn events with: reason (provider/timeout/retry-exhausted/llm-refusal),
// contact_id, turn_ts (start), recovery_ts (updated on next successful turn).

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
      kind: 'degraded_turn',
      actor: 'system',
      channel: channel || 'other',
      text: `Turn degraded: ${normalizedReason}`,
      data: JSON.stringify({
        contact_id: contactId,
        reason: normalizedReason,
        turn_ts: turnStartMs || Date.now(),
        recovery_ts: null,  // Updated on next successful turn
      }),
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
  if (!store || typeof store.listEvents !== 'function') {
    return { turns: [], summary: { total: 0, last_failure_at: null, failures_in_last_hour: 0, by_reason: {} } }
  }

  const now = Date.now()
  const windowMs = hours * 3600000
  const thresholdMs = now - windowMs
  const lastHourMs = now - 3600000

  try {
    // Fetch all events in the window (no native query filter by time/kind on this store yet)
    // This is a best-effort aggregation; for large event logs this will need pagination/indexing
    const allEvents = await store.listEvents(null, { limit: 50000 }).catch(() => [])

    const degradedEvents = []
    const byReason = {}
    let lastFailureAt = null
    let lastHourCount = 0

    for (const event of allEvents) {
      if (event.kind !== 'degraded_turn') continue
      const createdMs = new Date(event.created_at).getTime()
      if (createdMs < thresholdMs) continue

      degradedEvents.push(event)

      let data = {}
      try {
        data = typeof event.data === 'string' ? JSON.parse(event.data) : (event.data || {})
      } catch { /* parse error, use empty */ }

      const reason = data.reason || 'unknown'
      byReason[reason] = (byReason[reason] || 0) + 1

      if (createdMs > lastFailureAt) lastFailureAt = createdMs
      if (createdMs > lastHourMs) lastHourCount += 1
    }

    // Group by contact and reason, keeping most recent
    const byContact = new Map()
    for (const event of degradedEvents) {
      let data = {}
      try {
        data = typeof event.data === 'string' ? JSON.parse(event.data) : (event.data || {})
      } catch { /* */ }

      const contactId = data.contact_id || 'unknown'
      const reason = data.reason || 'unknown'
      const key = `${contactId}:${reason}`

      if (!byContact.has(key)) {
        byContact.set(key, { contact_id: contactId, reason, count: 0, last_at: event.created_at })
      }
      const entry = byContact.get(key)
      entry.count += 1
      if (new Date(event.created_at) > new Date(entry.last_at)) {
        entry.last_at = event.created_at
      }
    }

    const turns = Array.from(byContact.values())
      .sort((a, b) => new Date(b.last_at) - new Date(a.last_at))
      .slice(0, limit)

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
  if (!store) return { rate: 0, degraded_count: 0, total_count: 0 }

  try {
    const now = Date.now()
    const windowMs = hours * 3600000
    const thresholdMs = now - windowMs

    // Count all events in the window
    const allEvents = await store.listEvents(null, { limit: 50000 }).catch(() => [])

    let degradedCount = 0
    let totalTurnCount = 0

    for (const event of allEvents) {
      const createdMs = new Date(event.created_at).getTime()
      if (createdMs < thresholdMs) continue

      // Count agent turns: outbound (with corresponding inbound) or degraded_turn
      if (event.kind === 'outbound' || event.kind === 'inbound' || event.kind === 'degraded_turn') {
        if (event.kind === 'degraded_turn') degradedCount += 1
        // Only count 1 turn per inbound message (use turn-start marker to count attempts)
        if (event.kind === 'observation' && typeof event.text === 'string' && event.text.startsWith('TURN-START:')) {
          totalTurnCount += 1
        }
      }
    }

    // Fallback: if no turn-start markers, use outbound count
    if (totalTurnCount === 0) {
      totalTurnCount = allEvents.filter(e => {
        const createdMs = new Date(e.created_at).getTime()
        return createdMs >= thresholdMs && e.kind === 'outbound'
      }).length || degradedCount
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
