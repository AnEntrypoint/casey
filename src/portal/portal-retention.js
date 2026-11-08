import { TABLE } from './portal-store.js'
import { DAY_MS } from './portal-usage.js'
import { retentionDays } from './portal-config.js'

const HOUR_MS = 3600e3
const PURGE_BATCH = 500
const PURGE_BATCHES_MAX = 200

async function deleteOlderThan(store, entity, field, cutoff) {
  let removed = 0
  for (let batch = 0; batch < PURGE_BATCHES_MAX; batch++) {
    const rows = await store.t.list(entity, { [field]: { $lt: cutoff } }, { limit: PURGE_BATCH })
    if (!rows.length) break
    for (const row of rows) await store.t.delete(entity, row.id)
    removed += rows.length
  }
  return removed
}

export function createPurgeGate({ everyMs = HOUR_MS } = {}) {
  let lastRunAt = Number.NEGATIVE_INFINITY
  return async function purgeIfDue(store, now = Date.now(), days = retentionDays()) {
    if (now - lastRunAt < everyMs) return 0
    lastRunAt = now
    const cutoff = new Date(now - days * DAY_MS).toISOString()
    const usage = await deleteOlderThan(store, TABLE.usage, 'received_at', cutoff)
    const health = await deleteOlderThan(store, TABLE.health, 'ts', cutoff)
    return usage + health
  }
}

export const purgeIfDue = createPurgeGate()
