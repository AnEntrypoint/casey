import { caseyText } from '../src/deployment-text.js'

import { createCaseStore } from '../src/case-store.js'
import { hostTimezone, hostIsLocal, LOCAL_TZ } from '../src/format.js'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { ROOT, bold, dim, green, red, cyan, ok, bad, warn, pkgVersion, hasCreds, partialCreds, portFree } from './casey-cli-ui.js'
import { checkConfigDrift } from './casey-config-drift.js'
import { publicSiteDir } from '../src/dashboard/routes/public-site.js'
import { RawLog } from '../src/core/raw-log.js'
import { runMetaChecks, runRoleChecks, runDataProcessorChecks, runVocabularyChecks } from './casey-doctor-checks.js'

const ENV_TEMPLATE = caseyText("bin/casey-setup.js#w0")

export async function cmdInit() {
  const dest = path.join(ROOT, '.env')
  if (existsSync(dest)) { console.log(warn(caseyText("bin/casey-setup.js#w1", [dest]))); return }
  writeFileSync(dest, ENV_TEMPLATE)
  console.log(ok(`wrote ${cyan(dest)}`))
  console.log(caseyText("bin/casey-setup.js#w2", [cyan(caseyText("bin/casey-setup.js#w3"))]))
}

async function checkTimeoutCoordination() {
  const attemptMs = Number(process.env.CASEY_LLM_TURN_TIMEOUT_MS) || 120000
  const hardDeadlineMs = Number(process.env.CASEY_TURN_HARD_DEADLINE_MS) || 120000
  let linkMs = Number(process.env.ACPTOAPI_CHAIN_LINK_TIMEOUT_MS)
  let linkSource = caseyText("bin/casey-setup.js#w4")
  if (!linkMs) {
    try {
      const chainMachineSrc = readFileSync(path.join(ROOT, 'node_modules', 'acptoapi', 'lib', 'chain-machine.js'), 'utf8')
      const m = chainMachineSrc.match(/DEFAULT_LINK_TIMEOUT_MS\s*=\s*Number\(process\.env\.ACPTOAPI_CHAIN_LINK_TIMEOUT_MS\)\s*\|\|\s*(\d+)/)
      linkMs = m ? Number(m[1]) : null
      linkSource = m ? caseyText("bin/casey-setup.js#w5") : null
    } catch { linkMs = null; linkSource = null }
  }
  if (linkMs == null) {
    console.log(warn(caseyText("bin/casey-setup.js#w6")))
    return 0
  }
  const budget = Math.min(attemptMs, hardDeadlineMs)
  if (linkMs >= budget) {
    console.log(bad(caseyText("bin/casey-setup.js#w7", [linkMs, linkSource, budget])))
    return 1
  }
  if (linkMs * 2 >= budget) {
    console.log(warn(caseyText("bin/casey-setup.js#w8", [linkMs, linkSource, budget])))
    return 0
  }
  console.log(ok(caseyText("bin/casey-setup.js#w9", [linkMs, linkSource, budget])))
  return 0
}

async function checkScript(script, okText, badText) {
  const { execFileSync } = await import('node:child_process')
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', script)], { cwd: ROOT, stdio: 'pipe' })
    console.log(ok(okText))
    return 0
  } catch (e) {
    console.log(bad(badText))
    return 1
  }
}

export async function cmdDoctor({ flags }) {
  console.log(bold(caseyText("bin/casey-setup.js#w10")) + dim(`  v${pkgVersion()}`))
  let problems = 0
  const major = Number(process.versions.node.split('.')[0])
  console.log(major >= 22 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} (need >=22)`))
  if (major < 22) problems++
  const envFile = path.join(ROOT, '.env')
  const envFromElsewhere = !!(process.env.DISCORD_BOT_TOKEN || process.env.WHATSAPP_API_TOKEN || process.env.CASEY_CONFIG_DIR)
  if (existsSync(envFile)) console.log(ok(caseyText("bin/casey-setup.js#w11", [envFile])))
  else if (envFromElsewhere) console.log(ok(caseyText("bin/casey-setup.js#w12", [envFile])))
  else console.log(warn(caseyText("bin/casey-setup.js#w13", [envFile, cyan(caseyText("bin/casey-setup.js#w14"))])))
  for (const dep of ['thatcher', 'acptoapi', 'express']) {
    try { await import(dep); console.log(ok(caseyText("bin/casey-setup.js#w15", [dep]))) }
    catch { console.log(bad(caseyText("bin/casey-setup.js#w16", [dep]))); problems++ }
  }
  problems += await checkScript('scan-deps.mjs',
    caseyText("bin/casey-setup.js#w17"),
    caseyText("bin/casey-setup.js#w18"))
  if (existsSync(path.join(ROOT, 'deps', 'freddie', '.git'))) {
    problems += await checkScript('check-submodules.mjs',
      caseyText("bin/casey-setup.js#w19"),
      caseyText("bin/casey-setup.js#w20"))
  }
  problems += await checkTimeoutCoordination()
  for (const ch of ['discord', 'whatsapp']) {
    if (hasCreds(ch)) console.log(ok(caseyText("bin/casey-setup.js#w21", [ch])))
    else if (partialCreds(ch)) { console.log(bad(caseyText("bin/casey-setup.js#w22", [ch]))); problems++ }
    else console.log(dim(caseyText("bin/casey-setup.js#w23", [ch])))
  }
  if (hasCreds('whatsapp') && !process.env.WHATSAPP_APP_SECRET) {
    console.log(bad(caseyText("bin/casey-setup.js#w24")))
    problems++
  }
  if (hasCreds('whatsapp') && !process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log(bad(caseyText("bin/casey-setup.js#w25")))
    problems++
  }
  const noChannel = !hasCreds('discord') && !hasCreds('whatsapp')
  if (noChannel) console.log(warn(caseyText("bin/casey-setup.js#w26")))
  if (noChannel) {
    console.log(dim(caseyText("bin/casey-setup.js#w27")))
  }
  const cfgFile = process.env.CASEY_CONFIG_DIR
    ? path.join(path.resolve(process.env.CASEY_CONFIG_DIR), 'thatcher.config.yml')
    : path.join(ROOT, 'thatcher.config.yml')
  console.log(existsSync(cfgFile) ? ok(caseyText("bin/casey-setup.js#w28", [cfgFile])) : bad(caseyText("bin/casey-setup.js#w29", [cfgFile])))
  if (!existsSync(cfgFile)) problems++
  else {
    try {
      createCaseStore({ config: cfgFile }).validateConfig()
      console.log(ok(caseyText("bin/casey-setup.js#w30")))
    } catch (e) {
      console.log(bad(caseyText("bin/casey-setup.js#w31", [e.message])))
      problems++
    }
  }
  problems += checkConfigDrift()
  console.log(ok(caseyText("bin/casey-setup.js#w32")))
  if (process.env.CASEY_PUBLIC_URL && !process.env.CASEY_TRUST_PROXY_HOPS) {
    console.log(warn(caseyText("bin/casey-setup.js#w33")))
  }
  if (process.env.CASEY_PUBLIC_SITE_DIR) {
    try { publicSiteDir(); console.log(ok(caseyText("bin/casey-setup.js#w34", [process.env.CASEY_PUBLIC_SITE_DIR]))) } catch (e) { console.log(bad(e.message)); problems++ }
  }
  console.log(process.env.CASEY_PUBLIC_URL ? ok(caseyText("bin/casey-setup.js#w35", [process.env.CASEY_PUBLIC_URL])) : dim(caseyText("bin/casey-setup.js#w36")))
  if (process.env.CASEY_COOKIE_SECURE === '0' && /^https:/i.test(process.env.CASEY_PUBLIC_URL || '')) {
    console.log(bad(caseyText("bin/casey-setup.js#w37")))
    problems++
  }
  console.log(hostIsLocal() ? ok(caseyText("bin/casey-setup.js#tz-ok", [LOCAL_TZ])) : warn(caseyText("bin/casey-setup.js#tz-warn", [hostTimezone() || 'unknown', LOCAL_TZ])))
  const alertHook = process.env.CASEY_ALERT_WEBHOOK || process.env.CASEY_HANDOFF_WEBHOOK
  const alertLogFile = path.join(process.cwd(), 'data', 'alerts', 'alerts.jsonl')
  console.log(alertHook
    ? ok(caseyText("bin/casey-setup.js#w38", [process.env.CASEY_ALERT_WEBHOOK ? ' CASEY_ALERT_WEBHOOK' : ' CASEY_HANDOFF_WEBHOOK (fallback)']))
    : warn(caseyText("bin/casey-setup.js#w39", [alertLogFile, cyan(caseyText("bin/casey-setup.js#w40"))])))
  if (!alertHook && existsSync(alertLogFile)) {
    try {
      const { AlertLog, AlertGate } = await import('../src/alert-log.js')
      const dataDir0 = path.join(process.cwd(), 'data')
      const st = new AlertLog({ dataDir: dataDir0, stderr: false }).stats()
      const standing = new AlertGate({ dataDir: dataDir0 }).snapshot()
      if (standing.length) {
        console.log(bad(caseyText("bin/casey-setup.js#w41", [standing.length, standing.map(s => s.condition).join(', '), cyan(caseyText("bin/casey-setup.js#w42"))])))
        problems++
      } else console.log(ok(caseyText("bin/casey-setup.js#w43")))
      console.log(dim(caseyText("bin/casey-setup.js#w44", [st.archive_count, Math.round(st.total_bytes / 1024), Math.round(st.ceiling_bytes / 1024 / 1024)])))
    } catch (e) {
      console.log(warn(caseyText("bin/casey-setup.js#w45", [e.message])))
    }
  }
  const dataDir = path.join(process.cwd(), 'data')
  const dbFile = path.join(dataDir, 'db.sqlite')
  console.log(existsSync(dbFile)
    ? ok(caseyText("bin/casey-setup.js#w46", [dbFile]))
    : dim(caseyText("bin/casey-setup.js#w47", [dbFile])))
  if (existsSync(dbFile)) {
    try {
      const { createClient } = await import('@libsql/client')
      const db = createClient({ url: 'file:' + dbFile })
      const open = await db.execute(caseyText("bin/casey-setup.js#w48"))
      const tagged = await db.execute(caseyText("bin/casey-setup.js#w49"))
      const openN = Number(open.rows[0]?.[0]) || 0
      const taggedN = Number(tagged.rows[0]?.[0]) || 0
      if (openN && !taggedN) console.log(warn(caseyText("bin/casey-setup.js#w50", [openN])))
      else if (taggedN) console.log(ok(caseyText("bin/casey-setup.js#w51", [taggedN])))
      else console.log(dim(caseyText("bin/casey-setup.js#w52")))
    } catch (e) {
      console.log(dim(caseyText("bin/casey-setup.js#w53", [e.message])))
    }
  }
  const rawLogFile = path.join(dataDir, 'raw-log', 'observations.jsonl')
  if (existsSync(rawLogFile)) {
    try {
      const st = new RawLog({ dataDir }).stats()
      const corrupt = st.corrupt_lines
      if (corrupt > 0) { console.log(bad(caseyText("bin/casey-setup.js#w54", [corrupt, corrupt]))); problems++ }
      else console.log(ok(caseyText("bin/casey-setup.js#w55")))
      if (st.write_failures > 0) {
        console.log(bad(caseyText("bin/casey-setup.js#w56", [st.write_failures, st.dir])))
        problems++
      }
      console.log(dim(caseyText("bin/casey-setup.js#w57", [st.observations, st.archive_count, Math.round(st.total_bytes / 1024)])))
    } catch (e) {
      console.log(warn(caseyText("bin/casey-setup.js#w58", [e.message])))
    }
  }
  try { problems += await runMetaChecks(flags) } catch (e) { console.log(warn(caseyText("bin/casey-setup.js#w59", [e.message]))) }
  try { problems += await runRoleChecks() } catch (e) { console.log(warn(caseyText("bin/casey-setup.js#w60", [e.message]))) }
  try { problems += await runDataProcessorChecks() } catch (e) { console.log(warn(caseyText("bin/casey-setup.js#w61", [e.message]))) }
  try { problems += await runVocabularyChecks() } catch (e) { console.log(warn(caseyText("bin/casey-setup.js#w62", [e.message]))) }
  console.log('')
  const port = Number(flags.port || 4000)
  if (await portFree(port)) console.log(ok(caseyText("bin/casey-setup.js#w63", [port])))
  else {
    let held = false
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/ready`, { signal: AbortSignal.timeout(3000) })
      const j = await r.json().catch(() => null)
      held = !!(j && typeof j === 'object' && 'ready' in j)
    } catch { held = false }
    if (held) console.log(ok(caseyText("bin/casey-setup.js#w64", [port])))
    else { console.log(bad(caseyText("bin/casey-setup.js#w65", [port]))); problems++ }
  }
  const nextStep = noChannel ? caseyText("bin/casey-setup.js#w66") : caseyText("bin/casey-setup.js#w67")
  console.log(problems
    ? red(caseyText("bin/casey-setup.js#w68", [problems, cyan(nextStep)]))
    : green(caseyText("bin/casey-setup.js#w69", [nextStep])))
  process.exit(problems ? 1 : 0)
}
