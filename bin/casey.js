#!/usr/bin/env node
// casey CLI  --  init / doctor / up / dashboard / sim / cases / show
//
// Friendliness lives here as much as in the dashboard: `casey init` scaffolds a
// .env so an operator never hand-writes one; `casey doctor` is a preflight that
// tells you exactly what is and isn't ready before you start; every command has
// --help, the output is colorized (unless NO_COLOR / non-TTY), and empty results
// come with a hint about what to do next instead of a bare "no cases".
import { createCasey } from '../src/casey.js'
import { createCaseStore } from '../src/case-store.js'
import { createDashboard } from '../src/dashboard/server.js'
import { fmtTimeSAST, fmtPhone27, hostTimezone, hostIsSAST, SAST_TZ } from '../src/format.js'
import { rankAttention } from '../src/attn.js'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// Load .env if present (Node 20.6+) so DISCORD_BOT_TOKEN etc. need no export.
try { if (existsSync(path.join(ROOT, '.env')) && process.loadEnvFile) process.loadEnvFile(path.join(ROOT, '.env')) } catch { /* ignore */ }

let [, , cmd, ...rest] = process.argv
// allow `casey --version` / `casey -v` / `casey --help` with no subcommand
if (cmd === '--version' || cmd === '-v') { cmd = 'version' }
if (cmd === '--help' || cmd === '-h') { cmd = 'help' }

// tiny terminal colorizer (respects NO_COLOR and non-TTY)
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR
const c = (code) => (s) => COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s)
const bold = c('1'), dim = c('2'), green = c('32'), red = c('31'), yellow = c('33'), cyan = c('36')
const ok = (s) => `${green('[ok]')} ${s}`
const bad = (s) => `${red('[x]')} ${s}`
const warn = (s) => `${yellow('!')} ${s}`

function pkgVersion() {
  try { return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version } catch { return '?' }
}

function parseFlags(args) {
  const f = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const k = args[i].slice(2)
      const v = args[i + 1] && !args[i + 1].startsWith('--') ? args[(i++, i)] : true
      f[k] = v
    } else if (args[i] === '-h') f.help = true
    else if (args[i] === '-v') f.version = true
  }
  return f
}

function hasCreds(ch) {
  if (ch === 'discord') return !!process.env.DISCORD_BOT_TOKEN
  if (ch === 'whatsapp') return !!(process.env.WHATSAPP_API_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID)
  return false
}
// partial creds = configured-but-incomplete; doctor must flag this, not show green.
function partialCreds(ch) {
  if (ch === 'whatsapp') {
    const a = !!process.env.WHATSAPP_API_TOKEN, b = !!process.env.WHATSAPP_PHONE_NUMBER_ID
    return (a || b) && !(a && b)
  }
  return false
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => { s.close?.(); resolve(false) })
    s.once('listening', () => s.close(() => resolve(true)))
    s.listen(port, '127.0.0.1')
  })
}

const ENV_TEMPLATE = `# casey environment -- fill in the channels you want, leave the rest blank.
# Discord:
DISCORD_BOT_TOKEN=

# WhatsApp Cloud API (both required to enable the real channel):
WHATSAPP_API_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
# Required when WhatsApp credentials are set (HMAC-SHA256 webhook signature check):
WHATSAPP_APP_SECRET=
# Webhook verification handshake token (set in the Meta developer console):
WHATSAPP_VERIFY_TOKEN=
# Fix the public-facing webhook port/path (useful behind a reverse proxy or ngrok):
#WHATSAPP_WEBHOOK_PORT=4001
#WHATSAPP_WEBHOOK_PATH=/whatsapp

# Dashboard: require a token to open the dashboard (strongly recommended in production):
CASEY_DASHBOARD_TOKEN=

# Public URL of this casey instance (optional). When set, the agent mentions it
# to the contact on first message so they can fill in more details via the web form:
#CASEY_PUBLIC_URL=https://your-domain.example.com

# Development overrides:
#CASEY_STUB_LLM=1    # run fully offline with a deterministic stub model
#CASEY_LOG=silent    # suppress structured JSON logs (used by tests)
`

const HELP = `${bold('casey')} ${dim('v' + pkgVersion())}  --  agentic case tracking over WhatsApp/Discord

${bold('usage:')}
  casey init                                    scaffold a .env you can fill in
  casey doctor                                  preflight: what's ready, what's missing
  casey up [--channels sim,discord,whatsapp] [--port 4000]   start gateway + dashboard
  casey dashboard [--port 4000]                 start only the observe/edit dashboard
  casey sim ["message" ...] [--scenario <name>] run a simulated conversation (or a built-in persona)
  casey cases [--status <stage>]                list cases
  casey show <ref|id>                           show a case + timeline
  casey attention [--limit N --offset N --json] worst-first inbox: who needs a person now, and why
  casey handover [--json] / handover start      shift digest: what to pick up; 'start' stamps a new shift
  casey health                                  read-only guardrail summary (no changes written)
  casey sweep                                   run the health-guardrail sweep once now (writes tags/observations)
  casey transition <ref|id> <stage> [--reason]  move a case to a stage (legality-checked)

${bold('flags:')} --help / -h on any command, --version / -v

${bold('channels (set in .env or the environment):')}
  DISCORD_BOT_TOKEN                             enable discord
  WHATSAPP_API_TOKEN, WHATSAPP_PHONE_NUMBER_ID  enable whatsapp
  CASEY_DASHBOARD_TOKEN                          require a token to open the dashboard

${dim('new here? run')} ${cyan('casey init')} ${dim('then')} ${cyan('casey doctor')} ${dim('then')} ${cyan('casey up')}`

async function main() {
  const flags = parseFlags(rest)
  if (flags.version || cmd === 'version') { console.log(pkgVersion()); return }
  if (cmd === 'help' || flags.help && !cmd) { console.log(HELP); return }

  if (cmd === 'init') {
    const dest = path.join(ROOT, '.env')
    if (existsSync(dest)) { console.log(warn(`.env already exists at ${dest} - leaving it untouched.`)); return }
    writeFileSync(dest, ENV_TEMPLATE)
    console.log(ok(`wrote ${cyan(dest)}`))
    console.log(`  Fill in the channel(s) you want, then run ${cyan('casey doctor')} to check it.`)
    return
  }

  if (cmd === 'doctor') {
    console.log(bold('casey doctor') + dim(`  v${pkgVersion()}`))
    let problems = 0
    // Node version
    const major = Number(process.versions.node.split('.')[0])
    console.log(major >= 22 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} (need >=22)`))
    if (major < 22) problems++
    // .env presence
    console.log(existsSync(path.join(ROOT, '.env')) ? ok('.env present') : warn(`.env missing - run ${cyan('casey init')} (channels can still come from the environment)`))
    // dependencies resolve
    for (const dep of ['thatcher', 'freddie', 'express']) {
      try { await import(dep); console.log(ok(`dependency ${dep} resolves`)) }
      catch { console.log(bad(`dependency ${dep} does not resolve - run npm install`)); problems++ }
    }
    // channels
    for (const ch of ['discord', 'whatsapp']) {
      if (hasCreds(ch)) console.log(ok(`channel ${ch}: credentials present`))
      else if (partialCreds(ch)) { console.log(bad(`channel ${ch}: partial credentials - set BOTH WHATSAPP_API_TOKEN and WHATSAPP_PHONE_NUMBER_ID`)); problems++ }
      else console.log(dim(`  channel ${ch}: not configured (optional)`))
    }
    // The WhatsApp webhook trusts unsigned bodies when WHATSAPP_APP_SECRET is
    // unset (freddie verifies the X-Hub-Signature-256 HMAC only when the secret
    // is present). Without it anyone who can reach the webhook can forge inbound
    // farmer messages, so flag it loudly when the channel is otherwise live.
    if (hasCreds('whatsapp') && !process.env.WHATSAPP_APP_SECRET) {
      console.log(bad('WHATSAPP_APP_SECRET is required to enable WhatsApp (verify inbound webhook signatures)'))
      problems++
    }
    if (!hasCreds('discord') && !hasCreds('whatsapp')) console.log(warn('no real channel connected - only the offline sim will run'))
    // thatcher config
    const cfgFile = path.join(ROOT, 'thatcher.config.yml')
    console.log(existsSync(cfgFile) ? ok('thatcher.config.yml present') : bad('thatcher.config.yml missing - casey will fail to start (see README Layout section)'))
    if (!existsSync(cfgFile)) problems++
    // Validate the workflow stage graph the same way init() does, but without
    // booting thatcher or touching a DB (pure config read). A broken graph
    // (unknown transition target, status enum missing a stage) otherwise passes
    // doctor green and only crashes at `casey up`.
    else {
      try {
        createCaseStore({ config: cfgFile }).validateConfig()
        console.log(ok('case store / workflow config valid'))
      } catch (e) {
        console.log(bad(`case store / workflow config: ${e.message}`))
        problems++
      }
    }
    // dashboard token
    console.log(process.env.CASEY_DASHBOARD_TOKEN ? ok('dashboard token set (auth required)') : warn('CASEY_DASHBOARD_TOKEN unset -- dashboard is open to anyone on the network (set a token for production use)'))
    // public URL (optional but useful)
    console.log(process.env.CASEY_PUBLIC_URL ? ok(`CASEY_PUBLIC_URL set (${process.env.CASEY_PUBLIC_URL})`) : dim('  CASEY_PUBLIC_URL unset - contacts will not receive a web form link (optional)'))
    // host timezone -- casey always renders absolute times in SAST regardless of
    // the host clock, so a non-SAST host is fine (not a problem), but flag it so
    // an operator reading raw OS timestamps elsewhere knows the offset.
    console.log(hostIsSAST() ? ok(`host timezone is SAST (${SAST_TZ})`) : warn(`host timezone is ${hostTimezone() || 'unknown'}, not ${SAST_TZ} - casey still shows all times in SAST, but your OS clock differs`))
    // alert webhook -- high-severity guardrail breaches page the team here during
    // a sweep; falls back to the handoff webhook. Optional: without either, breaches
    // still surface in the dashboard inbox, they just do not push a notification.
    const alertHook = process.env.CASEY_ALERT_WEBHOOK || process.env.CASEY_HANDOFF_WEBHOOK
    console.log(alertHook
      ? ok(`breach alerts on${process.env.CASEY_ALERT_WEBHOOK ? ' CASEY_ALERT_WEBHOOK' : ' CASEY_HANDOFF_WEBHOOK (fallback)'}`)
      : dim('  CASEY_ALERT_WEBHOOK unset - sweep breaches surface in the inbox but do not push an alert (optional)'))
    // data dir -- where the live case store lives (cwd-bound)
    const dataDir = path.join(process.cwd(), 'data')
    const dbFile = path.join(dataDir, 'app.db')
    console.log(existsSync(dbFile)
      ? ok(`case data at ${dbFile} (test.js isolates to a temp cwd, so it will not wipe this)`)
      : dim(`  no case data yet (will be created at ${dbFile})`))
    // port
    const port = Number(flags.port || 4000)
    console.log(await portFree(port) ? ok(`port ${port} is free`) : bad(`port ${port} is in use - start with --port <other>`))
    console.log(problems ? red(`\n${problems} problem(s) to fix before ${cyan('casey up')}`) : green('\nall good - run casey up'))
    process.exit(problems ? 1 : 0)
  }

  if (cmd === 'up') {
    if (flags.help) { console.log('casey up [--channels sim,discord,whatsapp] [--port 4000] [--no-reload] [--no-supervise]\n  Start the gateway (all configured channels) and the dashboard.\n  Supervised by default: the worker auto-restarts on a source change (live reload) or a crash,\n  reopening the same case store so nothing is lost. --no-reload disables the watcher (explicit\n  restarts only); --no-supervise runs the legacy single-process path for debugging.'); return }
    const requested = (flags.channels || 'sim,discord,whatsapp').split(',').map(s => s.trim()).filter(Boolean)
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
    const channels = requested.filter(ch => ch === 'sim' || hasCreds(ch))
    const skipped = requested.filter(ch => ch !== 'sim' && !hasCreds(ch))
    if (!channels.length) { console.log(bad('no channels available - set credentials or include sim in --channels')); process.exit(1) }

    // Supervised path (default): a parent supervisor forks the serving worker
    // (bin/worker.js = gateway + dashboard + store), watches src/ for changes, and
    // drain-respawns the worker on a source change (live reload) or a crash. The
    // worker reopens the same cwd-bound app.db every time, so the case store
    // survives every restart -- this is the "never manually restart again" path.
    const supervise = !flags['no-supervise']
    if (supervise) {
      const { createSupervisor } = await import('../src/supervisor.js')
      const dashPort = Number(flags.port || 4000)
      // Pass the operator's flags through to every worker the supervisor forks.
      const workerArgs = ['--channels', channels.join(','), '--port', String(dashPort)]
      const reload = !flags['no-reload']
      const sup = createSupervisor({ workerArgs, reload })
      console.log(bold('casey up') + dim(`  v${pkgVersion()}`) + dim('  (supervised)'))
      console.log(`  channels: ${green(channels.join(', '))}` + (skipped.length ? dim(`   (skipped, no creds: ${skipped.join(', ')} - run casey doctor)`) : ''))
      const tokenNote = process.env.CASEY_DASHBOARD_TOKEN ? ` ${dim('(token required)')}` : ` ${yellow('(open - set CASEY_DASHBOARD_TOKEN)')}`
      console.log(`  dashboard: ${cyan(`http://localhost:${dashPort}`)}${tokenNote}`)
      console.log(`  data: ${dim(path.join(process.cwd(), 'data'))}`)
      console.log(reload
        ? `  live reload: ${green('on')}${dim('   (edits to src/ restart the worker automatically; same store, no data lost)')}`
        : `  live reload: ${yellow('off')}${dim('   (--no-reload: restart manually to pick up code changes)')}`)
      console.log(dim('  press ctrl-c to stop'))
      await sup.start()
      let exiting = false
      const shutdown = async () => {
        if (exiting) return
        exiting = true
        try { await sup.stop() } catch (e) { console.error('shutdown error:', e.message) }
        process.exit(0)
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
      return
    }

    // Legacy single-process path (--no-supervise): build casey inline, no parent,
    // no live reload. Kept for debugging -- a code change here needs a manual restart.
    const { resolveCallLLM } = await import('../src/llm.js')
    // A probe failure must degrade to honest offline mode, never crash `up` with
    // a raw stack trace before the gateway is even started (P9 graceful degradation).
    const brain = await resolveCallLLM({ probe: true }).catch(() => ({ callLLM: null, source: 'none' }))
    const casey = await createCasey({ channels, callLLM: brain.callLLM })
    await casey.start()
    const dashPort = Number(flags.port || 4000)
    const sendReply = (caseRow, text) => {
      const a = casey.adapters[caseRow.channel]
      return a?.send ? a.send({ to: caseRow.external_id, text }) : Promise.resolve()
    }
    // Health pill re-resolves live so an operator sees acptoapi going up/down
    // without restarting casey. Stub stays reported as stub (it never probes).
    const { resolveCallLLM: _rc } = await import('../src/llm.js')
    const llmStatus = async () => {
      if (process.env.CASEY_STUB_LLM) return { source: 'stub' }
      const b = await _rc({ probe: true }).catch(() => ({ source: 'none' }))
      return { source: b.source, model: b.model, url: b.url }
    }
    let dash
    try {
      dash = await createDashboard(casey.store, { port: dashPort, sendReply, llmStatus, runSweep: () => casey.runSweepOnce(), receiveStatus: () => casey.receiveStatus() })
    } catch (e) {
      console.log(bad(`dashboard failed to bind port ${dashPort}: ${e.message} - start with --port <other>`))
      process.exit(1)
    }
    console.log(bold('casey up') + dim(`  v${pkgVersion()}`))
    console.log(`  channels: ${green(channels.join(', '))}` + (skipped.length ? dim(`   (skipped, no creds: ${skipped.join(', ')} - run casey doctor)`) : ''))
    if (brain.source === 'acptoapi') console.log(`  AI helper: ${green('online')}${dim(`   (${brain.model} via ${brain.url})`)}`)
    else if (brain.source === 'stub') console.log(`  AI helper: ${yellow('test stub')}${dim('   (offline fake replies - for testing only)')}`)
    else console.log(`  AI helper: ${yellow('offline')}${dim('   (auto-replies paused; contacts get a holding message and wait for a person. Start acptoapi to enable AI.)')}`)
    if (channels.length === 1 && channels[0] === 'sim') console.log(warn('only the offline sim is active - no real messages will arrive. Connect a channel in .env.'))
    const tokenNote = process.env.CASEY_DASHBOARD_TOKEN ? ` ${dim('(token required)')}` : ` ${yellow('(open - set CASEY_DASHBOARD_TOKEN)')}`
    console.log(`  dashboard: ${cyan(`http://localhost:${dash.port}`)}${tokenNote}`)
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
    return
  }

  if (cmd === 'dashboard') {
    if (flags.help) { console.log('casey dashboard [--port 4000]\n  Start only the observe/edit dashboard against the existing store.'); return }
    const store = createCaseStore(); await store.init()
    let dash
    try {
      dash = await createDashboard(store, { port: Number(flags.port || 4000) })
    } catch (e) {
      console.log(bad(`dashboard failed to bind port ${Number(flags.port || 4000)}: ${e.message} - start with --port <other>`))
      process.exit(1)
    }
    console.log(`dashboard: ${cyan(`http://localhost:${dash.port}`)}  ${dim('(ctrl-c to stop)')}`)
    process.on('SIGINT', async () => {
      try {
        await dash.close()
      } catch (e) {
        console.error('shutdown error:', e.message)
      }
      process.exit(0)
    })
    return
  }

  if (cmd === 'sim') {
    const { runScript } = await import('../src/sim/inject.js')
    const { stubLLM } = await import('../src/sim/stub-llm.js')
    const { getScenario, scenarioNames } = await import('../src/sim/scenarios.js')
    if (flags.help) {
      console.log('casey sim ["message" ...] [--scenario <name>] [--intake]')
      console.log('  Run an offline simulated conversation against the stub model.')
      console.log('  --intake  exercises the non-AI manual intake flow (dashboard API POST /api/cases)')
      console.log('  --scenario replays a built-in low-literacy persona. Available:')
      for (const n of scenarioNames()) console.log(`    ${cyan(n)}`)
      return
    }

    // --intake: exercise the non-AI manual-intake flow via the dashboard API.
    // Starts a minimal casey instance + dashboard on a temporary port, posts a
    // case and report fields, prints the result, then shuts down.
    if (flags.intake) {
      const { createDashboard } = await import('../src/dashboard/server.js')
      const store = createCaseStore()
      await store.init()
      const dash = await createDashboard(store, { port: 0, token: '' }).catch(e => { console.log(bad('dashboard failed: ' + e.message)); process.exit(1) })
      const base = `http://localhost:${dash.server.address().port}`
      console.log(dim(`dashboard on ${base} (ephemeral)`))
      // POST /api/cases: create the case. 409 = already exists, use that id.
      const name = rest.filter(a => !a.startsWith('--'))[0] || 'Sim Farmer'
      const phone = rest.filter(a => !a.startsWith('--'))[1] || '0821234567'
      const caseR = await fetch(`${base}/api/cases`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, phone, subject: 'Sim intake test' }) })
      const cj = await caseR.json().catch(() => ({}))
      if (caseR.status === 409) {
        console.log(dim(`case already exists for ${phone}: ${cj.existing_ref} -- using it`))
        cj.id = cj.existing_id; cj.ref = cj.existing_ref
      } else if (!caseR.ok) { console.log(bad('POST /api/cases failed: ' + (cj.error || caseR.status))); await dash.close(); process.exit(1) }
      const c = cj
      console.log(green(`created: ${c.ref}  id=${c.id}  tags=${c.tags||'(existing)'}`))
      // POST /api/cases/:id/intake: fill report fields
      const intakeR = await fetch(`${base}/api/cases/${c.id}/intake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ species: 'cattle', symptoms: 'drooling, limping', location: 'near Musina', how_to_find: 'farm gate on R572', affected_count: '6', farmer_available: 'yes' }) })
      if (!intakeR.ok) { const e = await intakeR.json().catch(() => ({})); console.log(bad('POST /intake failed: ' + (e.error || intakeR.status))); await dash.close(); process.exit(1) }
      const ij = await intakeR.json()
      console.log(green(`intake saved  fill=${ij.report_fill_rate?.filled}/${ij.report_fill_rate?.total_fields}  visit-critical=${ij.report_fill_rate?.visit_critical_filled}/${ij.report_fill_rate?.visit_critical_total}`))
      console.log(dim('--- report ---'))
      for (const [k, v] of Object.entries(ij.report || {})) if (v != null && v !== '') console.log(`  ${dim(k.padEnd(20))} ${v}`)
      await dash.close()
      await store.close()
      process.exit(0)
    }
    // Decide the script: --scenario <name> wins; else positional messages; else
    // the default order-is-late demo. Positional args keep working unchanged.
    let script
    if (flags.scenario) {
      const picked = getScenario(flags.scenario === true ? '' : flags.scenario)
      if (!picked) {
        console.log(red(`unknown scenario: ${flags.scenario}`))
        console.log(dim('  available: ') + scenarioNames().map(cyan).join(', '))
        process.exit(1)
      }
      console.log(bold(`scenario: ${picked.name}`) + dim(` -- ${picked.description}`))
      script = picked.lines
    } else {
      const lines = rest.filter(a => !a.startsWith('--'))
      script = lines.length ? lines : [
        'Hi, my cattle are sick, some are drooling and not eating',
        'There are about 10 of them near Bela-Bela',
        'Thanks for helping',
      ]
    }
    // Default sim runs offline on the deterministic stub (cheap, repeatable).
    // --real routes the same scenario through the live acptoapi bridge so devs
    // and operators can validate real-model behaviour. Honest fallback: if --real
    // is asked but the bridge is unreachable, say so and stay on the stub.
    let simCallLLM = stubLLM()
    if (flags.real) {
      const { resolveCallLLM } = await import('../src/llm.js')
      const brain = await resolveCallLLM({ probe: true })
      if (brain.source === 'acptoapi') { simCallLLM = brain.callLLM; console.log(green(`(real) ${brain.model} via ${brain.url}`)) }
      else console.log(yellow('--real asked but acptoapi is offline; running on the test stub instead. Start acptoapi on :4800.'))
    }
    const casey = await createCasey({ channels: ['sim'], callLLM: simCallLLM })
    await casey.start()
    const adapter = casey.adapters.sim
    const transcript = await runScript(adapter, script, { wait: () => casey.drain() })
    for (const t of transcript) console.log(`${t.role === 'contact' ? cyan('USER: ') : green('BOT:  ')} ${t.text}`)
    // Print THIS run's case, identified by the caseId the replies carried, not
    // listCases()[0] (arbitrary across accumulated sim runs -- thatcher ignores
    // orderBy). Fall back to listCases only if no reply carried a caseId.
    const runCaseId = [...transcript].reverse().find(t => t.caseId)?.caseId
    const caseRow = runCaseId ? await casey.store.getCase(runCaseId) : (await casey.store.listCases())[0]
    if (caseRow) {
      console.log(`\n${bold(caseRow.ref)}  status=${caseRow.status}  priority=${caseRow.priority}  tags=${caseRow.tags || '-'}\n   summary: ${caseRow.summary || dim('(none)')}`)
      try {
        const report = caseRow.report ? JSON.parse(caseRow.report) : {}
        const filled = Object.entries(report).filter(([, v]) => v != null && v !== '')
        if (filled.length) {
          console.log(dim('   report:'))
          for (const [k, v] of filled) console.log(`     ${dim(k.padEnd(20))} ${v}`)
        } else {
          console.log(dim('   report: (empty)'))
        }
      } catch { /* malformed report JSON: skip */ }
    }
    await casey.stop()
    process.exit(0)
  }

  if (cmd === 'cases') {
    const store = createCaseStore()
    await store.init()
    const where = {}
    if (flags.status) {
      const valid = store.getValidStatuses()
      if (!valid.includes(flags.status)) { console.log(bad(`invalid status: ${flags.status}, allowed: ${valid.join(', ')}`)); process.exit(1) }
      where.status = flags.status
    }
    if (flags.channel) {
      const valid = ['sim', 'discord', 'whatsapp']
      if (!valid.includes(flags.channel)) { console.log(bad(`invalid channel: ${flags.channel}, allowed: ${valid.join(', ')}`)); process.exit(1) }
      where.channel = flags.channel
    }
    const cases = await store.listCases(where)
    if (!cases.length) {
      const desc = [flags.status && `stage "${flags.status}"`, flags.channel && `channel "${flags.channel}"`].filter(Boolean).join(', ')
      console.log(desc ? `no cases matching ${desc}.` : 'no cases yet.')
      console.log(dim(`  create one with ${cyan('casey sim "my order is late"')}, or connect a channel and run ${cyan('casey up')}.`))
      process.exit(0)
    }
    for (const cr of cases) {
      const contact = cr.external_id ? dim(fmtPhone27(cr.external_id)) : ''
      const age = dim(fmtTimeSAST(cr.created_at) || '(no date)')
      console.log(`${bold(cr.ref)}\t[${cr.status}]\t${cr.priority}\t${cr.channel}\t${contact}\t${cr.subject || ''}\t${age}`)
    }
    process.exit(0)
  }

  if (cmd === 'show') {
    const store = createCaseStore(); await store.init()
    const id = rest.find(a => !a.startsWith('--'))
    if (!id) { console.log(`usage: casey show <ref|id>`); process.exit(1) }
    const caseRow = await store.getCase(id) || await store.getCaseByRef(id)
    if (!caseRow) { console.log(red('case not found:'), id); console.log(dim(`  list cases with ${cyan('casey cases')}.`)); process.exit(1) }
    console.log(`${bold(caseRow.ref)}  [${caseRow.status}]  ${caseRow.priority}  ${caseRow.channel}/${fmtPhone27(caseRow.external_id)}`)
    console.log(`opened: ${fmtTimeSAST(caseRow.created_at) || dim('(no date)')}`)
    console.log(`subject: ${caseRow.subject}\nsummary: ${caseRow.summary}\ntags: ${caseRow.tags}`)
    let report = {}; try { report = caseRow.report ? JSON.parse(caseRow.report) : {} } catch { report = {} }
    const { VISIT_CRITICAL: VC } = await import('../src/case-health.js')
    const filled = Object.keys(report).filter(k => report[k] != null && String(report[k]).trim())
    console.log(dim('--- report ---'))
    for (const k of VC) {
      if (report[k]) console.log(`  ${k}: ${report[k]} [visit-critical]`)
      else console.log(dim(`  ${k}: (not given) [visit-critical]`))
    }
    const extra = filled.filter(k => !VC.includes(k))
    for (const k of extra) console.log(`  ${k}: ${report[k]}`)
    if (!filled.length) console.log(dim('  (no additional fields filled)'))
    console.log(dim('--- timeline ---'))
    for (const e of await store.listEvents(caseRow.id)) {
      const ts = fmtTimeSAST(e.created_at)
      console.log(`  ${dim('[' + (ts || 'no time') + ']')} ${e.kind}/${e.actor}: ${e.text}`)
    }
    process.exit(0)
  }

  if (cmd === 'attention') {
    const store = createCaseStore(); await store.init()
    // Rank over the OPEN pool with the SAME scorer the dashboard inbox uses
    // (src/attn.js), so the terminal and the web view agree on what is urgent.
    const open = (await store.listCases()).filter(c => c.status !== 'resolved' && c.status !== 'closed')
    const limit = Number(flags.limit) > 0 ? Number(flags.limit) : 0
    const offset = Number(flags.offset) > 0 ? Number(flags.offset) : 0
    const { total, items } = rankAttention(open, Date.now(), { limit, offset })
    if (flags.json) {
      console.log(JSON.stringify({ total, items: items.map(x => ({ ref: x.c.ref, score: x.score, reason: x.reason, status: x.c.status, channel: x.c.channel, contact: x.c.external_id, last_activity: x.c.updated_at || x.c.created_at })) }, null, 2))
      process.exit(0)
    }
    if (!total) { console.log(green('nothing needs a person right now.')); process.exit(0) }
    console.log(bold(`${total} case${total === 1 ? '' : 's'} need attention`) + (limit ? dim(`  (showing ${items.length})`) : '') + '\n')
    for (const x of items) {
      const contact = x.c.external_id ? dim(fmtPhone27(x.c.external_id)) : ''
      const when = dim(fmtTimeSAST(x.c.updated_at || x.c.created_at) || '(no date)')
      console.log(`${bold(x.c.ref)}\t${red('score ' + x.score)}\t[${x.c.status}]\t${x.c.channel}\t${contact}`)
      console.log(`  ${x.reason}\n  ${dim('last activity: ' + when)}`)
    }
    process.exit(0)
  }

  if (cmd === 'handover') {
    const store = createCaseStore(); await store.init()
    if (flags['start-shift'] || rest.includes('start')) {
      const m = await store.startShift('cli')
      console.log(green(`shift started ${fmtTimeSAST(Math.floor(m.ts / 1000))}`))
      console.log(dim('  the next handover digest scopes "since now".'))
      process.exit(0)
    }
    const now = Date.now()
    const marker = await store.getShiftMarker()
    const since = marker?.ts || 0
    const open = (await store.listCases({}, { limit: 10000 })).filter(c => c.status !== 'closed')
    const tagsOf = (c) => String(c.tags || '').split(',').map(t => t.trim()).filter(Boolean)
    const { items } = rankAttention(open, now, { limit: 50, offset: 0 })
    const handoffs = open.filter(c => tagsOf(c).includes('needs-human'))
    const drafts = open.filter(c => tagsOf(c).includes('draft-pending'))
    const touched = open.filter(c => since && (c.last_event_at || c.updated_at || c.created_at || 0) >= since)
      .sort((a, b) => (b.last_event_at || b.updated_at || 0) - (a.last_event_at || a.updated_at || 0))
    if (flags.json) {
      console.log(JSON.stringify({
        generated_at: now, since, since_by: marker?.by || null,
        attention: items.map(x => ({ ref: x.c.ref, reason: x.reason, assignee: x.c.assignee || '' })),
        handoffs: handoffs.map(c => c.ref), drafts: drafts.map(c => c.ref), touched: touched.map(c => c.ref),
      }, null, 2))
      process.exit(0)
    }
    console.log(bold('casey shift handover') + dim(`  since ${since ? fmtTimeSAST(Math.floor(since / 1000)) : 'start of records'}`) + '\n')
    console.log(bold(`needs attention (${items.length})`))
    for (const x of items) console.log(`  ${bold(x.c.ref)}\t${x.c.assignee ? dim('@' + x.c.assignee) : red('unowned')}\t${x.reason}`)
    console.log(bold(`\nopen handoffs not yet taken (${handoffs.length})`))
    for (const c of handoffs) console.log(`  ${bold(c.ref)}\t${c.subject || ''}`)
    console.log(bold(`\nunsent drafts (${drafts.length})`))
    for (const c of drafts) console.log(`  ${bold(c.ref)}\t${c.subject || ''}`)
    console.log(bold(`\ntouched this shift (${touched.length})`))
    for (const c of touched) console.log(`  ${dim(fmtTimeSAST(Math.floor((c.last_event_at || c.updated_at || c.created_at || 0) / 1000)) || '(no date)')}  ${bold(c.ref)}\t${c.subject || ''}`)
    console.log(dim(`\n  stamp a new shift with ${cyan('casey handover start')}.`))
    process.exit(0)
  }

  if (cmd === 'health') {
    const store = createCaseStore(); await store.init()
    const { classifyCaseHealth } = await import('../src/case-health.js')
    const thresholds = await store.resolveThresholds()
    const open = (await store.listCases()).filter(c => c.status !== 'resolved' && c.status !== 'closed')
    const now = Date.now()
    const breachCounts = {}
    let corrupt = 0, breachedCases = 0
    for (const c of open) {
      let breaches = []
      try { breaches = classifyCaseHealth(c, now, thresholds) || [] }
      catch { corrupt++; continue }
      if (breaches.length) breachedCases++
      for (const b of breaches) { const tag = b.breach || 'breach'; breachCounts[tag] = (breachCounts[tag] || 0) + 1 }
    }
    if (flags.json) { console.log(JSON.stringify({ open: open.length, breachedCases, corrupt, breaches: breachCounts }, null, 2)); process.exit(0) }
    console.log(bold('casey health') + dim('  (read-only -- nothing written)'))
    console.log(`open cases: ${open.length}   with a guardrail breach: ${breachedCases}` + (corrupt ? red(`   corrupt rows skipped: ${corrupt}`) : ''))
    const entries = Object.entries(breachCounts).sort((a, b) => b[1] - a[1])
    if (!entries.length) console.log(green('  no guardrail breaches.'))
    for (const [tag, n] of entries) console.log(`  ${tag}\t${n}`)
    process.exit(0)
  }

  if (cmd === 'sweep') {
    const store = createCaseStore(); await store.init()
    const { sweepCases } = await import('../src/case-sweep.js')
    const thresholds = await store.resolveThresholds()
    const summary = await sweepCases(store, Date.now(), thresholds)
    if (flags.json) { console.log(JSON.stringify(summary, null, 2)); process.exit(0) }
    const scanned = summary.scanned || 0
    const flagged = summary.flagged || 0
    const cleared = summary.cleared || 0
    const errors = Array.isArray(summary.errors) ? summary.errors.length : 0
    console.log(bold('casey sweep') + dim('  (health-guardrail sweep ran once)'))
    console.log(`scanned: ${scanned}   newly flagged: ${flagged}   cleared: ${cleared}` + (errors ? red(`   errors: ${errors}`) : ''))
    console.log(dim('  run ') + cyan('casey attention') + dim(' to see what to act on.'))
    process.exit(0)
  }

  if (cmd === 'transition') {
    const store = createCaseStore(); await store.init()
    const positional = rest.filter(a => !a.startsWith('--'))
    const [ref, stage] = positional
    if (!ref || !stage) { console.log('usage: casey transition <ref|id> <stage> [--reason "..."]'); console.log(dim('  stages: ') + store.getValidStatuses().map(cyan).join(', ')); process.exit(1) }
    const caseRow = await store.getCase(ref) || await store.getCaseByRef(ref)
    if (!caseRow) { console.log(red('case not found:'), ref); process.exit(1) }
    const OP = { id: 'cli-operator', role: 'operator' }
    const legal = store.availableTransitions(caseRow, OP)
    if (stage !== caseRow.status && !legal.includes(stage)) {
      console.log(red(`cannot move ${caseRow.ref} from '${caseRow.status}' to '${stage}'.`))
      console.log(dim('  allowed from here: ') + (legal.length ? legal.map(cyan).join(', ') : dim('(none)')))
      process.exit(1)
    }
    const reason = typeof flags.reason === 'string' ? flags.reason : 'cli operator override'
    await store.transition(caseRow.id, stage, { user: OP, reason })
    const after = await store.getCase(caseRow.id)
    console.log(green(`${after.ref}: ${caseRow.status} -> ${after.status}`) + dim(`  (${reason})`))
    process.exit(0)
  }

  console.log(HELP)
  process.exit(cmd ? 1 : 0)
}

main().catch(e => { console.error(red(e.stack || e.message || e)); process.exit(1) })
