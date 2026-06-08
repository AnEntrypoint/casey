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

// ---- tiny terminal colorizer (respects NO_COLOR and non-TTY) ----
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR
const c = (code) => (s) => COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s)
const bold = c('1'), dim = c('2'), green = c('32'), red = c('31'), yellow = c('33'), cyan = c('36')
const ok = (s) => `${green('✓')} ${s}`
const bad = (s) => `${red('✗')} ${s}`
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
    s.once('error', () => resolve(false))
    s.once('listening', () => s.close(() => resolve(true)))
    s.listen(port, '127.0.0.1')
  })
}

const ENV_TEMPLATE = `# casey environment -- fill in the channels you want, leave the rest blank.
# Discord (simulates the WhatsApp flow on a Discord bot):
DISCORD_BOT_TOKEN=

# WhatsApp Cloud API (both required to enable the real channel):
WHATSAPP_API_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
# Optional: verifies inbound Meta webhooks (X-Hub-Signature-256):
WHATSAPP_APP_SECRET=

# Dashboard: set a shared secret to require ?token= / Bearer auth (recommended):
CASEY_DASHBOARD_TOKEN=
`

const HELP = `${bold('casey')} ${dim('v' + pkgVersion())}  --  agentic case tracking over WhatsApp/Discord

${bold('usage:')}
  casey init                                    scaffold a .env you can fill in
  casey doctor                                  preflight: what's ready, what's missing
  casey up [--channels sim,discord,whatsapp] [--port 4000]   start gateway + dashboard
  casey dashboard [--port 4000]                 start only the observe/edit dashboard
  casey sim ["message" ...]                     run an offline simulated conversation
  casey cases [--status <stage>]                list cases
  casey show <ref|id>                           show a case + timeline

${bold('flags:')}  --help / -h on any command,  --version / -v

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
    if (existsSync(dest)) { console.log(warn(`.env already exists at ${dest} — leaving it untouched.`)); return }
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
    console.log(major >= 18 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} (need >=18)`))
    if (major < 18) problems++
    // .env presence
    console.log(existsSync(path.join(ROOT, '.env')) ? ok('.env present') : warn(`.env missing — run ${cyan('casey init')} (channels can still come from the environment)`))
    // dependencies resolve
    for (const dep of ['anentrypoint-design', 'thatcher', 'freddie', 'express']) {
      try { await import(dep); console.log(ok(`dependency ${dep} resolves`)) }
      catch { console.log(bad(`dependency ${dep} does not resolve — run npm install`)); problems++ }
    }
    // channels
    for (const ch of ['discord', 'whatsapp']) {
      if (hasCreds(ch)) console.log(ok(`channel ${ch}: credentials present`))
      else if (partialCreds(ch)) { console.log(bad(`channel ${ch}: partial credentials — set BOTH WHATSAPP_API_TOKEN and WHATSAPP_PHONE_NUMBER_ID`)); problems++ }
      else console.log(dim(`  channel ${ch}: not configured (optional)`))
    }
    if (!hasCreds('discord') && !hasCreds('whatsapp')) console.log(warn('no real channel connected — only the offline sim will run'))
    // dashboard token
    console.log(process.env.CASEY_DASHBOARD_TOKEN ? ok('dashboard token set (auth required)') : warn('CASEY_DASHBOARD_TOKEN unset — dashboard is open to anyone who can reach the port'))
    // port
    const port = Number(flags.port || 4000)
    console.log(await portFree(port) ? ok(`port ${port} is free`) : bad(`port ${port} is in use — start with --port <other>`))
    console.log(problems ? red(`\n${problems} problem(s) to fix before ${cyan('casey up')}`) : green('\nall good — run casey up'))
    process.exit(problems ? 1 : 0)
  }

  if (cmd === 'up') {
    if (flags.help) { console.log('casey up [--channels sim,discord,whatsapp] [--port 4000]\n  Start the gateway (all configured channels) and the dashboard.'); return }
    const requested = (flags.channels || 'sim,discord,whatsapp').split(',').map(s => s.trim()).filter(Boolean)
    const channels = requested.filter(ch => ch === 'sim' || hasCreds(ch))
    const skipped = requested.filter(ch => ch !== 'sim' && !hasCreds(ch))
    const callLLM = process.env.CASEY_STUB_LLM ? (await import('../src/sim/stub-llm.js')).stubLLM() : null
    const casey = await createCasey({ channels, callLLM })
    await casey.start()
    const dashPort = Number(flags.port || 4000)
    const sendReply = (caseRow, text) => {
      const a = casey.adapters[caseRow.channel]
      return a?.send ? a.send({ to: caseRow.external_id, text }) : Promise.resolve()
    }
    const dash = createDashboard(casey.store, { port: dashPort, sendReply })
    console.log(bold('casey up') + dim(`  v${pkgVersion()}`))
    console.log(`  channels: ${green(channels.join(', '))}` + (skipped.length ? dim(`   (skipped, no creds: ${skipped.join(', ')} — run casey doctor)`) : ''))
    if (channels.length === 1 && channels[0] === 'sim') console.log(warn('only the offline sim is active — no real messages will arrive. Connect a channel in .env.'))
    const tokenNote = process.env.CASEY_DASHBOARD_TOKEN ? ` ${dim('(token required)')}` : ` ${yellow('(open — set CASEY_DASHBOARD_TOKEN)')}`
    console.log(`  dashboard: ${cyan(`http://localhost:${dash.port}`)}${tokenNote}`)
    console.log(dim('  press ctrl-c to stop'))
    process.on('SIGINT', async () => { await dash.close(); await casey.stop(); process.exit(0) })
    return
  }

  if (cmd === 'dashboard') {
    if (flags.help) { console.log('casey dashboard [--port 4000]\n  Start only the observe/edit dashboard against the existing store.'); return }
    const store = createCaseStore(); await store.init()
    const dash = createDashboard(store, { port: Number(flags.port || 4000) })
    console.log(`dashboard: ${cyan(`http://localhost:${dash.port}`)}  ${dim('(ctrl-c to stop)')}`)
    process.on('SIGINT', async () => { await dash.close(); process.exit(0) })
    return
  }

  if (cmd === 'sim') {
    const { runScript } = await import('../src/sim/inject.js')
    const { stubLLM } = await import('../src/sim/stub-llm.js')
    const casey = await createCasey({ channels: ['sim'], callLLM: stubLLM() })
    await casey.start()
    const adapter = casey.adapters.sim
    const lines = rest.filter(a => !a.startsWith('--'))
    const script = lines.length ? lines : [
      'Hi, my order #55 still has not arrived',
      'It was supposed to come yesterday',
      'Thanks for looking into it',
    ]
    const transcript = await runScript(adapter, script, { wait: () => casey.drain() })
    for (const t of transcript) console.log(`${t.role === 'contact' ? cyan('USER: ') : green('BOT:  ')} ${t.text}`)
    const [caseRow] = await casey.store.listCases()
    if (caseRow) console.log(`\n${bold(caseRow.ref)}  status=${caseRow.status}  priority=${caseRow.priority}  tags=${caseRow.tags || '-'}\n   summary: ${caseRow.summary || dim('(none)')}`)
    await casey.stop()
    process.exit(0)
  }

  if (cmd === 'cases') {
    const store = createCaseStore()
    await store.init()
    const cases = await store.listCases({}, flags.status ? { status: flags.status } : {})
    if (!cases.length) {
      console.log(flags.status ? `no cases in stage "${flags.status}".` : 'no cases yet.')
      console.log(dim(`  create one with ${cyan('casey sim "my order is late"')}, or connect a channel and run ${cyan('casey up')}.`))
      process.exit(0)
    }
    for (const cr of cases) {
      console.log(`${bold(cr.ref)}\t[${cr.status}]\t${cr.priority}\t${cr.channel}\t${cr.subject || ''}`)
    }
    process.exit(0)
  }

  if (cmd === 'show') {
    const store = createCaseStore(); await store.init()
    const id = rest.find(a => !a.startsWith('--'))
    if (!id) { console.log(`usage: casey show <ref|id>`); process.exit(1) }
    const caseRow = await store.getCase(id) || (await store.listCases()).find(x => x.ref === id)
    if (!caseRow) { console.log(red('case not found:'), id); console.log(dim(`  list cases with ${cyan('casey cases')}.`)); process.exit(1) }
    console.log(`${bold(caseRow.ref)}  [${caseRow.status}]  ${caseRow.priority}  ${caseRow.channel}/${caseRow.external_id}`)
    console.log(`subject: ${caseRow.subject}\nsummary: ${caseRow.summary}\ntags: ${caseRow.tags}`)
    console.log(dim('--- timeline ---'))
    for (const e of await store.listEvents(caseRow.id)) console.log(`  ${e.kind}/${e.actor}: ${e.text}`)
    process.exit(0)
  }

  console.log(HELP)
  process.exit(cmd ? 1 : 0)
}

main().catch(e => { console.error(red(e.stack || e.message || e)); process.exit(1) })
