// casey-alerts-command.js  --  `casey alerts`: what has fired, and what is
// still standing, read off the local alert log (src/alert-log.js).
//
// Its own module rather than a row in casey-store-commands.js, and the reason
// is load-bearing: every command in that file opens a CaseStore first, and this
// one deliberately opens nothing. An operator reads alerts precisely when
// something is wrong -- a wedged store, a locked sqlite file, a worker that
// will not boot -- and a command that has to open the database to tell you the
// database is unreachable is no use in the moment it exists for. It reads two
// plain files under <cwd>/data/alerts and nothing else. That also makes it safe
// to run beside a live `casey up` (no second sqlite handle, no SQLITE_BUSY).
//
// EXIT CODES, because a monitor on the box reads those before it reads text:
//   0  nothing is standing
//   1  at least one condition is standing right now
//   2  the alert log could not be read, or the command was called wrong
// So a cron line is `casey alerts --quiet || mail -s "casey" ops@...`, with no
// JSON parsing and no dashboard.
import path from 'node:path'
import { existsSync } from 'node:fs'
import { AlertLog, AlertGate, ALERT_TAG } from '../src/alert-log.js'
import { fmtTimeSAST } from '../src/format.js'
import { bold, dim, green, red, cyan, ok, bad, warn, say } from './casey-cli-ui.js'

// What each condition is CALLED for a person reading this table. The machine key
// still travels in --json and in every log line, which is what a monitor greps
// on -- this is only the column a human scans. The same split the sweep's own
// timeline text now uses (case-health.js's BREACH_LABEL): the key is the
// contract, the phrase is the reading.
// Short noun phrases, not sentences: the line beneath each of these already
// carries the full sentence from the alert itself, and a label that restates it
// costs a line and says nothing. This column is the category you scan; the
// detail under it is what you read.
const CONDITION_LABEL = {
  channel_deaf: 'not hearing the field',
  provider_down_backlog: 'AI helper down, messages queuing',
  sweep_stalled: 'guardrail checks stopped',
  coverage_gap: 'nobody covering',
}
const conditionLabel = (c) => CONDITION_LABEL[c] || c

// The same directory case-store.js resolves as its own dataDir
// (path.resolve(process.cwd(), 'data')), computed the same way rather than by
// booting a store -- see this file's header for why no store is opened.
function alertDataDir() {
  return path.join(process.cwd(), 'data')
}

// Which webhook, if any, is carrying alerts instead of this log. The URL itself
// is a secret and is never printed -- only which variable is set, exactly the
// discipline routes/operations.js's alertWebhookView already holds.
function webhookSource() {
  if (process.env.CASEY_ALERT_WEBHOOK) return 'CASEY_ALERT_WEBHOOK'
  if (process.env.CASEY_HANDOFF_WEBHOOK) return 'CASEY_HANDOFF_WEBHOOK'
  return null
}

const mins = (ms) => Math.max(0, Math.round(ms / 60000))

export async function cmdAlerts({ flags }) {
  // parseFlags yields the boolean `true` for a flag with nothing after it, and
  // echoing that sentinel back as a value the operator never typed is the same
  // bug casey-store-commands.js's requireOneOf exists to avoid.
  if (flags.limit === true || flags.limit === '') {
    say(bad('--limit needs a number.'))
    say(dim('  e.g. ') + cyan('casey alerts --limit 50'))
    process.exit(2)
  }
  if (flags.limit !== undefined && !(Number(flags.limit) > 0)) {
    say(bad(`--limit must be a positive number, not "${flags.limit}".`))
    process.exit(2)
  }
  const limit = flags.limit !== undefined ? Number(flags.limit) : 20
  const dataDir = alertDataDir()
  const dir = path.join(dataDir, 'alerts')
  const hook = webhookSource()

  // Nothing on disk is a real, common and healthy answer: a deployment with a
  // webhook set never writes this log at all, and one that has simply never
  // had a system-level failure has nothing to write. Say which of the two it
  // is rather than printing an empty list.
  if (!existsSync(dir)) {
    if (flags.json) {
      console.log(JSON.stringify({
        generated_at: Date.now(), log_present: false, webhook_configured: !!hook, webhook_source: hook,
        standing: [], entries: [], total: 0, corrupt_lines: 0,
      }, null, 2))
      process.exit(0)
    }
    if (!flags.quiet) {
      console.log(bold('casey alerts') + dim(`  ${dir}`))
      console.log(hook
        ? ok(`alerts are being POSTed to ${hook}; the local alert log is the no-webhook fallback and is not in use`)
        : dim('  no alerts have fired yet on this machine.'))
      if (!hook) console.log(dim(`  the log is written on the first alert; watch it with `) + cyan(`tail -f ${path.join(dir, 'alerts.jsonl')}`))
    }
    process.exit(0)
  }

  let log, gate
  try {
    log = new AlertLog({ dataDir, stderr: false })
    gate = new AlertGate({ dataDir })
  } catch (e) {
    say(bad(`could not read the alert log at ${dir}: ${e.message}`))
    process.exit(2)
  }
  const { items, total, corrupt } = log.read({ limit })
  const standing = gate.snapshot()
  const now = Date.now()

  if (flags.json) {
    console.log(JSON.stringify({
      generated_at: now,
      log_present: true,
      webhook_configured: !!hook,
      webhook_source: hook,
      standing: standing.map(s => ({
        condition: s.condition, since: s.since,
        since_sast: s.since ? fmtTimeSAST(s.since) : null,
        // Floored at zero, the same way the human column is: a `since` ahead of
        // this clock (a host clock stepped backwards, an NTP correction between
        // the raise and this read) must read as "just now", never as a negative
        // duration a monitor would parse as a real number.
        for_ms: s.since ? Math.max(0, now - s.since) : null,
      })),
      entries: items.map(e => ({ ...e, t_sast: fmtTimeSAST(e.at || Date.parse(e.t) || null) })),
      showing: items.length,
      total,
      corrupt_lines: corrupt,
      log: log.stats(),
    }, null, 2))
    process.exit(standing.length ? 1 : 0)
  }

  if (flags.quiet) process.exit(standing.length ? 1 : 0)

  console.log(bold('casey alerts') + dim(`  ${log.file}`))
  // Which channel is actually carrying alerts, said before anything else: a
  // reader looking at an empty list needs to know whether that means "nothing
  // wrong" or "this log is not the one being written".
  console.log(hook
    ? warn(`${hook} is set, so alerts go there; this local log is the fallback and is NOT being written while that variable is set`)
    : dim(`  no alert webhook set -- this log is the delivery channel. Watch it with `) + cyan(`tail -f ${log.file}`))

  if (!standing.length) console.log(green('\nnothing is standing right now.'))
  else {
    console.log(bold(`\nstanding now (${standing.length})`))
    for (const s of standing) {
      const since = s.since ? `${fmtTimeSAST(s.since)}  (${mins(now - s.since)} min)` : 'unknown'
      console.log(`  ${bad(conditionLabel(s.condition))}\t${dim('since ' + since)}`)
    }
  }

  console.log(bold(`\nrecent (${items.length} of ${total})`))
  if (!items.length) console.log(dim('  nothing has fired yet.'))
  for (const e of items) {
    const when = dim('[' + (fmtTimeSAST(e.at || Date.parse(e.t) || null) || 'no time') + ']')
    const evt = e.event === 'cleared' ? green('cleared') : red('raised ')
    console.log(`  ${when} ${evt} ${bold(conditionLabel(e.condition) || 'unrecorded condition')}\t${dim(e.ref || '')}`)
    if (e.detail) console.log(`      ${e.detail}`)
  }
  if (corrupt) console.log(red(`\n  ${corrupt} unreadable line(s) skipped (a crash mid-append truncated them).`))

  const st = log.stats()
  console.log(dim(`\n  ${st.archive_count} archive(s), ${Math.round(st.total_bytes / 1024)} KB of a ${Math.round(st.ceiling_bytes / 1024 / 1024)} MB ceiling (rotates by rename, oldest archive dropped).`))
  if (st.write_failures) console.log(bad(`  ${st.write_failures} alert(s) could not be written to disk (${st.last_write_error}) -- they went to stderr only.`))
  console.log(dim(`  every line carries the literal ${ALERT_TAG}, so `) + cyan(`grep ${ALERT_TAG} ${log.file}`) + dim(' works with no parser.'))
  console.log(dim('  exit code: 0 clear, 1 something standing, 2 unreadable.'))
  process.exit(standing.length ? 1 : 0)
}
