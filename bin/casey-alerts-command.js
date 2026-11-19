import path from 'node:path'
import { existsSync } from 'node:fs'
import { AlertLog, AlertGate, ALERT_TAG } from '../src/alert-log.js'
import { fmtTimeLocal } from '../src/format.js'
import { bold, dim, green, red, cyan, ok, bad, warn, say } from './casey-cli-ui.js'
import { caseyText } from '../src/deployment-text.js';

const CONDITION_LABEL = {
  channel_deaf: caseyText("bin/casey-alerts-command.js#w0"),
  provider_down_backlog: caseyText("bin/casey-alerts-command.js#w1"),
  sweep_stalled: caseyText("bin/casey-alerts-command.js#w2"),
  inbound_silent: caseyText("bin/casey-alerts-command.js#w3"),
  coverage_gap: caseyText("bin/casey-alerts-command.js#w4"),
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
    say(bad(caseyText("bin/casey-alerts-command.js#w5")))
    say(dim('  e.g. ') + cyan(caseyText("bin/casey-alerts-command.js#w6")))
    process.exit(2)
  }
  if (flags.limit !== undefined && !(Number(flags.limit) > 0)) {
    say(bad(caseyText("bin/casey-alerts-command.js#w7", [flags.limit])))
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
      console.log(bold(caseyText("bin/casey-alerts-command.js#w8")) + dim(`  ${dir}`))
      console.log(hook
        ? ok(caseyText("bin/casey-alerts-command.js#w9", [hook]))
        : dim(caseyText("bin/casey-alerts-command.js#w10")))
      if (!hook) console.log(dim(caseyText("bin/casey-alerts-command.js#w11")) + cyan(`tail -f ${path.join(dir, 'alerts.jsonl')}`))
    }
    process.exit(0)
  }

  let log, gate
  try {
    log = new AlertLog({ dataDir, stderr: false })
    gate = new AlertGate({ dataDir })
  } catch (e) {
    say(bad(caseyText("bin/casey-alerts-command.js#w12", [dir, e.message])))
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
        since_sast: s.since ? fmtTimeLocal(s.since) : null,
        for_ms: s.since ? Math.max(0, now - s.since) : null,
      })),
      entries: items.map(e => ({ ...e, t_sast: fmtTimeLocal(e.at || Date.parse(e.t) || null) })),
      showing: items.length,
      total,
      corrupt_lines: corrupt,
      log: log.stats(),
    }, null, 2))
    process.exit(standing.length ? 1 : 0)
  }

  if (flags.quiet) process.exit(standing.length ? 1 : 0)

  console.log(bold(caseyText("bin/casey-alerts-command.js#w13")) + dim(`  ${log.file}`))
  console.log(hook
    ? warn(caseyText("bin/casey-alerts-command.js#w14", [hook]))
    : dim(caseyText("bin/casey-alerts-command.js#w15")) + cyan(`tail -f ${log.file}`))

  if (!standing.length) console.log(green(caseyText("bin/casey-alerts-command.js#w16")))
  else {
    console.log(bold(caseyText("bin/casey-alerts-command.js#w17", [standing.length])))
    for (const s of standing) {
      const since = s.since ? `${fmtTimeLocal(s.since)}  (${mins(now - s.since)} min)` : 'unknown'
      console.log(`  ${bad(conditionLabel(s.condition))}\t${dim('since ' + since)}`)
    }
  }

  console.log(bold(`\nrecent (${items.length} of ${total})`))
  if (!items.length) console.log(dim(caseyText("bin/casey-alerts-command.js#w18")))
  for (const e of items) {
    const when = dim('[' + (fmtTimeLocal(e.at || Date.parse(e.t) || null) || caseyText("bin/casey-alerts-command.js#w19")) + ']')
    const evt = e.event === 'cleared' ? green('cleared') : red('raised ')
    console.log(`  ${when} ${evt} ${bold(conditionLabel(e.condition) || caseyText("bin/casey-alerts-command.js#w20"))}\t${dim(e.ref || '')}`)
    if (e.detail) console.log(`      ${e.detail}`)
  }
  if (corrupt) console.log(red(caseyText("bin/casey-alerts-command.js#w21", [corrupt])))

  const st = log.stats()
  console.log(dim(caseyText("bin/casey-alerts-command.js#w22", [st.archive_count, Math.round(st.total_bytes / 1024), Math.round(st.ceiling_bytes / 1024 / 1024)])))
  if (st.write_failures) console.log(bad(caseyText("bin/casey-alerts-command.js#w23", [st.write_failures, st.last_write_error])))
  console.log(dim(caseyText("bin/casey-alerts-command.js#w24", [ALERT_TAG])) + cyan(`grep ${ALERT_TAG} ${log.file}`) + dim(caseyText("bin/casey-alerts-command.js#w25")))
  console.log(dim(caseyText("bin/casey-alerts-command.js#w26")))
  process.exit(standing.length ? 1 : 0)
}
