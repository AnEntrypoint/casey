// hooks/admission.js -- everything that decides whether an inbound is allowed
// to become a turn AT ALL, and nothing that knows what a turn is.
//
// Four pieces of mutable per-process state live here: the per-contact in-flight
// claim, the burst buffer that catches whatever the claim turns away, the
// per-contact sliding rate window (plus its own piggybacked eviction sweep),
// and the global sliding window. They share nothing with the rest of the
// handler except being consulted before a turn starts, and they are the only
// state whose correctness is about time and concurrency rather than about a
// case.
//
// The three guarantees this module is responsible for. The first two are also
// stated in AGENTS.md; the third is stated only here and at the claim site in
// hooks/handler.js:
//   * A fast message burst is BUFFERED and replayed, never silently dropped.
//   * An over-cap message is dropped SILENTLY -- no synthetic "slow down" text.
//   * The claim is taken SYNCHRONOUSLY, with no await between the has() and the
//     add(), so two overlapping arrivals for one contact cannot both pass it.
//     Under JS's cooperative concurrency that pair IS the critical section; any
//     await placed between them reopens the race it exists to close.

export function makeAdmissionControl({ log = console } = {}) {
  // Per-contact in-flight guard, keyed on external_id (the canonical contact
  // key): while a turn is running for a contact, a second arrival must not race
  // a concurrent LLM call against the same case.
  const inFlight = new Set()
  // What the guard turned away. Buffered RAW and unprocessed, and replayed as a
  // FULL turn once the claim clears -- recording the inbound without replaying
  // it loses every message of a fast burst but the first, since the rest never
  // reach a prompt.
  const pendingBuffer = new Map()   // external_id -> msg[] (raw, unprocessed)
  const BUFFER_CAP = 20

  // Per-contact rate limit. inFlight only blocks a SIMULTANEOUS second message;
  // it does nothing to bound sequential message rate over time, so one contact
  // could otherwise drive unbounded LLM spend and store writes.
  const rateWindows = new Map()   // external_id -> number[] (recent turn-start ms)
  const RATE_LIMIT_MSGS = Number(process.env.CASEY_RATE_LIMIT_MSGS) || 10
  const RATE_LIMIT_WINDOW_MS = Number(process.env.CASEY_RATE_LIMIT_WINDOW_MS) || 60_000
  // rateWindows never removes a key on its own (a contact that goes quiet after
  // its window empties still leaves an entry), so a long-running process with
  // many one-time senders grows the Map unboundedly. The sweep piggybacks on the
  // natural rate-check cadence rather than owning a timer of its own.
  const RATE_SWEEP_INTERVAL_MS = 10 * 60_000
  let lastRateSweep = 0

  // GLOBAL rate limit: the per-contact window bounds each external_id
  // independently, so many DISTINCT senders each get a fresh allowance and
  // aggregate spend stays unbounded. Same sliding shape, one fixed window for
  // everyone.
  const globalRateWindow = []   // number[] (recent turn-start ms, all contacts)
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
    // Whether a turn is already running for this contact. Paired with claim()
    // below with NO await in between -- see the module header.
    isClaimed(id) { return inFlight.has(id) },
    claim(id) { inFlight.add(id) },
    release(id) { inFlight.delete(id) },

    // Hold a message the in-flight guard turned away. Over the cap the OLDEST is
    // dropped (and said so, loudly): a bounded buffer that keeps the newest is
    // the honest degradation, an unbounded one is a memory leak keyed on a
    // contact who will not stop typing.
    bufferBurst(id, msg, channel) {
      const buf = pendingBuffer.get(id) || []
      buf.push(msg)
      if (buf.length > BUFFER_CAP) {
        buf.shift()
        log.warn?.('[casey] burst buffer cap exceeded, oldest message dropped', { channel, cap: BUFFER_CAP })
      }
      pendingBuffer.set(id, buf)
    },

    // The next buffered message for this contact, oldest-first, or null when
    // there is nothing to replay or a turn is still in flight. Returning null
    // rather than throwing keeps the drain a plain `if` at the call site.
    takeBuffered(id) {
      const buf = pendingBuffer.get(id)
      if (!buf || !buf.length || inFlight.has(id)) return null
      const next = buf.shift()
      if (!buf.length) pendingBuffer.delete(id)
      else pendingBuffer.set(id, buf)
      return next
    },

    // Records this arrival against the contact's window and reports whether it
    // is over the cap. Recording-then-testing (not testing-then-recording) is
    // deliberate: an over-cap message still consumes a slot, so a contact cannot
    // sit exactly on the cap forever by ignoring the drops.
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
