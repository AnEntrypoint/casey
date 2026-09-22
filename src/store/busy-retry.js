// store/busy-retry.js  --  the SQLITE_BUSY retry wrapper around a live thatcher
// instance. Takes the instance and a logger, returns a Proxy: no CaseStore
// reference, so the retry policy is readable and changeable on its own.

// thatcher rides busybase (an embedded sqlite store) opened with
// journal_mode=delete and busy_timeout=0, so sqlite itself never waits: a
// contended read/write fails INSTANTLY with "SQLITE_BUSY: database is locked".
// e.g. an agent turn's enquiry tool (case_list/case_get) reading while casey
// writes the same turn's events. Without a retry that throws out of runTurn and
// the worker sends the degraded fallback instead of the real answer. We wrap the
// mutating/reading methods in a bounded retry so a lock contends-and-recovers
// rather than surfacing as a turn error. Bounded (never infinite), and only
// retries the BUSY/locked class -- any other error propagates immediately.
//
// `transition` is in the set because it is an ordinary contended write like any
// other, not an exception to this policy: its absence was costing casey the
// intake auto-transition (`new` -> `triaging`) under load, leaving a case sitting
// at `new` while holding a real report, with only a warn line to say so.
const RETRY_METHODS = new Set(['list', 'get', 'count', 'create', 'update', 'remove', 'delete', 'transition', 'search'])
const isBusy = (e) => /SQLITE_BUSY|database is locked|database table is locked/i.test(String(e?.message || e))
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// A SYMMETRIC COLLISION IS THE FAILURE THIS POLICY HAS TO SURVIVE, AND A FIXED
// BACKOFF CANNOT SURVIVE IT. Under n concurrent inbounds every writer fails in
// the same millisecond, sleeps the same fixed interval, and wakes in the same
// millisecond to collide again -- so a lock-stepped ladder re-creates the
// collision once per rung and then gives up with nothing through. Live-witnessed
// on this deployment: eight WhatsApp reports arriving together each retried
// `create` six times inside 350ms, lock-stepped to the millisecond (all eight on
// attempt 1 within 2ms of each other, attempt 2 within 2ms, and so on), and all
// eight reports were lost.
//
// FULL JITTER -- sleep uniformly at random in [MIN_SLEEP_MS, ceiling) -- is what
// breaks the symmetry: each contender picks a different wake-up, so a rung lets
// one writer through instead of none. The ceiling grows exponentially so a deep
// queue spreads out rather than hammering.
//
// THE BUDGET IS TIME, NOT A RETRY COUNT, and it is generous on purpose. What is
// at stake on the intake path is a report that has ALREADY been acked to the
// sending platform, so it will never be redelivered and is gone for good, while
// the turn it belongs to is allowed CASEY_TURN_HARD_DEADLINE_MS (120s) to
// answer. Spending up to a few seconds of that budget rather than losing the
// record outright is the right proportion; 315ms was not. MAX_ATTEMPTS is only a
// safety valve against a pathological zero-sleep loop -- MIN_SLEEP_MS means the
// time budget is what actually binds.
const BASE_MS = 20
const CEILING_MS = 400
const MIN_SLEEP_MS = 5
const BUDGET_MS = 5000
const MAX_ATTEMPTS = 200

export function createBusyRetryProxy(thatcher, log = null) {
  return new Proxy(thatcher, {
    get(target, prop, recv) {
      const orig = Reflect.get(target, prop, recv)
      if (typeof orig !== 'function' || !RETRY_METHODS.has(prop)) return orig
      return async (...args) => {
        const startedAt = Date.now()
        for (let attempt = 0; ; attempt++) {
          try { return await orig.apply(target, args) }
          catch (e) {
            const elapsedMs = Date.now() - startedAt
            if (!isBusy(e) || elapsedMs >= BUDGET_MS || attempt >= MAX_ATTEMPTS) {
              // Say the budget was spent, at error level. Exhaustion is the
              // moment a caller is about to lose real data, and it read
              // identically to a first transient warn before this line existed.
              if (isBusy(e)) log?.error?.('[casey] sqlite busy; retry budget spent', { method: String(prop), attempts: attempt + 1, elapsedMs })
              throw e
            }
            const ceiling = Math.min(CEILING_MS, BASE_MS * 2 ** attempt)
            const waitMs = Math.max(MIN_SLEEP_MS, Math.random() * ceiling)
            log?.warn?.('[casey] sqlite busy; retrying', { method: String(prop), attempt: attempt + 1, waitMs: Math.round(waitMs), elapsedMs })
            await sleep(waitMs)
          }
        }
      }
    },
  })
}
