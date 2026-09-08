// casey-serve.js  --  the two commands that stand a long-running process up:
// `casey up` (gateway + dashboard, supervised by default) and `casey dashboard`
// (the observe/edit dashboard alone, against the existing store). Split out of
// bin/casey-cli.mjs's 698-line main() verbatim -- same flags, same strings,
// same exit codes, same signal handling.

import { createCasey } from '../src/casey.js'
import { createCaseStore } from '../src/case-store.js'
import { createDashboard } from '../src/dashboard/server.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, bold, dim, green, yellow, cyan, bad, warn, pkgVersion, hasCreds, closeAndExit } from './casey-cli-ui.js'
import { makeSendReply } from './send-reply.js'

const UP_HELP = 'casey up [--channels discord,whatsapp] [--port 4000] [--no-reload] [--no-supervise] [--no-auto-update]\n  Start the gateway (all configured channels) and the dashboard.\n  Supervised by default: the worker auto-restarts on a source change (live reload) or a crash,\n  reopening the same case store so nothing is lost. AUTO-UPDATE is on by default -- it fetches\n  from origin on an interval and fast-forwards (git fetch + merge --ff-only, safe: it never\n  clobbers local edits and refuses to move a diverged tree) so a pushed fix deploys with no\n  manual restart. --no-reload disables the file watcher; --no-auto-update\n  (or CASEY_AUTO_UPDATE=0) disables the origin pull; --no-supervise runs the legacy single-process\n  path for debugging.'

// Which channels this run will actually serve, or null when it must not start.
// Enforces the WhatsApp-without-an-app-secret refusal (doctor only flags it) and
// reports what was dropped for missing credentials.
function resolveChannels(flags) {
  const requested = (flags.channels || 'discord,whatsapp').split(',').map(s => s.trim()).filter(Boolean)
  // Security invariant (AGENTS.md): WhatsApp must NOT serve without
  // WHATSAPP_APP_SECRET -- without it freddie cannot HMAC-verify inbound
  // webhooks, so anyone reaching the webhook can forge farmer messages. doctor
  // flags it; here on the live path we ENFORCE it. If whatsapp was named
  // explicitly, refuse to start (loud, not a silent drop); if it only came from
  // the default channel list, drop it with a warning and serve the rest. The
  // worker (bin/worker.js) carries the same guard as defence in depth.
  if (hasCreds('whatsapp') && !process.env.WHATSAPP_APP_SECRET) {
    const idx = requested.indexOf('whatsapp')
    if (idx !== -1 && flags.channels) {
      console.log(bad('WHATSAPP_APP_SECRET is required to enable WhatsApp (verify inbound webhook signatures) - refusing to serve unsigned inbound'))
      process.exit(1)
    }
    if (idx !== -1) { requested.splice(idx, 1); console.log(warn('WhatsApp creds present but WHATSAPP_APP_SECRET unset - skipping WhatsApp (set the secret to enable it)')) }
  }
  const channels = requested.filter(ch => hasCreds(ch))
  const skipped = requested.filter(ch => !hasCreds(ch))
  if (!channels.length) { console.log(bad('no channels available - set discord/whatsapp credentials')); process.exit(1) }
  // Loud, non-fatal warning (see bin/worker.js's matching guard): an unset
  // WHATSAPP_VERIFY_TOKEN falls back to freddie's own literal 'freddie'
  // default webhook handshake token, guessable by anyone who has read
  // freddie's source.
  if (channels.includes('whatsapp') && !process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log(warn('WHATSAPP_VERIFY_TOKEN is unset - webhook verification will use freddie\'s default token (set WHATSAPP_VERIFY_TOKEN to a real secret)'))
  }
  return { channels, skipped }
}

// AUTO-UPDATE (default ON): pull from origin on an interval and let the pulled
// source's mtime change (and the post-merge hook) trigger the supervisor's
// hot-reload, so a pushed commit lands on the live worker with NO manual restart
// -- the whole point of running supervised. Runs in the supervisor PARENT (which
// never re-imports app code, so it is safe across reloads). It is SAFE on a dev
// checkout: `git pull --ff-only` REFUSES on a dirty or divergent tree ("your
// local changes would be overwritten" / "not possible to fast-forward") and
// leaves the working tree untouched -- a dev with uncommitted edits or local
// commits simply gets a skipped pull, logged, never a clobber. Opt OUT with
// CASEY_AUTO_UPDATE=0 or --no-auto-update (e.g. an offline box, or to pin code);
// tune CASEY_AUTO_UPDATE_INTERVAL_MS (default 60000). If git hooks are not armed,
// the pull still rewrites src/*.js whose mtime the supervisor watches.
async function startAutoUpdate() {
  const { execFile } = await import('node:child_process')
  const interval = Number(process.env.CASEY_AUTO_UPDATE_INTERVAL_MS) || 60_000
  const repoRoot = ROOT
  let warnedSkip = false
  const git = (args) => new Promise((resolve) => execFile('git', args, { cwd: repoRoot }, (err, stdout, stderr) =>
    resolve({ err, out: String(stdout || ''), errText: String(stderr || (err && err.message) || '') })))
  // fetch + `merge --ff-only @{u}` rather than `git pull --ff-only`: a bare pull
  // fails with "Cannot fast-forward to multiple branches" when FETCH_HEAD carries
  // several refs (the origin refspec fetches every branch), which was making the
  // deploy loop log a failure every interval. fetch-then-merge-the-upstream is
  // unambiguous. A dirty/divergent/detached tree makes merge --ff-only REFUSE and
  // leaves the working tree untouched -- EXPECTED on a dev box, so it is a quiet
  // one-time note + retry, never a clobber and never a scary error.
  const pull = async () => {
    const f = await git(['fetch', '--quiet', 'origin'])
    if (f.err) { if (!warnedSkip) { warnedSkip = true; console.error(dim('[auto-update] fetch failed (will retry): ' + f.errText.split('\n')[0])) } return }
    const m = await git(['merge', '--ff-only', '@{u}'])
    if (m.err) {
      // Any non-fast-forwardable state (local edits, local commits, detached,
      // no upstream) -- skip quietly and keep the box on its current code.
      if (!warnedSkip) { warnedSkip = true; console.log(dim('[auto-update] cannot fast-forward (local changes or diverged); staying on current code, will retry when clean.')) }
      return
    }
    warnedSkip = false
    if (/Updating|Fast-forward/.test(m.out)) console.log(green('[auto-update] pulled new code; the worker will reload.'))
  }
  console.log(`  auto-update: ${green('on')}${dim(`   (fetch + fast-forward every ${Math.round(interval / 1000)}s; the worker reloads on the new code -- opt out: CASEY_AUTO_UPDATE=0)`)}`)
  // Do NOT pull immediately at boot: a fast-forward would fire a RELOAD_REQUESTED
  // while the supervisor is still in 'booting' (an illegal-transition warning, and
  // the reload is dropped anyway). The worker boots on current code; the first
  // pull runs one interval later, once it is healthy.
  return setInterval(pull, interval)
}

// Supervised path (default): a parent supervisor forks the serving worker
// (bin/worker.js = gateway + dashboard + store), watches src/ for changes, and
// drain-respawns the worker on a source change (live reload) or a crash. The
// worker reopens the same cwd-bound app.db every time, so the case store
// survives every restart -- this is the "never manually restart again" path.
async function upSupervised(flags, channels, skipped) {
  const { createSupervisor } = await import('../src/supervisor.js')
  const dashPort = Number(flags.port || 4000)
  // Pass the operator's flags through to every worker the supervisor forks.
  const workerArgs = ['--channels', channels.join(','), '--port', String(dashPort)]
  const reload = !flags['no-reload']
  const sup = createSupervisor({ workerArgs, reload })
  console.log(bold('casey up') + dim(`  v${pkgVersion()}`) + dim('  (supervised)'))
  console.log(`  channels: ${green(channels.join(', '))}` + (skipped.length ? dim(`   (skipped, no creds: ${skipped.join(', ')} - run casey doctor)`) : ''))
  console.log(`  dashboard: ${cyan(`http://localhost:${dashPort}`)} ${dim('(login required)')}`)
  console.log(`  data: ${dim(path.join(process.cwd(), 'data'))}`)
  console.log(reload
    ? `  live reload: ${green('on')}${dim('   (edits to src/ restart the worker automatically; same store, no data lost)')}`
    : `  live reload: ${yellow('off')}${dim('   (--no-reload: restart manually to pick up code changes)')}`)
  console.log(dim('  press ctrl-c to stop'))
  await sup.start()
  let autoUpdateTimer = null
  const autoUpdate = !flags['no-auto-update'] && process.env.CASEY_AUTO_UPDATE !== '0'
  if (autoUpdate) autoUpdateTimer = await startAutoUpdate()
  let exiting = false
  const shutdown = async () => {
    if (exiting) return
    exiting = true
    if (autoUpdateTimer) clearInterval(autoUpdateTimer)
    try { await sup.stop() } catch (e) { console.error('shutdown error:', e.message) }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// Legacy single-process path (--no-supervise): build casey inline, no parent,
// no live reload. Kept for debugging -- a code change here needs a manual restart.
// Uses the SAME makeResilientCallLLM wiring bin/worker.js's supervised path
// uses (previously a one-shot resolveCallLLM + a hand-rolled llmStatus that
// never returned a `degraded` key) -- without this, case-intake.js's LLM-down
// queue-gate branch never fires (llmStatus was null-shaped for it),
// drainQueuedTurns' status gate had nothing to fall back to, and GET
// /api/health's degraded field was hardcoded false so the amber "AI helper:
// slow" pill could never appear under --no-supervise.
async function upInProcess(flags, channels, skipped) {
  const { makeResilientCallLLM } = await import('../src/llm.js')
  let caseyRef = null
  const brainResilient = makeResilientCallLLM({
    probe: true,
    onRecover: () => caseyRef?.drainQueuedTurns?.().catch(e => caseyRef?.log?.warn?.('[casey] recovery drain failed', { error: e.message })),
  })
  const casey = await createCasey({ channels, callLLM: brainResilient.callLLM, llmStatus: brainResilient.status })
  caseyRef = casey
  // Force one status() read before start() so a message arriving in the
  // first seconds after boot does not race the readiness system's own cold
  // start -- same fix bin/worker.js already applies.
  const brain = await brainResilient.status().catch(() => ({ source: 'none' }))
  await casey.start()
  const dashPort = Number(flags.port || 4000)
  const sendReply = makeSendReply(casey)
  let dash
  try {
    dash = await createDashboard(casey.store, { port: dashPort, sendReply, llmStatus: brainResilient.status, runSweep: () => casey.runSweepOnce(), receiveStatus: () => casey.receiveStatus() })
  } catch (e) {
    console.log(bad(`dashboard failed to bind port ${dashPort}: ${e.message} - start with --port <other>`))
    try { await casey.stop() } catch (e2) { console.error('shutdown error:', e2.message) }
    process.exit(1)
  }
  console.log(bold('casey up') + dim(`  v${pkgVersion()}`))
  console.log(`  channels: ${green(channels.join(', '))}` + (skipped.length ? dim(`   (skipped, no creds: ${skipped.join(', ')} - run casey doctor)`) : ''))
  if (brain.source === 'acptoapi') console.log(`  AI helper: ${green('online')}${dim(`   (${brain.model} via ${brain.url || 'in-process bridge'})`)}`)
  else console.log(`  AI helper: ${yellow('offline')}${dim('   (auto-replies paused; no message is sent, messages queue and re-drive once the provider recovers.)')}`)
  console.log(`  dashboard: ${cyan(`http://localhost:${dash.port}`)} ${dim('(login required)')}`)
  console.log(`  data: ${dim(path.join(process.cwd(), 'data'))}`)
  console.log(dim('  press ctrl-c to stop'))
  // Guard against a double Ctrl-C: the second SIGINT must not call process.exit
  // while the first is still flushing the WAL and draining in-flight turns.
  let exiting = false
  process.on('SIGINT', async () => {
    if (exiting) return
    exiting = true
    try {
      await dash.close()
      await casey.stop()
    } catch (e) {
      console.error('shutdown error:', e.message)
    }
    process.exit(0)
  })
}

export async function cmdUp({ flags }) {
  if (flags.help) { console.log(UP_HELP); return }
  const { channels, skipped } = resolveChannels(flags)
  const supervise = !flags['no-supervise']
  if (supervise) return upSupervised(flags, channels, skipped)
  return upInProcess(flags, channels, skipped)
}

export async function cmdDashboard({ flags }) {
  if (flags.help) { console.log('casey dashboard [--port 4000]\n  Start only the observe/edit dashboard against the existing store.'); return }
  // Same eager-validation discipline as bin/worker.js's own
  // CASEY_EXTRA_DASHBOARD_ROUTES handling: a mistyped path throws a named
  // error at boot rather than silently mounting nothing.
  const extraDashboardRoutes = (() => {
    if (!process.env.CASEY_EXTRA_DASHBOARD_ROUTES) return null
    const p = path.resolve(process.env.CASEY_EXTRA_DASHBOARD_ROUTES)
    if (!existsSync(p)) throw new Error(`CASEY_EXTRA_DASHBOARD_ROUTES not found: ${p}`)
    return p
  })()
  const store = createCaseStore(); await store.init()
  const { ensureBootstrapAdmin } = await import('../src/dashboard/auth.js')
  const boot = await ensureBootstrapAdmin(store, console)
  if (boot) console.log(green(`bootstrap admin account created -- username: ${bold(boot.username)}  password: ${bold(boot.password)}`) + dim('  (log in once and create named accounts for your team)'))
  let dash
  try {
    dash = await createDashboard(store, { port: Number(flags.port || 4000) })
  } catch (e) {
    console.log(bad(`dashboard failed to bind port ${Number(flags.port || 4000)}: ${e.message} - start with --port <other>`))
    await closeAndExit(store, 1)
  }
  if (extraDashboardRoutes) {
    const mod = await import(pathToFileURL(extraDashboardRoutes).href)
    const mount = mod.default
    if (typeof mount !== 'function') throw new Error(`CASEY_EXTRA_DASHBOARD_ROUTES module has no default export function: ${extraDashboardRoutes}`)
    await mount(dash.app, { store })
    // Same post-mount error-sanitizing safety net as bin/worker.js: a
    // deployer route mounted after createDashboard resolves sits past
    // dashboard/server.js's own error middleware (Express error middleware
    // only catches routes registered before it), so an unguarded throw or
    // explicit next(err) would otherwise fall through to Express's default
    // handler and render a stack trace with absolute filesystem paths.
    dash.app.use((err, req, res, next) => {
      if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid request body' })
      res.status(err?.status || 500).json({ error: 'internal error' })
    })
  }
  console.log(`dashboard: ${cyan(`http://localhost:${dash.port}`)}  ${dim('(ctrl-c to stop)')}`)
  // What this mode CANNOT do, said once, plainly, at boot.
  //
  // createDashboard above is called with {port} alone -- no sendReply,
  // llmStatus, runSweep, receiveStatus, runtimeStatus or queueStatus (compare
  // cmdUp/bin/worker.js, which pass all six). Every one of those is a real
  // capability that silently disappears here, and until this block existed the
  // only way an operator learned about any of them was to press a control and
  // read a refusal. This is a MODE, not a fault, which is the same distinction
  // operations.js's LLM_HEALTH_VIEWS 'unwired' view draws for the AI helper --
  // stated here for the whole set. Keep the three lists in step: this block,
  // that view's detail text, and /api/health's `capabilities`.
  console.log(`${yellow('dashboard-only mode')}${dim('   (reads and edits the store; not attached to a running agent)')}`)
  console.log(dim('  not available here: sending a reply to a contact, AI-helper status, message-channel'))
  console.log(dim('  receive status, queued/dead-lettered message counts, supervisor runtime state, Sweep now.'))
  console.log(dim('  Controls that need them are hidden rather than shown and refused; a reply typed here is'))
  console.log(dim('  recorded on the timeline as unsent, never as delivered. All of it keeps working wherever'))
  console.log(dim('  `casey up` is running. Everything that reads the store is unaffected.'))
  process.on('SIGINT', async () => {
    try {
      await dash.close()
    } catch (e) {
      console.error('shutdown error:', e.message)
    }
    await closeAndExit(store, 0)
  })
}
