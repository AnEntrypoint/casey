
const RETRY_METHODS = new Set(['list', 'get', 'count', 'create', 'update', 'remove', 'delete', 'transition', 'search'])
const isBusy = (e) => /SQLITE_BUSY|database is locked|database table is locked/i.test(String(e?.message || e))
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

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
