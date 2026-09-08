// casey-cli-ui.js  --  everything the CLI needs before it does any work:
// terminal colour, argv parsing, credential/port probes, the help text, and the
// shared clean-exit. Split out of bin/casey-cli.mjs, where main() had grown to
// 698 lines and every subcommand's parsing, execution and output formatting
// shared one scope. Behaviour is unchanged -- these are the same functions and
// the same literal strings, now importable by each command module.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(__dirname, '..')

// tiny terminal colorizer (respects NO_COLOR and non-TTY)
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR
const c = (code) => (s) => COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s)
export const bold = c('1'), dim = c('2'), green = c('32'), red = c('31'), yellow = c('33'), cyan = c('36')
export const ok = (s) => `${green('[ok]')} ${s}`
export const bad = (s) => `${red('[x]')} ${s}`
export const warn = (s) => `${yellow('!')} ${s}`

export function pkgVersion() {
  try { return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version } catch { return '?' }
}

export function parseFlags(args) {
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

export function hasCreds(ch) {
  if (ch === 'discord') return !!process.env.DISCORD_BOT_TOKEN
  if (ch === 'whatsapp') return !!(process.env.WHATSAPP_API_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID)
  return false
}
// partial creds = configured-but-incomplete; doctor must flag this, not show green.
export function partialCreds(ch) {
  if (ch === 'whatsapp') {
    const a = !!process.env.WHATSAPP_API_TOKEN, b = !!process.env.WHATSAPP_PHONE_NUMBER_ID
    return (a || b) && !(a && b)
  }
  return false
}

export function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => { s.close?.(); resolve(false) })
    s.once('listening', () => s.close(() => resolve(true)))
    s.listen(port, '127.0.0.1')
  })
}

export const HELP = `${bold('casey')} ${dim('v' + pkgVersion())}  --  agentic case tracking over WhatsApp/Discord

${bold('usage:')}
  casey init                                    scaffold a .env you can fill in
  casey doctor                                  preflight: what's ready, what's missing
  casey up [--channels discord,whatsapp] [--port 4000]   start gateway + dashboard
  casey dashboard [--port 4000]                 start only the observe/edit dashboard
  casey cases [--status <stage>]                list cases
  casey show <ref|id>                           show a case + timeline
  casey attention [--limit N --offset N --json] worst-first inbox: who needs a person now, and why
  casey handover [--json] / handover start      shift digest: what to pick up; 'start' stamps a new shift
  casey health                                  read-only guardrail summary (no changes written)
  casey sweep                                   run the health-guardrail sweep once now (writes tags/observations)
  casey transition <ref|id> <stage> [--reason]  move a case to a stage (legality-checked)
  casey erase-contact <contact-id> [--reason]   data retention: irreversibly scrub a contact's PII (POPIA/GDPR)
  casey operators add <username> [--password ...] [--name ...] [--role admin|operator]
                                                 create a dashboard login account (break-glass/scripted provisioning)
  casey operators list                          list dashboard login accounts (never prints password hashes)
  casey operators disable <username>            disable a login without deleting its history
  casey operators enable <username>             re-enable a disabled login

${bold('flags:')} --help / -h on any command, --version / -v

${bold('channels (set in .env or the environment):')}
  DISCORD_BOT_TOKEN                             enable discord
  WHATSAPP_API_TOKEN, WHATSAPP_PHONE_NUMBER_ID  enable whatsapp

${bold('dashboard login:')} the dashboard now uses per-operator username/password
  login (not a shared token) -- a fresh deployment auto-creates a bootstrap
  admin account on first ${cyan('casey up')} / ${cyan('casey dashboard')} and prints its password once.
  Use ${cyan('casey operators')} for break-glass recovery if that is lost.

${dim('new here? run')} ${cyan('casey init')} ${dim('then')} ${cyan('casey doctor')} ${dim('then')} ${cyan('casey up')}`

// Every one-shot CLI subcommand (cases/show/attention/handover/report/health/
// sweep/transition/erase-contact/operators) opens its own CaseStore and used to
// terminate via a bare process.exit() with no store.close() -- process.exit()
// is synchronous and does not wait for thatcher.stop()'s handle release, so
// running two of these commands in tight succession (e.g. a script) could hit
// SQLITE_BUSY on the second one's own store.init(), which -- unlike every
// per-call thatcher operation after init() succeeds -- has no retry wrapper of
// its own. `casey up`'s own SIGINT handler already awaits dash.close()/
// casey.stop() before exiting; this gives every one-shot command the same
// discipline.
export async function closeAndExit(store, code) {
  try { await store?.close?.() } catch (e) { console.error('[casey] store close error:', e.message) }
  process.exit(code)
}
