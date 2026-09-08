// worker-dashboard.js  --  binding the operator dashboard, mounting a deployer's
// own extra routes onto it, and the one bootstrap-admin check that has to happen
// before anybody can log in.
//
// Split out of bin/worker.js verbatim, including the exit-code split that the
// supervisor depends on: a held port exits 44 (config-fatal, never retried),
// anything else exits 1 (a crash the budget counts).

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDashboard } from '../src/dashboard/server.js'
import { WORKER_MSG, ipcSend } from '../src/supervisor-ipc.js'

// A deployer package (e.g. serpent) can mount its OWN routes directly onto
// casey's real dashboard Express app -- same origin/port as the SPA and
// every existing /api/* route, so a same-origin relative fetch from the SPA
// can reach a deployer's own endpoint with zero proxy/second-port plumbing.
// CASEY_EXTRA_DASHBOARD_ROUTES is a deployer-set env var (same discipline as
// CASEY_CONFIG_DIR/CASEY_EXTRA_PLUGINS_DIR: never contact-influenced, only
// ever set by whoever starts the process) naming a module whose default
// export is `(app, {store}) => void`, called once after createDashboard
// resolves and after every existing route module (including auth.js's
// session-resolving middleware) is already registered -- so a mounted route
// can rely on req.caseyAccount exactly like casey's own route modules do.
// Validated eagerly at module load, matching CASEY_EXTRA_PLUGINS_DIR's own
// fail-loud discipline: a mistyped path throws a clear, named error at boot
// instead of silently mounting nothing. Absent, dashboard boot is
// byte-identical to before this existed.
const CASEY_EXTRA_DASHBOARD_ROUTES = (() => {
  if (!process.env.CASEY_EXTRA_DASHBOARD_ROUTES) return null
  const p = path.resolve(process.env.CASEY_EXTRA_DASHBOARD_ROUTES)
  if (!fs.existsSync(p)) throw new Error(`CASEY_EXTRA_DASHBOARD_ROUTES not found: ${p}`)
  return p
})()

// A fresh deployment (zero operator_account rows) gets a single bootstrap
// admin so there is always a way to log in -- printed once to the log, never
// persisted in plaintext, never re-created once any account exists.
async function ensureLoginExists(casey) {
  try {
    const { ensureBootstrapAdmin } = await import('../src/dashboard/auth.js')
    const boot = await ensureBootstrapAdmin(casey.store, console)
    if (boot) console.log(`[worker] bootstrap admin account created -- username: ${boot.username}  password: ${boot.password}  (log in once and create named accounts for your team)`)
  } catch (e) { console.error('[worker] bootstrap admin check failed:', e.message) }
}

async function mountExtraRoutes(dash, casey) {
  if (!CASEY_EXTRA_DASHBOARD_ROUTES) return
  const mod = await import(pathToFileURL(CASEY_EXTRA_DASHBOARD_ROUTES).href)
  const mount = mod.default
  if (typeof mount !== 'function') throw new Error(`CASEY_EXTRA_DASHBOARD_ROUTES module has no default export function: ${CASEY_EXTRA_DASHBOARD_ROUTES}`)
  await mount(dash.app, { store: casey.store })
  // dashboard/server.js's own error-sanitizing middleware is registered
  // LAST inside createDashboard() (Express error middleware only catches
  // errors from routes registered before it), so it is strictly unable to
  // catch anything thrown by a route mounted here, after createDashboard
  // already resolved. Register the SAME sanitizing behavior again, after
  // the deployer's routes, as a safety net -- a deployer route is expected
  // to handle its own errors (an unguarded async route handler that
  // rejects is an unhandled promise rejection long before it ever reaches
  // Express middleware -- see worker.js's crashLoud handler), but a
  // synchronous throw or an explicit next(err) call still must never fall
  // through to Express's own default handler, which renders a full stack
  // trace with absolute filesystem paths since casey never sets
  // NODE_ENV=production anywhere -- a real defect an independent
  // adversarial review caught.
  dash.app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid request body' })
    res.status(err?.status || 500).json({ error: 'internal error' })
  })
}

export async function startWorkerDashboard({ casey, port, sendReply, llmStatus, runtimeStatus, forked }) {
  await ensureLoginExists(casey)
  let dash
  try {
    dash = await createDashboard(casey.store, {
      port, sendReply, llmStatus,
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
    console.error(`[worker] dashboard failed to bind port ${port}: ${e.message}`)
    // A held port can never succeed by retrying the same port: exit with the
    // distinct config-fatal code so the supervisor stops instead of crash-looping
    // into the budget (witnessed: 5x EADDRINUSE re-forks -> degraded with no clear
    // message when a stale worker held the port).
    process.exit(/EADDRINUSE/.test(String(e && e.message)) ? 44 : 1)
  }
  await mountExtraRoutes(dash, casey)
  return dash
}
