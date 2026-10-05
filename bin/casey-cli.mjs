import { HELP, USAGE, parseFlags, pkgVersion, red, say, cyan, dim } from './casey-cli-ui.js'
import { cmdInit, cmdDoctor } from './casey-setup.js'
import { cmdUp, cmdDashboard } from './casey-serve.js'
import {
  cmdCases, cmdShow, cmdAttention, cmdHandover, cmdReport, cmdHealth,
  cmdSweep, cmdTransition, cmdEraseContact, cmdOperators,
  cmdRetention, cmdBackup, cmdRestore, cmdReportDigest,
} from './casey-store-commands.js'
import { cmdAlerts } from './casey-alerts-command.js'
import { cmdRoles } from './casey-roles-command.js'
import { cmdSyncImport } from './casey-sync-import-command.js'
import { cmdSyncCorrelate } from './casey-sync-correlate-command.js'
import { cmdSyncApiKey } from './casey-sync-apikey-command.js'

let [, , cmd, ...rest] = process.argv
if (cmd === '--version' || cmd === '-v') { cmd = 'version' }
if (cmd === '--help' || cmd === '-h') { cmd = 'help' }

process.on('uncaughtException', (e) => {
  console.error('[casey] uncaughtException (exiting):', e?.stack || e?.message || String(e))
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  console.error('[casey] unhandledRejection (exiting):', e?.stack || e?.message || String(e))
  process.exit(1)
})

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
  'report-digest': cmdReportDigest,
  operators: cmdOperators,
  roles: cmdRoles,
  'sync-import': cmdSyncImport,
  'sync-correlate': cmdSyncCorrelate,
  'sync-apikey': cmdSyncApiKey,
}

async function main() {
  const flags = parseFlags(rest)
  if (flags.version || cmd === 'version') { console.log(pkgVersion()); return }
  if (cmd === 'help' || flags.help && !cmd) { console.log(HELP); return }

  const run = COMMANDS[cmd]
  if (run && flags.help) { console.log(USAGE[cmd] || HELP); return }
  if (run) return run({ flags, rest })

  if (cmd) {
    say(red(`unknown command: ${cmd}`))
    say(dim(`  run ${cyan('casey help')} for the list of commands.`))
    process.exit(1)
  }
  console.log(HELP)
}

main().catch(e => {
  say(red(`casey failed: ${e?.message || e}`))
  if (e?.stack) say(dim(e.stack))
  process.exit(1)
})
