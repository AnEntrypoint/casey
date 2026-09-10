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
// Every marker carries its meaning in the literal prefix as well as the colour,
// so a piped, redirected or NO_COLOR terminal loses nothing: colour is emphasis
// here, never the only thing distinguishing an error row from a healthy one.
export const ok = (s) => `${green('[ok]')} ${s}`
export const bad = (s) => `${red('[x]')} ${s}`
export const warn = (s) => `${yellow('!')} ${s}`

// A refusal, a usage line and a "not found" are diagnostics, not the answer the
// command was asked for: they go to stderr so `casey attention --json | jq` and
// `casey cases > list.txt` receive only real output. Exit codes already carry
// the failure; stdout must not.
export const say = (s) => console.error(s)

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
  casey cases [--status <stage>] [--channel <channel>]   list cases
  casey show <ref|id>                           show a case + timeline
  casey attention [--limit N --offset N --json] worst-first inbox: who needs a person now, and why
  casey handover [--json] / handover start      shift digest: what to pick up; 'start' stamps a new shift
  casey report [--days N] [--json]              management briefing: SLA compliance, response + closure rates
  casey health [--json]                         read-only guardrail summary (no changes written)
  casey alerts [--limit N] [--json] [--quiet]   system alerts that fired: what is standing, what cleared
                                                 exits 1 while anything is standing, so cron can page on it
  casey sweep [--json]                          run the health-guardrail sweep once now (writes tags/observations)
  casey transition <ref|id> <stage> [--reason]  move a case to a stage (legality-checked)
  casey erase-contact <contact|ref> --yes [--reason]  right-to-erasure: irreversibly scrub one person's PII (POPIA/GDPR)
  casey erase-contact --check                   list erasures that started and never finished
  casey retention [--days N] [--yes] [--json]   age-based retention. OFF unless configured; DRY RUN unless --yes
  casey backup [--out <dir>] [--json]           consistent copy of every store, including the ones outside data/
  casey restore <backup-dir> --yes              put a backup back (stop casey first; the live data dir is moved aside)
  casey operators add <username> [--password ...] [--name ...] [--role admin|operator|secretary]
                                                 create a dashboard login account (break-glass/scripted provisioning)
  casey operators list                          list dashboard login accounts (never prints password hashes)
  casey operators disable <username>            disable a login without deleting its history
  casey operators enable <username>             re-enable a disabled login
  casey sync-import <file> --kind field_visit|farmer|association|follow_up
                                                 read a manually-exported external-system file into the cross-app
                                                 correlation engine's normalized shape (no live adapter needed)
  casey sync-apikey create --label <name> --scope read:cases,read:links,write:links,import:records
                                                 provision a machine credential for /api/sync/* (printed once)
  casey sync-apikey list                        list sync API keys (never prints the key itself)
  casey sync-apikey revoke <id>                 revoke a sync API key without deleting its history

${bold('flags:')} --help / -h on any command, --version / -v

${bold('channels (set in .env or the environment):')}
  DISCORD_BOT_TOKEN                             enable discord
  WHATSAPP_API_TOKEN, WHATSAPP_PHONE_NUMBER_ID  enable whatsapp

${bold('dashboard login:')} the dashboard now uses per-operator username/password
  login (not a shared token) -- a fresh deployment auto-creates a bootstrap
  admin account on first ${cyan('casey up')} / ${cyan('casey dashboard')} and prints its password once.
  Use ${cyan('casey operators')} for break-glass recovery if that is lost.

${dim('new here? run')} ${cyan('casey init')} ${dim('then')} ${cyan('casey doctor')} ${dim('then')} ${cyan('casey up')}`

// One usage block per dispatchable command, keyed exactly as bin/casey-cli.mjs's
// COMMANDS table. bin/casey-cli.mjs answers --help/-h out of this table BEFORE
// dispatching, which is what makes the "--help / -h on any command" line above
// true: until this existed only up and dashboard checked the flag themselves, so
// `casey sweep --help` ran the sweep and `casey transition <ref> <stage> --help`
// moved the case -- a help request that wrote to the store.
export const USAGE = {
  init: `casey init
  Scaffold a .env in casey's own repo root for you to fill in. Never overwrites
  an existing one. A deployer package that ships its own .env (uhh, serpent)
  does not use this -- edit that package's .env instead.`,
  doctor: `casey doctor [--port 4000]
  Preflight: Node version, .env, dependency resolution, supply-chain scan,
  submodule health, timeout coordination, channel credentials, config validity
  and drift, data dir, and whether --port is free. Exits 1 if anything is red.`,
  up: `casey up [--channels discord,whatsapp] [--port 4000] [--no-reload] [--no-supervise] [--no-auto-update]
  Start the gateway (all configured channels) and the dashboard.
  Supervised by default: the worker auto-restarts on a source change (live reload) or a crash,
  reopening the same case store so nothing is lost. AUTO-UPDATE is on by default -- it fetches
  from origin on an interval and fast-forwards (git fetch + merge --ff-only, safe: it never
  clobbers local edits and refuses to move a diverged tree) so a pushed fix deploys with no
  manual restart. --no-reload disables the file watcher; --no-auto-update
  (or CASEY_AUTO_UPDATE=0) disables the origin pull; --no-supervise runs the legacy single-process
  path for debugging.`,
  dashboard: `casey dashboard [--port 4000]
  Start only the observe/edit dashboard against the existing store. Reads and
  edits cases; it is not attached to a running agent, so replying to a contact,
  AI-helper status and Sweep now are unavailable in this mode.`,
  cases: `casey cases [--status <stage>] [--channel <channel>]
  List every case, newest activity first: ref, stage, priority, channel,
  contact, subject, opened-at. --status and --channel each accept one value and
  are checked against what this store actually holds.`,
  show: `casey show <ref|id>
  Show one case: header, report fields (visit-critical ones first, including the
  blanks), and the full append-only timeline. Takes the CASE-... ref printed by
  casey cases, or the internal id.`,
  attention: `casey attention [--limit N] [--offset N] [--json]
  The worst-first queue: who needs a person now, and the plain reason why. Same
  ranking the dashboard inbox uses. --json emits the machine shape.`,
  handover: `casey handover [--json]
  casey handover start
  Shift digest: what needs attention, open handoffs, unsent drafts, and what was
  touched since the last shift marker. 'start' stamps a new shift so the next
  digest scopes "since now". --json emits the machine shape.`,
  report: `casey report [--days N] [--json]
  Management briefing: SLA compliance by case type, and response/closure rates
  by case type and by intake channel. --days N restricts it to cases opened in
  the last N days (default 30). --json emits the machine shape.`,
  health: `casey health [--json]
  Read-only guardrail summary: how many open cases are breaching, and which
  guardrails. Writes nothing -- use casey sweep to record the breaches.`,
  alerts: `casey alerts [--limit N] [--json] [--quiet]
  What casey has raised about ITSELF: a deaf channel, a dead provider with
  messages queuing behind it, a guardrail sweep that has stopped running, plus
  per-case breaches and team coverage gaps. Read off the local alert log
  (data/alerts/alerts.jsonl), which is the delivery channel used when no
  CASEY_ALERT_WEBHOOK / CASEY_HANDOFF_WEBHOOK is set -- with one of those set,
  alerts go there instead and this log is not written.
  Opens no database, so it still answers when the store itself is the problem.
  --limit N shows the last N entries (default 20); --json emits the machine
  shape; --quiet prints nothing and speaks only through its exit code.
  Exit codes: 0 nothing standing, 1 something standing, 2 unreadable.`,
  sweep: `casey sweep [--json]
  Run the health-guardrail sweep once, now. This WRITES: it appends observation
  events and health:* tags for newly-entered breaches and clears cleared ones.`,
  transition: `casey transition <ref|id> <stage> [--reason "..."]
  Move one case to a stage. The move is checked against the workflow first and
  refused with the legal options if it is not allowed from where the case is.
  --reason is recorded on the timeline beside the change.`,
  'erase-contact': `casey erase-contact <contact-id|external-id|case-ref> --yes [--reason "..."]
casey erase-contact --check
  IRREVERSIBLE. Scrubs one contact's personal details for a right-to-erasure
  request (POPIA/GDPR). --yes is required: there is nothing to undo it with.
  Accepts the contact id, the contact's channel identifier, or the ref of any
  case that contact opened.
  This is about a PERSON ASKING; casey retention is about AGE. They stay separate.
  --check takes no contact and writes nothing: it lists erasures that started and
  never completed. An erasure touches four stores (contact + case rows, the
  provenance raw log, and the conversation transcripts outside data/) with no
  transaction available across them, so it is not atomic -- it writes a durable
  plan before its first change and a completion marker after its last, and a plan
  with no completion is what --check reports. Erasure is idempotent: re-running
  the command named in that report finishes the job.`,
  retention: `casey retention [--days N] [--action archive|erase] [--out <dir>] [--yes] [--json]
  Age-based retention over CLOSED cases. Two safeties, both structural:
  OFF unless configured -- with no CASEY_RETENTION_DAYS and no --days this
  command reads nothing and changes nothing. Nothing here is on a timer; it runs
  only when you type it.
  DRY RUN unless --yes -- with no --yes it reports what the policy would do,
  naming every case it would touch and, for every case it would not, the reason.
  A case is never expired while it is open, carries an unresolved health:*
  guardrail breach, is tagged needs-human or draft-pending, has had any event
  inside the window, or has timestamps that cannot be read.
  --action archive (the default) writes the whole case to a JSON file and takes
  it out of the live read paths; it destroys nothing. --action erase does that
  and then scrubs the identifying fields and removes the stored conversation.
  Neither frees bytes in data/db.sqlite -- thatcher soft-deletes.`,
  backup: `casey backup [--out <dir>] [--json]
  A consistent, restorable copy of every store: data/db.sqlite (snapshotted with
  sqlite's own VACUUM INTO, safe against a running casey), everything else under
  data/ -- the provenance raw log, the media files, the runtime-event sidecar --
  and the freddie conversation transcripts, which live OUTSIDE data/ and which a
  data/-scoped backup misses entirely.
  Any store it cannot copy is named and the command exits 1: a backup that
  quietly missed one is worse than no backup. The .env and the config package are
  never copied, on purpose, and the manifest says so.
  Defaults to backups/casey-<timestamp>.`,
  restore: `casey restore <backup-dir> --yes
  Put a backup back. Stop casey first. The live data directory is MOVED aside as
  data.pre-restore-<timestamp> rather than overwritten, so restoring the wrong
  backup is itself recoverable, and any stale sqlite -wal/-shm sidecar is removed
  so the restored database cannot have an old write-ahead log replayed over it.`,
  operators: `casey operators add <username> [--password ...] [--name ...] [--role admin|operator|secretary]
casey operators list
casey operators disable <username>
casey operators enable <username>
  Dashboard login accounts, from the command line -- the break-glass path when
  the admin password is lost, and the scripted-provisioning path. Without
  --password a random one is generated and printed once. Password hashes are
  never printed.`,
  'sync-apikey': `casey sync-apikey create --label <name> --scope read:cases,read:links,write:links,import:records
casey sync-apikey list
casey sync-apikey revoke <id>
  Machine credentials for the /api/sync/* API (see EXTERNAL-SYNC.md) -- a
  SEPARATE credential class from dashboard operator logins, scoped to that one
  route prefix only. The raw key is printed exactly once on create and is
  never stored or shown again; only its hash and a display-safe prefix are
  kept. Revoke sets disabled without deleting the row's history.`,
}

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
