

export const RECEIVE_SILENCE_MS = Number(process.env.CASEY_RECEIVE_SILENCE_MS || 0)

export function detectZombieReceive(receive, silenceMs) {
  if (!receive || !receive.channels || !(silenceMs > 0)) return null
  for (const [channel, c] of Object.entries(receive.channels)) {
    if (!c || !c.connected) continue
    if (c.sinceInboundMs != null && c.sinceInboundMs > silenceMs) {
      return { channel, silentMs: c.sinceInboundMs }
    }
  }
  return null
}

export function classifyWorkerHealth(payload, silenceMs) {
  if (payload.store === false) {
    return { kind: 'store', reason: 'store not ready', message: '[supervisor] worker reports store not ready -- degrading', detail: null }
  }
  const zombie = silenceMs > 0 ? detectZombieReceive(payload.receive, silenceMs) : null
  if (zombie) {
    return {
      kind: 'zombie',
      reason: `receive silent on ${zombie.channel} for ${zombie.silentMs}ms`,
      message: '[supervisor] zombie receive detected -- degrading',
      detail: { channel: zombie.channel, silentMs: zombie.silentMs },
    }
  }
  return null
}

export function applyWorkerHealth({ log, sup, payload, nowMs, reload, silenceMs = RECEIVE_SILENCE_MS }) {
  if (sup.state !== 'healthy' && sup.state !== 'degraded') return
  const degraded = classifyWorkerHealth(payload, silenceMs)
  if (degraded) {
    if (degraded.detail) log.error?.(degraded.message, degraded.detail)
    else log.error?.(degraded.message)
    if (sup.fire('HEALTH_DEGRADED', nowMs, degraded.reason)) reload(nowMs)
    return
  }
  if (sup.state === 'healthy') sup.fire('HEALTH_OK', nowMs)
}
