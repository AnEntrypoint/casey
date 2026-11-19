
import { createCasey } from '../src/casey.js'
import { createCaseStore } from '../src/case-store.js'
import { createDashboard } from '../src/dashboard/server.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, bold, dim, green, yellow, cyan, bad, warn, say, pkgVersion, hasCreds, closeAndExit } from './casey-cli-ui.js'
import { makeSendReply } from './send-reply.js'
import { caseyText } from '../src/deployment-text.js';

function resolveChannels(flags) {
  const requested = (flags.channels || 'discord,whatsapp').split(',').map(s => s.trim()).filter(Boolean)
  if (hasCreds('whatsapp') && !process.env.WHATSAPP_APP_SECRET) {
    const idx = requested.indexOf('whatsapp')
    if (idx !== -1 && flags.channels) {
      say(bad(caseyText("bin/casey-serve.js#w0")))
      process.exit(1)
    }
    if (idx !== -1) { requested.splice(idx, 1); say(warn(caseyText("bin/casey-serve.js#w1"))) }
  }
  const channels = requested.filter(ch => hasCreds(ch))
  const skipped = requested.filter(ch => !hasCreds(ch))
  if (!channels.length) { say(bad(caseyText("bin/casey-serve.js#w2"))); process.exit(1) }
  if (channels.includes('whatsapp') && !process.env.WHATSAPP_VERIFY_TOKEN) {
    const idx = channels.indexOf('whatsapp')
    if (flags.channels) {
      say(bad(caseyText("bin/casey-serve.js#w3")))
      process.exit(1)
    }
    channels.splice(idx, 1)
    skipped.push('whatsapp')
    say(warn(caseyText("bin/casey-serve.js#w4")))
    if (!channels.length) { say(bad(caseyText("bin/casey-serve.js#w5"))); process.exit(1) }
  }
  return { channels, skipped }
}

async function startAutoUpdate() {
  const { execFile } = await import('node:child_process')
  const interval = Number(process.env.CASEY_AUTO_UPDATE_INTERVAL_MS) || 60_000
  const repoRoot = ROOT
  if (!existsSync(path.join(repoRoot, '.git'))) {
    console.log(`  auto-update: ${yellow('off')}${dim(caseyText("bin/casey-serve.js#w6"))}`)
    return null
  }
  let warnedSkip = false
  const git = (args) => new Promise((resolve) => execFile('git', args, { cwd: repoRoot }, (err, stdout, stderr) =>
    resolve({ err, out: String(stdout || ''), errText: String(stderr || (err && err.message) || '') })))
  const pull = async () => {
    const f = await git(['fetch', '--quiet', 'origin'])
    if (f.err) { if (!warnedSkip) { warnedSkip = true; console.error(dim(caseyText("bin/casey-serve.js#w7") + f.errText.split('\n')[0])) } return }
    const m = await git(['merge', '--ff-only', '@{u}'])
    if (m.err) {
      if (!warnedSkip) { warnedSkip = true; console.log(dim(caseyText("bin/casey-serve.js#w8"))) }
      return
    }
    warnedSkip = false
    if (/Updating|Fast-forward/.test(m.out)) console.log(green(caseyText("bin/casey-serve.js#w9")))
  }
  console.log(`  auto-update: ${green('on')}${dim(caseyText("bin/casey-serve.js#w10", [Math.round(interval / 1000)]))}`)
  return setInterval(pull, interval)
}

async function upSupervised(flags, channels, skipped) {
  const { createSupervisor } = await import('../src/supervisor.js')
  const dashPort = Number(flags.port || 4000)
  const workerArgs = ['--channels', channels.join(','), '--port', String(dashPort)]
  const reload = !flags['no-reload']
  const sup = createSupervisor({ workerArgs, reload })
  console.log(bold(caseyText("bin/casey-serve.js#w11")) + dim(`  v${pkgVersion()}`) + dim('  (supervised)'))
  console.log(`  channels: ${green(channels.join(', '))}` + (skipped.length ? dim(caseyText("bin/casey-serve.js#w12", [skipped.join(', ')])) : ''))
  console.log(`  dashboard: ${cyan(`http://localhost:${dashPort}`)} ${dim(caseyText("bin/casey-serve.js#w13"))}`)
  console.log(`  data: ${dim(path.join(process.cwd(), 'data'))}`)
  console.log(reload
    ? caseyText("bin/casey-serve.js#w14", [green('on'), dim(caseyText("bin/casey-serve.js#w15"))])
    : caseyText("bin/casey-serve.js#w16", [yellow('off'), dim(caseyText("bin/casey-serve.js#w17"))]))
  console.log(dim(caseyText("bin/casey-serve.js#w18")))
  await sup.start()
  let autoUpdateTimer = null
  const autoUpdate = !flags['no-auto-update'] && process.env.CASEY_AUTO_UPDATE !== '0'
  if (autoUpdate) autoUpdateTimer = await startAutoUpdate()
  let exiting = false
  const shutdown = async () => {
    if (exiting) return
    exiting = true
    if (autoUpdateTimer) clearInterval(autoUpdateTimer)
    try { await sup.stop() } catch (e) { console.error(caseyText("bin/casey-serve.js#w19"), e.message) }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function upInProcess(flags, channels, skipped) {
  const { makeResilientCallLLM } = await import('../src/llm.js')
  let caseyRef = null
  const brainResilient = makeResilientCallLLM({
    probe: true,
    onRecover: () => caseyRef?.drainQueuedTurns?.().catch(e => caseyRef?.log?.warn?.(caseyText("bin/casey-serve.js#w20"), { error: e.message })),
  })
  const casey = await createCasey({ channels, callLLM: brainResilient.callLLM, llmStatus: brainResilient.status })
  caseyRef = casey
  const brain = await brainResilient.status().catch(() => ({ source: 'none' }))
  await casey.start()
  const dashPort = Number(flags.port || 4000)
  const sendReply = makeSendReply(casey)
  const { resolveAdapter } = await import('../src/hooks/delivery.js')
  let dash
  try {
    dash = await createDashboard(casey.store, { port: dashPort, sendReply, llmStatus: brainResilient.status, runSweep: () => casey.runSweepOnce(), receiveStatus: () => casey.receiveStatus(), resolveWhatsappAdapter: () => resolveAdapter(casey, 'whatsapp') })
  } catch (e) {
    say(bad(caseyText("bin/casey-serve.js#w21", [dashPort, e.message])))
    try { await casey.stop() } catch (e2) { console.error(caseyText("bin/casey-serve.js#w22"), e2.message) }
    process.exit(1)
  }
  console.log(bold(caseyText("bin/casey-serve.js#w23")) + dim(`  v${pkgVersion()}`))
  console.log(`  channels: ${green(channels.join(', '))}` + (skipped.length ? dim(caseyText("bin/casey-serve.js#w24", [skipped.join(', ')])) : ''))
  if (brain.source === 'acptoapi') console.log(caseyText("bin/casey-serve.js#w25", [green('online'), dim(`   (${brain.model} via ${brain.url || caseyText("bin/casey-serve.js#w26")})`)]))
  else console.log(caseyText("bin/casey-serve.js#w27", [yellow('offline'), dim(caseyText("bin/casey-serve.js#w28"))]))
  console.log(`  dashboard: ${cyan(`http://localhost:${dash.port}`)} ${dim(caseyText("bin/casey-serve.js#w29"))}`)
  console.log(`  data: ${dim(path.join(process.cwd(), 'data'))}`)
  console.log(dim(caseyText("bin/casey-serve.js#w30")))
  let exiting = false
  process.on('SIGINT', async () => {
    if (exiting) return
    exiting = true
    try {
      await dash.close()
      await casey.stop()
    } catch (e) {
      console.error(caseyText("bin/casey-serve.js#w31"), e.message)
    }
    process.exit(0)
  })
}

export async function cmdUp({ flags }) {
  const { channels, skipped } = resolveChannels(flags)
  const supervise = !flags['no-supervise']
  if (supervise) return upSupervised(flags, channels, skipped)
  return upInProcess(flags, channels, skipped)
}

export async function cmdDashboard({ flags }) {
  const extraDashboardRoutes = (() => {
    if (!process.env.CASEY_EXTRA_DASHBOARD_ROUTES) return null
    const p = path.resolve(process.env.CASEY_EXTRA_DASHBOARD_ROUTES)
    if (!existsSync(p)) throw new Error(`CASEY_EXTRA_DASHBOARD_ROUTES not found: ${p}`)
    return p
  })()
  const store = createCaseStore(); await store.init()
  const { ensureBootstrapAdmin } = await import('../src/dashboard/auth.js')
  const boot = await ensureBootstrapAdmin(store, console)
  if (boot) console.log(green(caseyText("bin/casey-serve.js#w32", [bold(boot.username)])) + dim(caseyText("bin/casey-serve.js#w33", [boot.passwordPath])))
  let dash
  try {
    dash = await createDashboard(store, { port: Number(flags.port || 4000) })
  } catch (e) {
    say(bad(caseyText("bin/casey-serve.js#w34", [Number(flags.port || 4000), e.message])))
    await closeAndExit(store, 1)
  }
  if (extraDashboardRoutes) {
    const mod = await import(pathToFileURL(extraDashboardRoutes).href)
    const mount = mod.default
    if (typeof mount !== 'function') throw new Error(`CASEY_EXTRA_DASHBOARD_ROUTES module has no default export function: ${extraDashboardRoutes}`)
    await mount(dash.app, { store })
    dash.app.use((err, req, res, next) => {
      if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: caseyText("bin/casey-serve.js#w35") })
      res.status(err?.status || 500).json({ error: caseyText("bin/casey-serve.js#w36") })
    })
  }
  console.log(`dashboard: ${cyan(`http://localhost:${dash.port}`)}  ${dim(caseyText("bin/casey-serve.js#w37"))}`)
  console.log(`${yellow(caseyText("bin/casey-serve.js#w38"))}${dim(caseyText("bin/casey-serve.js#w39"))}`)
  console.log(dim(caseyText("bin/casey-serve.js#w40")))
  console.log(dim(caseyText("bin/casey-serve.js#w41")))
  console.log(dim(caseyText("bin/casey-serve.js#w42")))
  console.log(dim(caseyText("bin/casey-serve.js#w43")))
  console.log(dim(caseyText("bin/casey-serve.js#w44")))
  process.on('SIGINT', async () => {
    try {
      await dash.close()
    } catch (e) {
      console.error(caseyText("bin/casey-serve.js#w45"), e.message)
    }
    await closeAndExit(store, 0)
  })
}
