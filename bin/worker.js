#!/usr/bin/env node
// worker.js  --  the casey serving worker: gateway + dashboard + store, the unit
// the supervisor (src/supervisor.js) forks and respawns. It is exactly the old
// `casey up` build, refactored so a parent process can drain+replace it for live
// reload and crash-restart WITHOUT losing the store (the sqlite file is reopened
// by each fresh worker -- see mut-reload-mechanism / mut-child-store-sharing).
//
// Run modes:
//   - forked by the supervisor: process.send exists; it speaks the IPC contract
//     (READY/HEALTH/DRAIN). This is `casey up` (supervised, the default).
//   - standalone (`casey up --no-supervise`): no IPC peer; it installs its own
//     SIGINT graceful-shutdown, identical to the legacy single-process path.
//
// Channels/port/llm come from argv flags the supervisor passes through verbatim.
//
// main() is the boot SEQUENCE and nothing else; each step it names lives in a
// sibling beside this file, because each one has its own failure discipline:
//   worker-channels.js       which channels may serve, and the credential gates
//   worker-boot.js           the self-healing LLM backend + the casey assembly
//   worker-dashboard.js      the dashboard bind (incl. the exit-44 split) + extra routes
//   worker-runtime-events.js the parent's runtime snapshot and durable bounce audit
//   worker-ipc.js            drain, health self-report, and the forked/standalone split
// The order below is load-bearing: the backend is warmed before the gateway
// accepts traffic, and READY is announced last, after the dashboard is serving.

import { WORKER_MSG, ipcSend } from '../src/supervisor-ipc.js'
import { makeSendReply } from './send-reply.js'
import { resolveServingChannels } from './worker-channels.js'
import { bootServingCasey } from './worker-boot.js'
import { startWorkerDashboard } from './worker-dashboard.js'
import { createRuntimeChannel } from './worker-runtime-events.js'
import { installWorkerRuntimeIo } from './worker-ipc.js'

// Global crash net: Node's DEFAULT behavior for an unhandled rejection or a
// synchronous uncaught exception ANYWHERE (a background timer, a fire-and-
// forget promise not wrapped by casey.js's own _wrapInflight guard, a bug in
// a dependency's own async interval) is to terminate the process immediately
// -- silently, with no line in this worker's own log explaining why, since
// the crash happens outside every try/catch this codebase wrote. Live-
// witnessed: the worker vanished entirely mid-session with zero trace of the
// cause, discoverable only by noticing the whole process tree was gone.
// main().catch() below only covers a throw during the boot sequence itself;
// this covers everything AFTER boot too. Log loud, tell the supervisor via
// the same WORKER_MSG.FATAL channel a known boot failure already uses (so
// the crash budget counts it and the supervisor's existing backoff/restart
// takes over), then exit non-zero -- never swallow and keep running, since a
// process that just had an unhandled rejection is in an unknown state and
// continuing risks a worse silent failure than a clean, budgeted restart.
function crashLoud(kind, err) {
  const reason = (err && err.stack) || (err && err.message) || String(err)
  console.error(`[worker] ${kind} (worker crashing):`, reason)
  if (typeof process.send === 'function') { try { ipcSend(process, WORKER_MSG.FATAL, { reason: `${kind}: ${err && err.message || String(err)}` }) } catch { /* best-effort */ } }
  process.exit(1)
}
process.on('uncaughtException', (err) => crashLoud('uncaughtException', err))
process.on('unhandledRejection', (err) => crashLoud('unhandledRejection', err))

// Minimal flag parse (the supervisor forks us with the same --flag value shape
// the CLI uses). Unknown flags are ignored so the supervisor can pass extras.
function parseFlags(argv) {
  const f = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) { f[key] = next; i++ }
      else f[key] = true
    }
  }
  return f
}

async function main() {
  const flags = parseFlags(process.argv.slice(2))
  const forked = typeof process.send === 'function'

  const channels = resolveServingChannels(flags, forked)
  const casey = await bootServingCasey(channels)

  const dashPort = Number(flags.port || 4000)
  // Shared with bin/casey-cli.mjs's --no-supervise path: the reply delivery
  // TARGET is deliberately not the conversation key (see bin/send-reply.js).
  const sendReply = makeSendReply(casey)
  const runtime = createRuntimeChannel(casey)

  const dash = await startWorkerDashboard({
    casey, port: dashPort, sendReply,
    // Health reads the SAME backend the handler uses, so the dashboard shows
    // recovery the instant the provider comes back -- no separate probe to drift
    // from reality.
    llmStatus: casey.resilientStatus,
    runtimeStatus: runtime.runtimeStatus,
    forked,
  })

  installWorkerRuntimeIo({ casey, dash, forked, runtime })
}

main().catch((e) => {
  // A boot throw before the dashboard is the clearest crash signal. Tell the parent
  // (so the budget counts it) and exit non-zero (so an unforked run fails loud).
  if (typeof process.send === 'function') ipcSend(process, WORKER_MSG.FATAL, { reason: e.message })
  console.error('[worker] fatal:', e.stack || e.message)
  process.exit(1)
})
