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

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCasey } from '../src/casey.js'
import { createDashboard } from '../src/dashboard/server.js'
import { WORKER_MSG, PARENT_MSG, ipcSend } from '../src/supervisor-ipc.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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

// hasCreds mirrors bin/casey.js so a channel with no credentials is skipped
// rather than crashing the worker on boot (which the supervisor would read as a
// crash-loop). Kept local to avoid importing the whole CLI module.
function hasCreds(ch) {
  if (ch === 'discord') return !!process.env.DISCORD_BOT_TOKEN
  if (ch === 'whatsapp') return !!(process.env.WHATSAPP_API_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID)
  return false
}

async function main() {
  const flags = parseFlags(process.argv.slice(2))
  const forked = typeof process.send === 'function'

  const requested = (flags.channels || 'sim,discord,whatsapp').split(',').map(s => s.trim()).filter(Boolean)
  // Security invariant (AGENTS.md): WhatsApp must NOT serve without
  // WHATSAPP_APP_SECRET -- without it freddie cannot HMAC-verify inbound webhooks,
  // so anyone reaching the webhook can forge farmer messages. Enforce it here in
  // the worker (the process that actually binds the channel), not just in doctor:
  // if whatsapp has creds but no secret, refuse it. If whatsapp was EXPLICITLY
  // requested, that is a fatal misconfiguration (loud, not a silent drop); if it
  // came from the default channel list, drop it with a warning and serve the rest.
  if (hasCreds('whatsapp') && !process.env.WHATSAPP_APP_SECRET) {
    const idx = requested.indexOf('whatsapp')
    if (idx !== -1 && (flags.channels)) {
      // operator named whatsapp explicitly -> fatal, do not run it unsigned
      if (forked) ipcSend(process, WORKER_MSG.FATAL, { reason: 'WHATSAPP_APP_SECRET required to serve WhatsApp (verify inbound webhook signatures)' })
      console.error('[worker] WHATSAPP_APP_SECRET is required to enable WhatsApp - refusing to serve unsigned inbound')
      process.exit(1)
    }
    if (idx !== -1) requested.splice(idx, 1)
    console.error('[worker] WhatsApp creds present but WHATSAPP_APP_SECRET unset - skipping WhatsApp (set the secret to enable it)')
  }
  const channels = requested.filter(ch => ch === 'sim' || (ch === 'whatsapp' ? (hasCreds(ch) && !!process.env.WHATSAPP_APP_SECRET) : hasCreds(ch)))
  if (!channels.length) {
    // No serving surface: fatal, not a silent idle. The supervisor treats a FATAL
    // boot as a crash for budget purposes, so a permanently-misconfigured worker
    // trips the crash-loop guard into 'degraded' instead of respawning forever.
    if (forked) ipcSend(process, WORKER_MSG.FATAL, { reason: 'no channels available' })
    console.error('[worker] no channels available - set credentials or include sim')
    process.exit(1)
  }

  const { resolveCallLLM } = await import('../src/llm.js')
  const brain = await resolveCallLLM({ probe: true }).catch(() => ({ callLLM: null, source: 'none' }))
  const casey = await createCasey({ channels, callLLM: brain.callLLM })
  await casey.start()

  const dashPort = Number(flags.port || 4000)
  const sendReply = (caseRow, text) => {
    const a = casey.adapters[caseRow.channel]
    return a?.send ? a.send({ to: caseRow.external_id, text }) : Promise.resolve()
  }
  const { resolveCallLLM: _rc } = await import('../src/llm.js')
  const llmStatus = async () => {
    if (process.env.CASEY_STUB_LLM) return { source: 'stub' }
    const b = await _rc({ probe: true }).catch(() => ({ source: 'none' }))
    return { source: b.source, model: b.model, url: b.url }
  }

  // Runtime snapshot the parent pushes down (PARENT_MSG.STATE). Held in a mutable
  // closure so /api/runtime reflects the latest without rebuilding the dashboard.
  // Standalone mode leaves it null -> /api/runtime reports 'standalone'.
  let runtimeSnapshot = null
  const runtimeStatus = () => runtimeSnapshot

  let dash
  try {
    dash = await createDashboard(casey.store, {
      port: dashPort, sendReply, llmStatus,
      runSweep: () => casey.runSweepOnce(),
      receiveStatus: () => casey.receiveStatus(),
      runtimeStatus,
    })
  } catch (e) {
    if (forked) ipcSend(process, WORKER_MSG.FATAL, { reason: `dashboard bind failed: ${e.message}` })
    console.error(`[worker] dashboard failed to bind port ${dashPort}: ${e.message}`)
    process.exit(1)
  }

  // Graceful drain shared by SIGINT (standalone) and PARENT_MSG.DRAIN (forked):
  // close the dashboard, let casey.stop() finish in-flight turns + flush the WAL,
  // then exit. Guarded against re-entry so a double signal cannot race the WAL
  // flush (the same guard the legacy `up` path had).
  let draining = false
  async function drainAndExit(code = 0) {
    if (draining) return
    draining = true
    try { await dash.close() } catch (e) { console.error('[worker] dash close error:', e.message) }
    try { await casey.stop() } catch (e) { console.error('[worker] casey stop error:', e.message) }
    if (forked) ipcSend(process, WORKER_MSG.DRAIN_COMPLETE, {})
    // Give the IPC message a tick to flush before exit so the parent reliably sees
    // DRAIN_COMPLETE rather than only the raw 'exit' event.
    setTimeout(() => process.exit(code), 50)
  }

  function reportHealth() {
    if (!forked) return
    let receive = null
    try { receive = casey.receiveStatus() } catch { receive = null }
    ipcSend(process, WORKER_MSG.HEALTH, {
      receive,
      // store readiness: a cheap truthiness check; a wedged store surfaces as a
      // missing/false flag the parent can act on without us blocking here.
      store: !!casey.store,
    })
  }

  if (forked) {
    process.on('message', (m) => {
      if (!m || typeof m !== 'object') return
      if (m.type === PARENT_MSG.DRAIN) drainAndExit(0)
      else if (m.type === PARENT_MSG.HEALTH_QUERY) reportHealth()
      else if (m.type === PARENT_MSG.STATE) runtimeSnapshot = m.payload || null
    })
    // Periodic self-report so the parent can detect a wedged worker (no ticks)
    // distinct from a crashed one (exit event). Unref'd: it never holds the worker
    // alive on its own.
    const hb = setInterval(reportHealth, 10_000)
    hb.unref?.()
    // Announce readiness LAST -- only once the dashboard is bound and serving, so
    // the parent's 'booting -> healthy' transition reflects a truly-serving worker.
    ipcSend(process, WORKER_MSG.READY, { port: dash.port })
    reportHealth()
  } else {
    // Standalone: own the SIGINT path exactly like the legacy single-process `up`.
    console.log(`casey worker (standalone) on http://localhost:${dash.port}`)
    process.on('SIGINT', () => drainAndExit(0))
    process.on('SIGTERM', () => drainAndExit(0))
  }
}

main().catch((e) => {
  // A boot throw before the dashboard is the clearest crash signal. Tell the parent
  // (so the budget counts it) and exit non-zero (so an unforked run fails loud).
  if (typeof process.send === 'function') ipcSend(process, WORKER_MSG.FATAL, { reason: e.message })
  console.error('[worker] fatal:', e.stack || e.message)
  process.exit(1)
})
