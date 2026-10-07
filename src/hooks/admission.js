

import { recordDroppedInbound } from './dropped-intake.js'
import { messageId } from './case-intake.js'

export function makeAdmissionControl({ log = console, store = null } = {}) {

  const inFlight = new Set()

  const pendingBuffer = new Map()
  const BUFFER_CAP = 20

  const rateWindows = new Map()
  const RATE_LIMIT_MSGS = Number(process.env.CASEY_RATE_LIMIT_MSGS) || 10
  const RATE_LIMIT_WINDOW_MS = Number(process.env.CASEY_RATE_LIMIT_WINDOW_MS) || 60_000

  const RATE_SWEEP_INTERVAL_MS = 10 * 60_000
  let lastRateSweep = 0

  const globalRateWindow = []
  const GLOBAL_RATE_LIMIT_MSGS = Number(process.env.CASEY_GLOBAL_RATE_LIMIT_MSGS) || 200
  const GLOBAL_RATE_LIMIT_WINDOW_MS = Number(process.env.CASEY_GLOBAL_RATE_LIMIT_WINDOW_MS) || 60_000

  function sweepRateWindows(now) {
    if (now - lastRateSweep < RATE_SWEEP_INTERVAL_MS) return
    lastRateSweep = now
    for (const [id, hits] of rateWindows) {
      if (!hits.some(t => now - t < RATE_LIMIT_WINDOW_MS)) rateWindows.delete(id)
    }
  }

  return {

    isClaimed(id) { return inFlight.has(id) },
    claim(id) { inFlight.add(id) },
    release(id) { inFlight.delete(id) },

    bufferBurst(id, msg, channel) {
      const buf = pendingBuffer.get(id) || []
      const wamid = messageId(msg)
      if (wamid && buf.some(m => messageId(m) === wamid)) {
        log.info?.('[casey] redelivered message already buffered; dropped', { channel })
        return false
      }
      buf.push(msg)
      if (buf.length > BUFFER_CAP) {
        buf.shift()
        log.warn?.('[casey] burst buffer cap exceeded, oldest message dropped', { channel, cap: BUFFER_CAP })

        recordDroppedInbound('burst_buffer_full', { channel, store, log })
      }
      pendingBuffer.set(id, buf)
      return true
    },

    takeBufferedWhile(id, accept) {
      const buf = pendingBuffer.get(id)
      const taken = []
      while (buf?.length && accept(buf[0])) taken.push(buf.shift())
      if (buf && !buf.length) pendingBuffer.delete(id)
      return taken
    },

    takeBuffered(id) {
      const buf = pendingBuffer.get(id)
      if (!buf || !buf.length || inFlight.has(id)) return null
      const next = buf.shift()
      if (!buf.length) pendingBuffer.delete(id)
      else pendingBuffer.set(id, buf)
      return next
    },

    rateLimited(id, now = Date.now()) {
      sweepRateWindows(now)
      const hits = (rateWindows.get(id) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS)
      hits.push(now)
      rateWindows.set(id, hits)
      return hits.length > RATE_LIMIT_MSGS
    },

    globallyRateLimited(now = Date.now()) {
      let i = 0
      while (i < globalRateWindow.length && now - globalRateWindow[i] >= GLOBAL_RATE_LIMIT_WINDOW_MS) i++
      if (i) globalRateWindow.splice(0, i)
      globalRateWindow.push(now)
      return globalRateWindow.length > GLOBAL_RATE_LIMIT_MSGS
    },
  }
}
