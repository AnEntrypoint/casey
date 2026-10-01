

import { crashBudgetExceeded } from './supervisor-machine.js'

export const CRASH_WINDOW_MS = Number(process.env.CASEY_CRASH_WINDOW_MS || 60_000)

const rawCrashLimit = Number(process.env.CASEY_CRASH_LIMIT || 5)
export const CRASH_LIMIT = rawCrashLimit > 0 ? rawCrashLimit : 5
export const BACKOFF_BASE_MS = Number(process.env.CASEY_RESTART_BACKOFF_MS || 500)
export const BACKOFF_CEIL_MS = Number(process.env.CASEY_RESTART_BACKOFF_CEIL_MS || 10_000)

export const CONFIG_FATAL_EXIT_CODE = 44

export function restartBackoffMs(restarts) {
  return Math.min(BACKOFF_CEIL_MS, BACKOFF_BASE_MS * Math.pow(2, restarts))
}

export function classifyWorkerExit({ code, signal, crashes, restarts, now, lastCrashReason }) {
  if (code === CONFIG_FATAL_EXIT_CODE) {
    return { kind: 'config-fatal', code, reason: lastCrashReason || 'dashboard port in use' }
  }
  const nextCrashes = [...crashes, now].filter(t => now - t <= CRASH_WINDOW_MS)
  const reason = lastCrashReason || `worker exited code=${code} signal=${signal || ''}`
  if (crashBudgetExceeded(nextCrashes, now, { windowMs: CRASH_WINDOW_MS, limit: CRASH_LIMIT })) {

    return { kind: 'budget', code, signal, reason, crashes: nextCrashes, windowMs: CRASH_WINDOW_MS, limit: CRASH_LIMIT }
  }
  return { kind: 'restart', code, signal, reason, crashes: nextCrashes, backoffMs: restartBackoffMs(restarts) }
}

export function installParentCrashNet(log) {
  process.on('uncaughtException', (e) => {
    log.error?.('[supervisor] uncaughtException (exiting)', { error: e?.stack || e?.message || String(e) })
    process.exit(1)
  })
  process.on('unhandledRejection', (e) => {
    log.error?.('[supervisor] unhandledRejection (exiting)', { error: e?.stack || e?.message || String(e) })
    process.exit(1)
  })
}
