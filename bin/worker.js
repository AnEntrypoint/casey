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

  const requested = (flags.channels || 'discord,whatsapp').split(',').map(s => s.trim()).filter(Boolean)
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
  const channels = requested.filter(ch => (ch === 'whatsapp' ? (hasCreds(ch) && !!process.env.WHATSAPP_APP_SECRET) : hasCreds(ch)))
  // Loud, non-fatal warning (unlike WHATSAPP_APP_SECRET above, which refuses to
  // serve): an unset WHATSAPP_VERIFY_TOKEN falls back to freddie's own literal
  // 'freddie' default for the webhook handshake token, which is guessable by
  // anyone who has read freddie's source. Warn so an operator notices and sets
  // a real token, rather than silently running the handshake on a public default.
  if (channels.includes('whatsapp') && !process.env.WHATSAPP_VERIFY_TOKEN) {
    console.error('[worker] WHATSAPP_VERIFY_TOKEN is unset - webhook verification will use freddie\'s default token (set WHATSAPP_VERIFY_TOKEN to a real secret)')
  }
  if (!channels.length) {
    // No serving surface: fatal, not a silent idle. The supervisor treats a FATAL
    // boot as a crash for budget purposes, so a permanently-misconfigured worker
    // trips the crash-loop guard into 'degraded' instead of respawning forever.
    if (forked) ipcSend(process, WORKER_MSG.FATAL, { reason: 'no channels available' })
    console.error('[worker] no channels available - set discord/whatsapp credentials')
    process.exit(1)
  }

  // Self-healing LLM backend: a provider that is down at boot must not latch casey
  // into holding-message-only mode for the whole process life. makeResilientCallLLM
  // re-resolves lazily (debounced) so a recovered provider resumes real auto-replies
  // with no restart, and its status() is the single live source for the health row.
  const { makeResilientCallLLM } = await import('../src/llm.js')
  // onRecover fires on the provider's down->up edge to drain messages queued during
  // the outage. casey is created after brain, so route through a late-bound ref.
  let caseyRef = null
  const brain = makeResilientCallLLM({
    probe: true,
    onRecover: () => caseyRef?.drainQueuedTurns?.().catch(e => caseyRef?.log?.warn?.('[casey] recovery drain failed', { error: e.message })),
  })
  const casey = await createCasey({
    channels,
    callLLM: brain.callLLM,
    // Live backend health for the handler's LLM-down queue gate (drainQueuedTurns
    // drains on recovery).
    llmStatus: brain.status,
    // Periodic background poll driving drainQueuedTurns -- see casey.js
    // startDrainPoll's own comment for why this cannot rely solely on the
    // onRecover edge or a new inbound arriving. CASEY_DRAIN_POLL_INTERVAL_MS=0
    // disables it (falls back to the reactive-only paths).
    drainPollIntervalMs: process.env.CASEY_DRAIN_POLL_INTERVAL_MS != null ? Number(process.env.CASEY_DRAIN_POLL_INTERVAL_MS) : undefined,
  })
  caseyRef = casey
  // The queue-drain hard status-gate reads the SAME resilient backend the handler and
  // health row use, so a drain only fires when the provider is genuinely back.
  casey.resilientStatus = brain.status
  // COLD-START RACE, fixed here: makeResilientCallLLM never eagerly resolves at
  // construction -- the backend only actually resolves (and, transitively, the
  // acptoapi readiness prober only actually STARTS, see llm.js resolveCallLLM ->
  // freddie.acptoapiReachable -> acptoapi.chatChain -> _ensureReadinessStarted)
  // on the FIRST real callLLM()/status() call. casey.start() below connects the
  // Discord gateway and begins accepting real inbound messages immediately --
  // so a message arriving within the first seconds of a restart used to race
  // the readiness system's own cold start, walking a chain with zero
  // real-request-verified availability data instead of one already warmed by
  // a boot-time probe. USER DIRECTIVE: the correct model must already be ready
  // when the call happens, not discovered live. Force one status() read here,
  // BEFORE gateway.start(), so the backend resolves and the readiness prober's
  // own immediate warm-up pass (readiness.js start()'s tick()) has already run
  // by the time real traffic can possibly arrive. Best-effort: a failure here
  // must never block boot -- the existing self-healing/queue-gate machinery
  // still covers a genuinely unreachable backend exactly as before.
  try { await brain.status() } catch (e) { console.error('[worker] boot-time readiness warm-up failed (continuing, self-heals on first real turn):', e.message) }
  await casey.start()

  const dashPort = Number(flags.port || 4000)
  const sendReply = (caseRow, text) => {
    const a = casey.adapters[caseRow.channel]
    return a?.send ? a.send({ to: caseRow.external_id, text }) : Promise.resolve()
  }
  // Health reads the SAME backend the handler uses, so the dashboard shows recovery
  // the instant the provider comes back -- no separate probe to drift from reality.
  const llmStatus = brain.status

  // Runtime snapshot the parent pushes down (PARENT_MSG.STATE). Held in a mutable
  // closure so /api/runtime reflects the latest without rebuilding the dashboard.
  // Standalone mode leaves it null -> /api/runtime reports 'standalone'.
  let runtimeSnapshot = null
  const runtimeStatus = () => runtimeSnapshot

  // Durable runtime-lifecycle audit: the parent buffers each CRASH/RELOAD/DEGRADED/
  // BUDGET bounce and flushes it to us (PARENT_MSG.RUNTIME_EVENT) once we are READY,
  // so a crash that killed the PREVIOUS worker is persisted by THIS one. We record
  // it as an append-only system observation on a singleton runtime case so the
  // timeline + shift-handover show the runtime was bounced and why. Reason-only:
  // the parent snapshot never carries external_id (PII), so nothing here can leak it.
  let runtimeCaseIdP = null
  const RUNTIME_EVENT_LABEL = {
    CRASH: 'CRASH', RELOAD_REQUESTED: 'RELOAD', HEALTH_DEGRADED: 'DEGRADED', BUDGET_EXCEEDED: 'CRASH-BUDGET-EXCEEDED',
  }
  async function runtimeCaseId() {
    if (!runtimeCaseIdP) {
      runtimeCaseIdP = casey.store.findOrCreateCase({
        channel: 'system', external_id: 'runtime:supervisor',
        contact: { display_name: 'casey runtime', handle: 'runtime' },
      }).then(r => {
        if (r.created && !r.case.subject) {
          casey.store.updateCase(r.case.id, { subject: 'casey runtime lifecycle' }).catch(() => {})
        }
        return r.case.id
      })
    }
    return runtimeCaseIdP
  }
  async function recordRuntimeEvent(ev) {
    try {
      const label = RUNTIME_EVENT_LABEL[ev.event] || ev.event || 'EVENT'
      const reason = ev.reason ? ` -- ${String(ev.reason).slice(0, 300)}` : ''
      const id = await runtimeCaseId()
      await casey.store.appendEvent(id, {
        kind: 'observation', actor: 'system',
        text: `RUNTIME ${label}${reason} (restart #${ev.restarts ?? 0})`,
        data: { runtime: ev.event, restarts: ev.restarts ?? 0 },
      })
    } catch (e) { console.error('[worker] runtime-event record failed:', e.message) }
  }

  // A fresh deployment (zero operator_account rows) gets a single bootstrap
  // admin so there is always a way to log in -- printed once to the log, never
  // persisted in plaintext, never re-created once any account exists.
  try {
    const { ensureBootstrapAdmin } = await import('../src/dashboard/auth.js')
    const boot = await ensureBootstrapAdmin(casey.store, console)
    if (boot) console.log(`[worker] bootstrap admin account created -- username: ${boot.username}  password: ${boot.password}  (log in once and create named accounts for your team)`)
  } catch (e) { console.error('[worker] bootstrap admin check failed:', e.message) }

  let dash
  try {
    dash = await createDashboard(casey.store, {
      port: dashPort, sendReply, llmStatus,
      runSweep: () => casey.runSweepOnce(),
      receiveStatus: () => casey.receiveStatus(),
      runtimeStatus,
      // Surfaces the LLM-down queue depth (pending / dead-lettered) and the
      // alert webhook's last delivery attempt on GET /api/health -- see
      // queue-alert-visibility-dashboard PRD row. queueStatus is cheap and
      // read-only (never drives a turn); webhookUrl matches breachNotifier's
      // own default resolution (CASEY_ALERT_WEBHOOK, falling back to
      // CASEY_HANDOFF_WEBHOOK) so the lookup targets the URL actually in use.
      queueStatus: () => casey.queueStatus(),
      alertWebhookUrl: process.env.CASEY_ALERT_WEBHOOK || process.env.CASEY_HANDOFF_WEBHOOK || null,
    })
  } catch (e) {
    if (forked) ipcSend(process, WORKER_MSG.FATAL, { reason: `dashboard bind failed: ${e.message}` })
    console.error(`[worker] dashboard failed to bind port ${dashPort}: ${e.message}`)
    // A held port can never succeed by retrying the same port: exit with the
    // distinct config-fatal code so the supervisor stops instead of crash-looping
    // into the budget (witnessed: 5x EADDRINUSE re-forks -> degraded with no clear
    // message when a stale worker held the port).
    process.exit(/EADDRINUSE/.test(String(e && e.message)) ? 44 : 1)
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
      else if (m.type === PARENT_MSG.RUNTIME_EVENT) recordRuntimeEvent(m.payload || {})
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
