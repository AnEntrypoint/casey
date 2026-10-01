import path from 'node:path'
import { existsSync } from 'node:fs'
import { AlertLog, AlertGate, ALERT_TAG } from '../src/alert-log.js'
import { fmtTimeSAST } from '../src/format.js'
import { bold, dim, green, red, cyan, ok, bad, warn, say } from './casey-cli-ui.js'

const CONDITION_LABEL = {
  channel_deaf: 'not hearing the field',
  provider_down_backlog: 'AI helper down, messages queuing',
  sweep_stalled: 'guardrail checks stopped',
  inbound_silent: 'WhatsApp silent, possibly deaf',
  coverage_gap: 'nobody covering',
}
const conditionLabel = (c) => CONDITION_LABEL[c] || c

function alertDataDir() {
  return path.join(process.cwd(), 'data')
}

function webhookSource() {
  if (process.env.CASEY_ALERT_WEBHOOK) return 'CASEY_ALERT_WEBHOOK'
  if (process.env.CASEY_HANDOFF_WEBHOOK) return 'CASEY_HANDOFF_WEBHOOK'
  return null
}

const mins = (ms) => Math.max(0, Math.round(ms / 60000))

export async function cmdAlerts({ flags }) {
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
