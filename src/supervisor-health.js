// supervisor-health.js  --  reading a worker's HEALTH tick and deciding whether
// the runtime is degraded.
//
// Split out of src/supervisor.js: this answers "does this health payload mean
// the runtime is wedged, and why", which is a judgement over a snapshot and not
// a lifecycle effect. The supervisor still owns the effect (fire
// HEALTH_DEGRADED, then drain-and-refork through the same reload path).

// Zombie-receive self-heal threshold: a real-time channel that WAS receiving and
// then went silent longer than this is treated as a wedged gateway and healed by a
// restart. Default 0 = OFF -- a conservative opt-in, because a genuinely quiet day
// is indistinguishable from a wedge by silence alone, and a false restart is worse
// than waiting. Set e.g. CASEY_RECEIVE_SILENCE_MS=900000 (15min) to enable.
export const RECEIVE_SILENCE_MS = Number(process.env.CASEY_RECEIVE_SILENCE_MS || 0)

// Pure zombie-receive detector over a receiveStatus snapshot ({state, channels:{
// [ch]:{connected, sinceConnectMs, sinceInboundMs}}}). Returns the first channel
// that is connected and was receiving (sinceInboundMs != null) but has now been
// silent past `silenceMs`, or null. A never-received channel (sinceInboundMs ===
// null) is intentionally NOT flagged: a quiet day is not a wedge. Exported for the
// single real-services witness to assert the heuristic directly.
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

// A wedged store or a zombie receive is a degraded runtime: heal it by restart
// through the same drain->refork path. receiveStatus shape: per-channel
// {connected, sinceConnectMs, sinceInboundMs}; a real-time channel connected long
// ago with NO inbound is only SUSPICIOUS, not proof -- so the definitive trigger
// is a store failure, and the zombie-receive heuristic stays opt-in behind
// CASEY_RECEIVE_SILENCE_MS to avoid false restarts on a genuinely quiet day.
//
// Zombie-receive heal: a real-time channel that connected AND received inbound at
// some point, but has now been silent past the threshold while still "connected",
// is a wedged gateway (TCP up, delivery dead) -- the exact "online but deaf"
// failure. A channel that connected and NEVER received is NOT flagged (a quiet day
// is legitimate, sinceInboundMs===null). Channel NAME only, never PII.
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

// Apply a health tick to the live supervisor state. Only meaningful while
// serving; a degrade fires HEALTH_DEGRADED and, if the machine accepted it,
// hands back to the caller's reload (drain -> refork).
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
