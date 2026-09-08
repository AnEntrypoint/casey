// supervisor-crash-policy.js  --  what a dead process means, for both halves of
// the supervised runtime: the crash budget and backoff applied to a worker exit,
// and the parent's own crash net.
//
// This module decides; src/supervisor.js performs. It reads no state of its own
// beyond the environment-derived tuning below, so the whole restart policy --
// including the two rules that have already shipped as bugs -- is readable in
// one place instead of inside a fork's exit listener.

import { crashBudgetExceeded } from './supervisor-machine.js'

export const CRASH_WINDOW_MS = Number(process.env.CASEY_CRASH_WINDOW_MS || 60_000)
// CASEY_CRASH_LIMIT has no "disabled"/"no limit" mode -- it is a crash-loop
// circuit breaker, and a value of 0 or below is invalid input, not a valid way
// to express "never stop". CASEY_CRASH_LIMIT=0 (a plausible-but-wrong attempt
// to mean exactly that) would otherwise trip crashBudgetExceeded on the very
// FIRST crash: '0' is a non-empty string so `|| 5` never applies its fallback,
// and Number('0') is 0, meaning `recent.length >= 0` is true immediately -- the
// exact opposite of the operator's likely intent. A non-positive value falls
// back to the documented default (5) rather than a degenerate floor of 1 (which
// would still trip on the very first crash, the same failure this exists to
// prevent, just relabeled).
const rawCrashLimit = Number(process.env.CASEY_CRASH_LIMIT || 5)
export const CRASH_LIMIT = rawCrashLimit > 0 ? rawCrashLimit : 5
export const BACKOFF_BASE_MS = Number(process.env.CASEY_RESTART_BACKOFF_MS || 500)
export const BACKOFF_CEIL_MS = Number(process.env.CASEY_RESTART_BACKOFF_CEIL_MS || 10_000)

// Exit code 44 = config-fatal (the worker's dashboard port is already held by
// another process). Retrying the same port can never succeed, so the supervisor
// fails loud ONCE with the actionable message and degrades immediately -- never
// a 5x re-fork storm that ends in a budget message pointing nowhere. This code
// is deliberately NOT retry-eligible; it never reaches the crash budget below
// and never records a crash against it.
export const CONFIG_FATAL_EXIT_CODE = 44

// Exponential, seeded from the restart count BEFORE this restart is counted, so
// the first crash waits BACKOFF_BASE_MS and each subsequent one doubles up to
// the ceiling: 500, 1000, 2000, 4000 on the shipped defaults, then the budget
// stops the loop entirely.
export function restartBackoffMs(restarts) {
  return Math.min(BACKOFF_CEIL_MS, BACKOFF_BASE_MS * Math.pow(2, restarts))
}

// Classify an unexpected worker exit into the one action the supervisor should
// take. `crashes` is the current windowed list of crash timestamps; the returned
// `crashes` is the list with this exit recorded and re-trimmed to the window --
// trimming here, not just inside crashBudgetExceeded's own per-check filter
// (which only ever reads a COPY), is what keeps the array from growing by one
// entry per crash for the entire process lifetime on a long-uptime host with
// occasional below-budget crashes.
export function classifyWorkerExit({ code, signal, crashes, restarts, now, lastCrashReason }) {
  if (code === CONFIG_FATAL_EXIT_CODE) {
    return { kind: 'config-fatal', code, reason: lastCrashReason || 'dashboard port in use' }
  }
  const nextCrashes = [...crashes, now].filter(t => now - t <= CRASH_WINDOW_MS)
  const reason = lastCrashReason || `worker exited code=${code} signal=${signal || ''}`
  if (crashBudgetExceeded(nextCrashes, now, { windowMs: CRASH_WINDOW_MS, limit: CRASH_LIMIT })) {
    // Too many crashes too fast: stop the tight loop, fail loud, hold the process
    // alive in 'degraded' (the dashboard pill + /api/runtime show it) -- never a
    // silent respawn storm. An operator (or a source change -> RELOAD) recovers it.
    return { kind: 'budget', code, signal, reason, crashes: nextCrashes, windowMs: CRASH_WINDOW_MS, limit: CRASH_LIMIT }
  }
  return { kind: 'restart', code, signal, reason, crashes: nextCrashes, backoffMs: restartBackoffMs(restarts) }
}

// The supervisor parent exists specifically to keep every forked worker alive and
// restart it on crash -- but it had no crash net of its own. Without this, an
// unhandled rejection anywhere in the PARENT (IPC handling, the auto-update
// pull() timer, a future dependency bug) hits Node's default uncaught-exception
// behavior and terminates the whole parent process, killing every forked worker
// with zero restart and only a raw stack trace on stderr -- the exact
// "supervisor stops the restart loop instead of thrashing" discipline applied to
// WORKER crashes above never applied to itself. Mirrors bin/worker.js's own
// uncaughtException/unhandledRejection net.
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
