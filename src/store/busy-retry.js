// store/busy-retry.js  --  the SQLITE_BUSY retry wrapper around a live thatcher
// instance. Takes the instance and a logger, returns a Proxy: no CaseStore
// reference, so the retry policy is readable and changeable on its own.

// thatcher rides busybase (an embedded sqlite store); under concurrency a
// read/write can transiently fail with "SQLITE_BUSY: database is locked" --
// e.g. an agent turn's enquiry tool (case_list/case_get) reading while casey
// writes the same turn's events. Without a retry that throws out of runTurn and
// the worker sends the degraded fallback instead of the real answer. We wrap the
// mutating/reading methods in a bounded retry with small linear backoff so a
// lock contends-and-recovers rather than surfacing as a turn error. Bounded
// (never infinite), and only retries the BUSY/locked class -- any other error
// propagates immediately.
const RETRY_METHODS = new Set(['list', 'get', 'create', 'update', 'remove', 'delete'])
const isBusy = (e) => /SQLITE_BUSY|database is locked|database table is locked/i.test(String(e?.message || e))
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

export function createBusyRetryProxy(thatcher, log = null) {
  return new Proxy(thatcher, {
    get(target, prop, recv) {
      const orig = Reflect.get(target, prop, recv)
      if (typeof orig !== 'function' || !RETRY_METHODS.has(prop)) return orig
      return async (...args) => {
        const MAX = 6
        for (let attempt = 0; ; attempt++) {
          try { return await orig.apply(target, args) }
          catch (e) {
            if (!isBusy(e) || attempt >= MAX) throw e
            log?.warn?.('[casey] sqlite busy; retrying', { method: String(prop), attempt: attempt + 1 })
            await sleep(15 * (attempt + 1))   // 15,30,45,... ms linear backoff
          }
        }
      }
    },
  })
}
