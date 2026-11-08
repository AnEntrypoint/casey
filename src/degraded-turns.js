

import { tsMs } from './timestamp.js'
import { evData } from './safe.js'

const FAILURE_REASONS = Object.freeze({
  PROVIDER: 'provider',
  TIMEOUT: 'timeout',
  RETRY_EXHAUSTED: 'retry-exhausted',
  LLM_REFUSAL: 'llm-refusal',
})

export async function recordDegradedTurn(store, { caseId, contactId, reason, turnStartMs, channel, error = null }) {
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
        ...(error ? { error: String(error).slice(0, 500) } : {}),
      },
    })
    return event
  } catch (e) {

    return null
  }
}

export async function calculateDegradationRate(store, { hours = 1 } = {}) {
  if (!store || typeof store.listAllEvents !== 'function') return { rate: 0, degraded_count: 0, total_count: 0 }

  try {
    const now = Date.now()
    const windowMs = hours * 3600000
    const thresholdMs = now - windowMs

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

      if (typeof event.text === 'string' && event.text.startsWith('TURN-START:')) totalTurnCount += 1
    }

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
