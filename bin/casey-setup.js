
import { createCaseStore } from '../src/case-store.js'
import { hostTimezone, hostIsSAST, SAST_TZ } from '../src/format.js'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { ROOT, bold, dim, green, red, cyan, ok, bad, warn, pkgVersion, hasCreds, partialCreds, portFree } from './casey-cli-ui.js'
import { checkConfigDrift } from './casey-config-drift.js'
import { publicSiteDir } from '../src/dashboard/routes/public-site.js'
import { RawLog } from '../src/core/raw-log.js'
import { runMetaChecks, runRoleChecks, runDataProcessorChecks, runVocabularyChecks } from './casey-doctor-checks.js'

const ENV_TEMPLATE = `# casey environment -- fill in the channels you want, leave the rest blank.
# Discord:
DISCORD_BOT_TOKEN=

# WhatsApp Cloud API (both required to enable the real channel):
WHATSAPP_API_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
# Required when WhatsApp credentials are set (HMAC-SHA256 webhook signature check):
WHATSAPP_APP_SECRET=
# Webhook verification handshake token (set in the Meta developer console).
# Required too: casey refuses to serve WhatsApp without it.
WHATSAPP_VERIFY_TOKEN=
# Fix the public-facing webhook path (useful behind a reverse proxy or ngrok).
# The same path is served on BOTH ports below.
#WHATSAPP_WEBHOOK_PATH=/webhooks/whatsapp

# freddie's own socket carries the webhook, and it is NOT the dashboard's --
# two different listeners, and sharing a port costs the dashboard EADDRINUSE.
# But EITHER is a valid address to register with Meta: the same webhook is also
# served on the dashboard's --port, off the same adapter and the same handler.
# Behind a reverse proxy that forwards one port, that port is the dashboard's
# (the SPA and /api/* live there), so register that one. Nothing to switch on.
#CASEY_WEBHOOK_HOST=127.0.0.1
#CASEY_WEBHOOK_PORT=4001

# HMAC key signing the dashboard session cookie. Random per process when blank,
# so every restart logs every operator out. Set it to survive a restart.
CASEY_SESSION_SECRET=

# Per-provider-hop timeout for the LLM chain. acptoapi's own shipped default is
# 120000, equal to casey's whole per-attempt budget, so one hung provider can
# consume an entire turn. Keep this comfortably below it -- casey doctor checks.
ACPTOAPI_CHAIN_LINK_TIMEOUT_MS=30000

# Public URL of this casey instance (optional). When set, the agent mentions it
# to the contact on first message so they can fill in more details via the web form:
#CASEY_PUBLIC_URL=https://your-domain.example.com
# Absolute directory holding index.html plus assets for an optional public landing
# page: / serves it to visitors without a session, /site/ serves its assets, and
# staff sign in at /app. Unset, / is the staff console as before.
#CASEY_PUBLIC_SITE_DIR=/srv/site
# Set this to the real proxy hop count if a reverse proxy fronts casey, or the
# public report form's rate limiter sees every reporter as one address:
#CASEY_TRUST_PROXY_HOPS=1

# Basemap tiles. By default the dashboard serves them from its OWN origin off a
# bounded on-disk cache, and only fetches a square it has never seen. That is
# on by default for two reasons: the bytes (a cold map is ~281 KB of tiles,
# again on every pan) and, more importantly, because a tile request tells the
# tile server which map square this deployment is looking at and when.
# Set to 0 to send browsers straight to the upstream instead.
#CASEY_TILE_PROXY=1
# The upstream tile template. Point it at your OWN renderer to stop disclosing
# anything at all; any {z}/{x}/{y} URL works.
#CASEY_TILE_URL=https://tile.openstreetmap.org/{z}/{x}/{y}.png
# Cache ceiling in bytes, LRU-evicted. Default 268435456 (256 MB), which is
# about ten times a typical deployment's whole working set of map squares --
# eviction stays the exception, because a cache that thrashes re-fetches the
# same squares and OSM's usage policy asks for the opposite.
#CASEY_TILE_CACHE_MAX_BYTES=268435456
# Sent upstream on every tile fetch. OSM's usage policy REQUIRES a string that
# names this deployment and is contactable, and blocks traffic that uses a
# library default. Defaults to the brand name plus CASEY_PUBLIC_URL; set this
# to a real contact URL or address if you run at any volume.
#CASEY_TILE_USER_AGENT=

# Data retention -- OFF unless you set a number of days here. Unset, casey keeps
# every case forever, nothing expires, and \`casey retention\` reads nothing. This
# is a deployment policy decision (how long may identifiable report data be
# kept?) and casey deliberately ships no default for it.
# The window is measured from a CLOSED case's LAST ACTIVITY. An open case, one
# carrying an unresolved health guardrail breach, one tagged needs-human or
# draft-pending, and one whose timestamps cannot be read are never expired at
# any age. \`casey retention\` with no --yes reports what this would do and
# changes nothing.
#CASEY_RETENTION_DAYS=365
# archive (default) exports the whole case to a JSON file and takes it out of the
# live read paths, destroying nothing. erase additionally scrubs the identifying
# fields and removes the stored conversation. Neither frees bytes in db.sqlite.
#CASEY_RETENTION_ACTION=archive
# Where archived cases are written. Default <data dir>/archive.
#CASEY_RETENTION_ARCHIVE_DIR=

# Development overrides:
#CASEY_LOG=silent    # suppress structured JSON logs
`

export async function cmdInit() {
  const dest = path.join(ROOT, '.env')
  if (existsSync(dest)) { console.log(warn(`.env already exists at ${dest} - leaving it untouched.`)); return }
  writeFileSync(dest, ENV_TEMPLATE)
  console.log(ok(`wrote ${cyan(dest)}`))
  console.log(`  Fill in the channel(s) you want, then run ${cyan('casey doctor')} to check it.`)
}

async function checkTimeoutCoordination() {
  const attemptMs = Number(process.env.CASEY_LLM_TURN_TIMEOUT_MS) || 120000
  const hardDeadlineMs = Number(process.env.CASEY_TURN_HARD_DEADLINE_MS) || 120000
  let linkMs = Number(process.env.ACPTOAPI_CHAIN_LINK_TIMEOUT_MS)
  let linkSource = 'ACPTOAPI_CHAIN_LINK_TIMEOUT_MS env'
  if (!linkMs) {
    try {
      const chainMachineSrc = readFileSync(path.join(ROOT, 'node_modules', 'acptoapi', 'lib', 'chain-machine.js'), 'utf8')
      const m = chainMachineSrc.match(/DEFAULT_LINK_TIMEOUT_MS\s*=\s*Number\(process\.env\.ACPTOAPI_CHAIN_LINK_TIMEOUT_MS\)\s*\|\|\s*(\d+)/)
      linkMs = m ? Number(m[1]) : null
      linkSource = m ? `acptoapi's installed default (chain-machine.js)` : null
    } catch { linkMs = null; linkSource = null }
  }
  if (linkMs == null) {
    console.log(warn('timeout coordination: could not resolve ACPTOAPI_CHAIN_LINK_TIMEOUT_MS (acptoapi not installed yet?) - skipping check'))
    return 0
  }
  const budget = Math.min(attemptMs, hardDeadlineMs)
  if (linkMs >= budget) {
    console.log(bad(`timeout coordination: ACPTOAPI_CHAIN_LINK_TIMEOUT_MS=${linkMs}ms (${linkSource}) >= per-attempt budget ${budget}ms - a single unhealthy provider hop can consume an entire attempt, starving the retry loop; set ACPTOAPI_CHAIN_LINK_TIMEOUT_MS in .env well below CASEY_LLM_TURN_TIMEOUT_MS/CASEY_TURN_HARD_DEADLINE_MS`))
    return 1
  }
  if (linkMs * 2 >= budget) {
    console.log(warn(`timeout coordination: ACPTOAPI_CHAIN_LINK_TIMEOUT_MS=${linkMs}ms (${linkSource}) leaves room for at most 1 unhealthy hop within the ${budget}ms per-attempt budget - a chain walking 2+ bad providers in one attempt will exhaust it`))
    return 0
  }
  console.log(ok(`timeout coordination: ACPTOAPI_CHAIN_LINK_TIMEOUT_MS=${linkMs}ms (${linkSource}) leaves room for multiple hops within the ${budget}ms per-attempt budget`))
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
  console.log(bold('casey doctor') + dim(`  v${pkgVersion()}`))
  let problems = 0
  const major = Number(process.versions.node.split('.')[0])
  console.log(major >= 22 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} (need >=22)`))
  if (major < 22) problems++
  const envFile = path.join(ROOT, '.env')
  const envFromElsewhere = !!(process.env.DISCORD_BOT_TOKEN || process.env.WHATSAPP_API_TOKEN || process.env.CASEY_CONFIG_DIR)
  if (existsSync(envFile)) console.log(ok(`.env present (${envFile})`))
  else if (envFromElsewhere) console.log(ok(`no ${envFile} - configuration is coming from the environment instead`))
  else console.log(warn(`no .env at ${envFile} - run ${cyan('casey init')} to scaffold one (channels can still come from the environment)`))
  for (const dep of ['thatcher', 'acptoapi', 'express']) {
    try { await import(dep); console.log(ok(`dependency ${dep} resolves`)) }
    catch { console.log(bad(`dependency ${dep} does not resolve - run npm install`)); problems++ }
  }
  problems += await checkScript('scan-deps.mjs',
    'scan-deps: no HiddenSpawn-pattern matches in own source or node_modules',
    'scan-deps found a match -- run `npm run scan-deps` for details before starting casey')
  if (existsSync(path.join(ROOT, 'deps', 'freddie', '.git'))) {
    problems += await checkScript('check-submodules.mjs',
      'submodules: all deps/* on main, clean, up to date',
      'submodules need attention -- run `npm run check-submodules` for details')
  }
  problems += await checkTimeoutCoordination()
  for (const ch of ['discord', 'whatsapp']) {
    if (hasCreds(ch)) console.log(ok(`channel ${ch}: credentials present`))
    else if (partialCreds(ch)) { console.log(bad(`channel ${ch}: partial credentials - set BOTH WHATSAPP_API_TOKEN and WHATSAPP_PHONE_NUMBER_ID`)); problems++ }
    else console.log(dim(`  channel ${ch}: not configured (optional)`))
  }
  if (hasCreds('whatsapp') && !process.env.WHATSAPP_APP_SECRET) {
    console.log(bad('WHATSAPP_APP_SECRET is required to enable WhatsApp (verify inbound webhook signatures)'))
    problems++
  }
  if (hasCreds('whatsapp') && !process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log(bad('WHATSAPP_VERIFY_TOKEN is unset - casey will not serve WhatsApp without it (freddie\'s platform plugin throws while mounting the Cordis tree); set WHATSAPP_VERIFY_TOKEN to the token you set in the Meta developer console'))
    problems++
  }
  const noChannel = !hasCreds('discord') && !hasCreds('whatsapp')
  if (noChannel) console.log(warn('no real channel connected - casey cannot start without at least one of discord/whatsapp configured'))
  if (noChannel) {
    console.log(dim('  run mode will be dashboard-only: no health sweep, and no AI-helper / receive / runtime status or reply sending in the console'))
  }
  const cfgFile = process.env.CASEY_CONFIG_DIR
    ? path.join(path.resolve(process.env.CASEY_CONFIG_DIR), 'thatcher.config.yml')
    : path.join(ROOT, 'thatcher.config.yml')
  console.log(existsSync(cfgFile) ? ok(`thatcher.config.yml present (${cfgFile})`) : bad(`thatcher.config.yml missing at ${cfgFile}`))
  if (!existsSync(cfgFile)) problems++
  else {
    try {
      createCaseStore({ config: cfgFile }).validateConfig()
      console.log(ok('case store / workflow config valid'))
    } catch (e) {
      console.log(bad(`case store / workflow config: ${e.message}`))
      problems++
    }
  }
  problems += checkConfigDrift()
  console.log(ok('dashboard requires per-operator login (no bearer-token bypass)'))
  if (process.env.CASEY_PUBLIC_URL && !process.env.CASEY_TRUST_PROXY_HOPS) {
    console.log(warn('CASEY_TRUST_PROXY_HOPS unset with CASEY_PUBLIC_URL set - if a reverse proxy fronts casey, the /report rate limiter will see every client as one IP; set CASEY_TRUST_PROXY_HOPS to the real proxy hop count'))
  }
  if (process.env.CASEY_PUBLIC_SITE_DIR) {
    try { publicSiteDir(); console.log(ok(`CASEY_PUBLIC_SITE_DIR serves ${process.env.CASEY_PUBLIC_SITE_DIR}`)) } catch (e) { console.log(bad(e.message)); problems++ }
  }
  console.log(process.env.CASEY_PUBLIC_URL ? ok(`CASEY_PUBLIC_URL set (${process.env.CASEY_PUBLIC_URL})`) : dim('  CASEY_PUBLIC_URL unset - contacts will not receive a web form link (optional)'))
  if (process.env.CASEY_COOKIE_SECURE === '0' && /^https:/i.test(process.env.CASEY_PUBLIC_URL || '')) {
    console.log(bad('CASEY_COOKIE_SECURE=0 with an https CASEY_PUBLIC_URL - the dashboard session cookie is being sent WITHOUT the Secure flag on a deployment that declares itself publicly reachable over TLS; unset it (Secure is the default) or set it to 1'))
    problems++
  }
  console.log(hostIsSAST() ? ok(`host timezone is SAST (${SAST_TZ})`) : warn(`host timezone is ${hostTimezone() || 'unknown'}, not ${SAST_TZ} - casey still shows all times in SAST, but your OS clock differs`))
  const alertHook = process.env.CASEY_ALERT_WEBHOOK || process.env.CASEY_HANDOFF_WEBHOOK
  const alertLogFile = path.join(process.cwd(), 'data', 'alerts', 'alerts.jsonl')
  console.log(alertHook
    ? ok(`breach alerts on${process.env.CASEY_ALERT_WEBHOOK ? ' CASEY_ALERT_WEBHOOK' : ' CASEY_HANDOFF_WEBHOOK (fallback)'}`)
    : warn(`no alert webhook - alerts fall back to the local alert log at ${alertLogFile} (and stderr). A deaf channel, a dead provider with messages queuing, and a stopped guardrail sweep are written there once per rising edge; read them with ${cyan('casey alerts')} (exits 1 while anything is standing, so cron/systemd can page on it). Set CASEY_ALERT_WEBHOOK to push them somewhere a person will see without watching a file.`))
  if (!alertHook && existsSync(alertLogFile)) {
    try {
      const { AlertLog, AlertGate } = await import('../src/alert-log.js')
      const dataDir0 = path.join(process.cwd(), 'data')
      const st = new AlertLog({ dataDir: dataDir0, stderr: false }).stats()
      const standing = new AlertGate({ dataDir: dataDir0 }).snapshot()
      if (standing.length) {
        console.log(bad(`${standing.length} system alert(s) standing right now: ${standing.map(s => s.condition).join(', ')} - run ${cyan('casey alerts')}`))
        problems++
      } else console.log(ok('alert log: nothing standing'))
      console.log(dim(`  alert log: ${st.archive_count} archive(s), ${Math.round(st.total_bytes / 1024)} KB of a ${Math.round(st.ceiling_bytes / 1024 / 1024)} MB ceiling`))
    } catch (e) {
      console.log(warn(`alert log could not be read (${e.message})`))
    }
  }
  const dataDir = path.join(process.cwd(), 'data')
  const dbFile = path.join(dataDir, 'db.sqlite')
  console.log(existsSync(dbFile)
    ? ok(`case data at ${dbFile}`)
    : dim(`  no case data yet (will be created at ${dbFile})`))
  if (existsSync(dbFile)) {
    try {
      const { createClient } = await import('@libsql/client')
      const db = createClient({ url: 'file:' + dbFile })
      const open = await db.execute(`SELECT COUNT(*) n FROM "case" WHERE status IS NOT NULL AND status != 'closed'`)
      const tagged = await db.execute(`SELECT COUNT(*) n FROM "case" WHERE tags LIKE '%health:%'`)
      const openN = Number(open.rows[0]?.[0]) || 0
      const taggedN = Number(tagged.rows[0]?.[0]) || 0
      if (openN && !taggedN) console.log(warn(`health sweep has never flagged anything across ${openN} open case(s) - if this instance runs dashboard-only the sweep is not scheduled at all, so stalled and abandoned cases are going undetected`))
      else if (taggedN) console.log(ok(`health sweep has run (${taggedN} case(s) currently flagged)`))
      else console.log(dim('  no open cases yet - nothing for the health sweep to flag'))
    } catch (e) {
      console.log(dim(`  health sweep state could not be read (${e.message})`))
    }
  }
  const rawLogFile = path.join(dataDir, 'raw-log', 'observations.jsonl')
  if (existsSync(rawLogFile)) {
    try {
      const st = new RawLog({ dataDir }).stats()
      const corrupt = st.corrupt_lines
      if (corrupt > 0) { console.log(bad(`provenance raw log has ${corrupt} unreadable line(s) - a crash mid-append truncated ${corrupt} observation(s); they are skipped, not recoverable`)); problems++ }
      else console.log(ok('provenance raw log reads clean'))
      if (st.write_failures > 0) {
        console.log(bad(`provenance raw log failed ${st.write_failures} write(s) - those observations were LOST (usually a full or read-only disk); free space and check permissions on ${st.dir}`))
        problems++
      }
      console.log(dim(`  provenance raw log: ${st.observations} observation(s), ${st.archive_count} archive(s), ${Math.round(st.total_bytes / 1024)} KB total`))
    } catch (e) {
      console.log(warn(`provenance raw log could not be read (${e.message})`))
    }
  }
  try { problems += await runMetaChecks(flags) } catch (e) { console.log(warn(`Meta checks could not run (${e.message})`)) }
  try { problems += await runRoleChecks() } catch (e) { console.log(warn(`role checks could not run (${e.message})`)) }
  try { problems += await runDataProcessorChecks() } catch (e) { console.log(warn(`data processor checks could not run (${e.message})`)) }
  try { problems += await runVocabularyChecks() } catch (e) { console.log(warn(`vocabulary checks could not run (${e.message})`)) }
  console.log('')
  const port = Number(flags.port || 4000)
  if (await portFree(port)) console.log(ok(`port ${port} is free`))
  else {
    let held = false
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/ready`, { signal: AbortSignal.timeout(3000) })
      const j = await r.json().catch(() => null)
      held = !!(j && typeof j === 'object' && 'ready' in j)
    } catch { held = false }
    if (held) console.log(ok(`port ${port} is held by a running casey (this is expected while it is up)`))
    else { console.log(bad(`port ${port} is in use by something else - start with --port <other>`)); problems++ }
  }
  const nextStep = noChannel ? 'casey dashboard' : 'casey up'
  console.log(problems
    ? red(`\n${problems} problem(s) to fix before ${cyan(nextStep)}`)
    : green(`\nall good - run ${nextStep}`))
  process.exit(problems ? 1 : 0)
}
