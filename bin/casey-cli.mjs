// casey CLI entry -- argv in, one named command out.
// Loaded via bin/casey.js's bootstrap, which loads .env BEFORE this file's
// own imports run -- see bin/casey.js for why that ordering matters (ES
// module import hoisting) and cannot be done inside this file itself.
//
// Friendliness lives here as much as in the dashboard: `casey init` scaffolds a
// .env so an operator never hand-writes one; `casey doctor` is a preflight that
// tells you exactly what is and isn't ready before you start; every command has
// --help, the output is colorized (unless NO_COLOR / non-TTY), and empty results
// come with a hint about what to do next instead of a bare "no cases".
//
// This file used to BE all of that: a single 698-line main() where every
// subcommand's argv parsing, execution and output formatting shared one scope,
// so the doctor preflight, the supervisor wiring and ten one-shot store
// commands could all see (and shadow) each other's locals. The commands moved
// out unchanged, one module per surface, and what is left here is the argv
// normalization, the crash net, and the table that says which name runs which:
//
//   casey-cli-ui.js         colour, argv, credential/port probes, HELP, closeAndExit
//   casey-setup.js          init, doctor
//   casey-serve.js          up, dashboard
//   casey-store-commands.js cases, show, attention, handover, report, health,
//                           sweep, transition, erase-contact, retention,
//                           backup, restore, operators
//   casey-alerts-command.js alerts (opens NO store on purpose -- see its header)
//   send-reply.js           the outbound delivery seam shared with bin/worker.js
import { HELP, USAGE, parseFlags, pkgVersion, red, say, cyan, dim } from './casey-cli-ui.js'
import { cmdInit, cmdDoctor } from './casey-setup.js'
import { cmdUp, cmdDashboard } from './casey-serve.js'
import {
  cmdCases, cmdShow, cmdAttention, cmdHandover, cmdReport, cmdHealth,
  cmdSweep, cmdTransition, cmdEraseContact, cmdOperators,
  cmdRetention, cmdBackup, cmdRestore,
} from './casey-store-commands.js'
import { cmdAlerts } from './casey-alerts-command.js'
import { cmdSyncImport } from './casey-sync-import-command.js'
import { cmdSyncApiKey } from './casey-sync-apikey-command.js'

let [, , cmd, ...rest] = process.argv
// allow `casey --version` / `casey -v` / `casey --help` with no subcommand
if (cmd === '--version' || cmd === '-v') { cmd = 'version' }
if (cmd === '--help' || cmd === '-h') { cmd = 'help' }

// The --no-supervise legacy path (and every other CLI command) runs the gateway
// +dashboard+store combination in-process with only SIGINT installed -- an
// unhandled rejection anywhere falls through to Node's default abrupt kill with
// no thatcher WAL flush, no dash.close(), no explanation. Installed once, cheap
// on every path (a version/help/init/doctor command never triggers it in
// practice, but costs nothing to have armed). Logs loud and exits non-zero,
// same discipline as bin/worker.js's own crash net.
process.on('uncaughtException', (e) => {
  console.error('[casey] uncaughtException (exiting):', e?.stack || e?.message || String(e))
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  console.error('[casey] unhandledRejection (exiting):', e?.stack || e?.message || String(e))
  process.exit(1)
})

// The whole command surface, one row each. Every handler takes the same
// { flags, rest } and is responsible for its own exit -- the one-shot store
// commands through closeAndExit (which releases the sqlite handle first), the
// long-running ones by returning and leaving their listeners armed.
const COMMANDS = {
  init: cmdInit,
  doctor: cmdDoctor,
  up: cmdUp,
  dashboard: cmdDashboard,
  cases: cmdCases,
  show: cmdShow,
  attention: cmdAttention,
  handover: cmdHandover,
  report: cmdReport,
  health: cmdHealth,
  alerts: cmdAlerts,
  sweep: cmdSweep,
  transition: cmdTransition,
  'erase-contact': cmdEraseContact,
  retention: cmdRetention,
  backup: cmdBackup,
  restore: cmdRestore,
  operators: cmdOperators,
  'sync-import': cmdSyncImport,
  'sync-apikey': cmdSyncApiKey,
}

async function main() {
  const flags = parseFlags(rest)
  if (flags.version || cmd === 'version') { console.log(pkgVersion()); return }
  if (cmd === 'help' || flags.help && !cmd) { console.log(HELP); return }

  const run = COMMANDS[cmd]
  // --help is answered from the USAGE table BEFORE the handler runs, so asking
  // how a command works never performs that command's work. `casey sweep --help`
  // used to run the sweep and `casey transition <ref> <stage> --help` used to
  // move the case, because only up/dashboard checked the flag for themselves.
  if (run && flags.help) { console.log(USAGE[cmd] || HELP); return }
  if (run) return run({ flags, rest })

  // An unrecognised name gets a sentence naming it, on stderr, rather than the
  // whole help text on stdout: the operator needs to see the typo, and a caller
  // piping this command's output needs not to receive a help screen as data.
  if (cmd) {
    say(red(`unknown command: ${cmd}`))
    say(dim(`  run ${cyan('casey help')} for the list of commands.`))
    process.exit(1)
  }
  console.log(HELP)
}

// A stack trace is what casey shows when it has nothing better; every path that
// knows what went wrong says so in a sentence and exits before reaching here.
// The trace still goes to stderr with the message first, so an operator reads
// the reason before the frames, and a pipe reading stdout gets neither.
main().catch(e => {
  say(red(`casey failed: ${e?.message || e}`))
  if (e?.stack) say(dim(e.stack))
  process.exit(1)
})
