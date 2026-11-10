import { TABLE, ACTOR, isoOrNull } from './portal-store.js'

export const OUTAGE_KINDS = Object.freeze(['offline', 'reboot', 'server_restart'])
export const OUTAGE_MIN_GAP_MS = 10 * 60e3
const GAP_FACTOR = 2

const processStartMs = () => Date.now() - process.uptime() * 1000

export function outagesBetween(prev, cur, { idleHeartbeatS = 300, serverStartMs = processStartMs() } = {}) {
  const prevMs = Date.parse(prev?.ts)
  const curMs = Date.parse(cur?.ts)
  if (!Number.isFinite(prevMs) || !Number.isFinite(curMs) || curMs <= prevMs) return []
  const prevUp = prev.health?.uptime_s
  const curUp = cur.health?.uptime_s
  if (typeof prevUp === 'number' && typeof curUp === 'number' && curUp < prevUp) {
    const bootMs = Math.min(curMs, Math.max(prevMs, curMs - curUp * 1000))
    return [{ kind: 'reboot', startMs: prevMs, endMs: bootMs }]
  }
  const threshold = Math.max(GAP_FACTOR * idleHeartbeatS * 1000, OUTAGE_MIN_GAP_MS)
  if (curMs - prevMs <= threshold) return []
  const kind = serverStartMs > prevMs && serverStartMs <= curMs ? 'server_restart' : 'offline'
  return [{ kind, startMs: prevMs, endMs: curMs }]
}

export async function recordOutages(store, router, prev, cur, { idleHeartbeatS, serverStartMs } = {}) {
  const found = outagesBetween(prev, cur, { idleHeartbeatS, serverStartMs })
  for (const o of found) {
    await store.t.create(TABLE.outages, {
      router_id: router.router_id,
      kind: o.kind,
      start_ts: new Date(o.startMs).toISOString(),
      end_ts: new Date(o.endMs).toISOString(),
      duration_s: Math.round((o.endMs - o.startMs) / 1000),
      detected_at: isoOrNull(cur.ts),
    }, ACTOR)
  }
  return found.length
}

export async function outagesFor(store, routerId, { since, limit = 1000 } = {}) {
  const where = { router_id: routerId }
  if (since) where.start_ts = { $gte: since }
  return store.t.list(TABLE.outages, where, { limit, sort: [{ field: 'start_ts', dir: 'DESC' }] })
}
