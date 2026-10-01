#!/usr/bin/env node
import { installLogScrub } from '../src/log-scrub.js'
import { WORKER_MSG, ipcSend } from '../src/supervisor-ipc.js'
import { makeSendReply } from './send-reply.js'
import { resolveServingChannels } from './worker-channels.js'
import { bootServingCasey } from './worker-boot.js'
import { startWorkerDashboard } from './worker-dashboard.js'
import { createRuntimeChannel } from './worker-runtime-events.js'
import { installWorkerRuntimeIo } from './worker-ipc.js'

function crashLoud(kind, err) {
  const reason = (err && err.stack) || (err && err.message) || String(err)
  console.error(`[worker] ${kind} (worker crashing):`, reason)
  if (typeof process.send === 'function') { try { ipcSend(process, WORKER_MSG.FATAL, { reason: `${kind}: ${err && err.message || String(err)}` }) } catch {} }
  process.exit(1)
}
process.on('uncaughtException', (err) => crashLoud('uncaughtException', err))
process.on('unhandledRejection', (err) => crashLoud('unhandledRejection', err))

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

installLogScrub()

async function main() {
  const flags = parseFlags(process.argv.slice(2))
  const forked = typeof process.send === 'function'

  const channels = resolveServingChannels(flags, forked)
  const casey = await bootServingCasey(channels)

  const dashPort = Number(flags.port || 4000)
  const sendReply = makeSendReply(casey)
  const runtime = createRuntimeChannel(casey)

  const dash = await startWorkerDashboard({
    casey, port: dashPort, sendReply,
    llmStatus: casey.resilientStatus,
    callLLM: casey.resilientCallLLM,
    runtimeStatus: runtime.runtimeStatus,
    forked,
  })

  installWorkerRuntimeIo({ casey, dash, forked, runtime })
}

main().catch((e) => {
  if (typeof process.send === 'function') ipcSend(process, WORKER_MSG.FATAL, { reason: e.message })
  console.error('[worker] fatal:', e.stack || e.message)
  process.exit(1)
})
