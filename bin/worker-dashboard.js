import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDashboard } from '../src/dashboard/server.js'
import { resolveAdapter } from '../src/hooks/delivery.js'
import { WORKER_MSG, ipcSend } from '../src/supervisor-ipc.js'

const CASEY_EXTRA_DASHBOARD_ROUTES = (() => {
  if (!process.env.CASEY_EXTRA_DASHBOARD_ROUTES) return null
  const p = path.resolve(process.env.CASEY_EXTRA_DASHBOARD_ROUTES)
  if (!fs.existsSync(p)) throw new Error(`CASEY_EXTRA_DASHBOARD_ROUTES not found: ${p}`)
  return p
})()

async function ensureLoginExists(casey) {
  try {
    const { ensureBootstrapAdmin } = await import('../src/dashboard/auth.js')
    const boot = await ensureBootstrapAdmin(casey.store, console)
    if (boot) console.log(`[worker] bootstrap admin account created -- username: ${boot.username}  password written to ${boot.passwordPath}  (read it once, log in, set your own password, then delete that file)`)
  } catch (e) { console.error('[worker] bootstrap admin check failed:', e.message) }
}

async function mountExtraRoutes(dash, casey) {
  if (!CASEY_EXTRA_DASHBOARD_ROUTES) return
  const mod = await import(pathToFileURL(CASEY_EXTRA_DASHBOARD_ROUTES).href)
  const mount = mod.default
  if (typeof mount !== 'function') throw new Error(`CASEY_EXTRA_DASHBOARD_ROUTES module has no default export function: ${CASEY_EXTRA_DASHBOARD_ROUTES}`)
  await mount(dash.app, { store: casey.store })
  dash.app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid request body' })
    res.status(err?.status || 500).json({ error: 'internal error' })
  })
}

export async function startWorkerDashboard({ casey, port, sendReply, llmStatus, callLLM, runtimeStatus, forked }) {
  await ensureLoginExists(casey)
  let dash
  try {
    dash = await createDashboard(casey.store, {
      port, sendReply, llmStatus, callLLM,
      runSweep: () => casey.runSweepOnce(),
      receiveStatus: () => casey.receiveStatus(),
      runtimeStatus,
      queueStatus: () => casey.queueStatus(),
      alertWebhookUrl: process.env.CASEY_ALERT_WEBHOOK || process.env.CASEY_HANDOFF_WEBHOOK || null,
      resolveWhatsappAdapter: () => resolveAdapter(casey, 'whatsapp'),
    })
  } catch (e) {
    if (forked) ipcSend(process, WORKER_MSG.FATAL, { reason: `dashboard bind failed: ${e.message}` })
    console.error(`[worker] dashboard failed to bind port ${port}: ${e.message}`)
    process.exit(/EADDRINUSE/.test(String(e && e.message)) ? 44 : 1)
  }
  await mountExtraRoutes(dash, casey)
  return dash
}
