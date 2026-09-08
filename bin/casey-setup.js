// casey-setup.js  --  the two commands an operator runs BEFORE casey serves
// anything: `casey init` (scaffold a .env) and `casey doctor` (the preflight
// that says exactly what is and is not ready). Split out of bin/casey-cli.mjs's
// 698-line main() verbatim -- same checks, same order, same strings, same exit
// codes.

import { createCaseStore } from '../src/case-store.js'
import { hostTimezone, hostIsSAST, SAST_TZ } from '../src/format.js'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { ROOT, bold, dim, green, red, cyan, ok, bad, warn, pkgVersion, hasCreds, partialCreds, portFree } from './casey-cli-ui.js'
import { checkConfigDrift } from './casey-config-drift.js'
import { RawLog } from '../src/core/raw-log.js'

const ENV_TEMPLATE = `# casey environment -- fill in the channels you want, leave the rest blank.
# Discord:
DISCORD_BOT_TOKEN=

# WhatsApp Cloud API (both required to enable the real channel):
WHATSAPP_API_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
# Required when WhatsApp credentials are set (HMAC-SHA256 webhook signature check):
WHATSAPP_APP_SECRET=
# Webhook verification handshake token (set in the Meta developer console):
WHATSAPP_VERIFY_TOKEN=
# Fix the public-facing webhook path (useful behind a reverse proxy or ngrok).
# There is no separate webhook PORT: the webhook shares the dashboard port.
#WHATSAPP_WEBHOOK_PATH=/webhooks/whatsapp

# Public URL of this casey instance (optional). When set, the agent mentions it
# to the contact on first message so they can fill in more details via the web form:
#CASEY_PUBLIC_URL=https://your-domain.example.com

# Development overrides:
#CASEY_LOG=silent    # suppress structured JSON logs (used by tests)
`

export async function cmdInit() {
  const dest = path.join(ROOT, '.env')
  if (existsSync(dest)) { console.log(warn(`.env already exists at ${dest} - leaving it untouched.`)); return }
  writeFileSync(dest, ENV_TEMPLATE)
  console.log(ok(`wrote ${cyan(dest)}`))
  console.log(`  Fill in the channel(s) you want, then run ${cyan('casey doctor')} to check it.`)
}

// The timeout-coordination row of doctor. Split out because it is the one check
// that reads a LIVE value out of an installed dependency's source rather than
// asserting anything about casey's own tree -- see the comment inside.
async function checkTimeoutCoordination() {
  // Timeout coordination (AGENTS.md's "Timeout Coordination" section): the
  // per-attempt LLM turn budget must comfortably exceed the per-provider
  // chain-link timeout, or a single unhealthy provider hop can consume an
  // entire attempt's budget and starve hooks/turn-attempts.js's retry loop of
  // any real remaining time. This is not read from casey's own prose --
  // acptoapi is a floating github:AnEntrypoint/acptoapi#main dependency
  // with no version pin, so its shipped DEFAULT_LINK_TIMEOUT_MS can drift
  // out from under casey on any npm install with no casey-side commit; a
  // hardcoded assumption here would go stale exactly the way AGENTS.md's
  // own prose already did (its documented 20s default drifted to the
  // installed package's real 120s default with nothing to catch it). Read
  // the LIVE resolved value the same way the library itself resolves it:
  // explicit env var, else the installed chain-machine.js's own coded
  // fallback, parsed directly from its source rather than re-guessed here.
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
  // "Comfortably below": a single link timeout should leave room for at
  // least 2 hops within one attempt, matching the "full chain walk
  // completes per attempt" constraint AGENTS.md documents.
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

// A doctor row that shells out to one of casey's own scripts: green when the
// script exits 0, a named problem when it does not. Both callers below want the
// identical shape, and neither wants the script's own stdout.
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
  // Node version
  const major = Number(process.versions.node.split('.')[0])
  console.log(major >= 22 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} (need >=22)`))
  if (major < 22) problems++
  // .env presence
  console.log(existsSync(path.join(ROOT, '.env')) ? ok('.env present') : warn(`.env missing - run ${cyan('casey init')} (channels can still come from the environment)`))
  // dependencies resolve
  for (const dep of ['thatcher', 'acptoapi', 'express']) {
    try { await import(dep); console.log(ok(`dependency ${dep} resolves`)) }
    catch { console.log(bad(`dependency ${dep} does not resolve - run npm install`)); problems++ }
  }
  // Supply-chain scan: node_modules for the obfuscated-dropper signature
  // found in thatcher's compromised commit 724e8bce (2026-08-09) -- see
  // AGENTS.md's "thatcher / busybase chain" section. Runs on every doctor
  // pass (not just postinstall) so a manually-edited/replaced node_modules
  // file is caught too, not only a fresh install.
  problems += await checkScript('scan-deps.mjs',
    'scan-deps: no HiddenSpawn-pattern matches in own source or node_modules',
    'scan-deps found a match -- run `npm run scan-deps` for details before starting casey')
  // Submodule health: every deps/* checkout must track a real "main"
  // branch, clean, not behind origin -- a detached/stale submodule is how
  // the thatcher HiddenSpawn incident's compromised commit went unnoticed.
  // See AGENTS.md's "Supply-chain integrity" section. A bare clone with no
  // `git submodule update --init` yet has empty deps/* dirs -- that is not
  // a doctor failure (npm install still resolves everything from the
  // registry), so skip the check entirely rather than false-failing it.
  if (existsSync(path.join(ROOT, 'deps', 'freddie', '.git'))) {
    problems += await checkScript('check-submodules.mjs',
      'submodules: all deps/* on main, clean, up to date',
      'submodules need attention -- run `npm run check-submodules` for details')
  }
  problems += await checkTimeoutCoordination()
  // channels
  for (const ch of ['discord', 'whatsapp']) {
    if (hasCreds(ch)) console.log(ok(`channel ${ch}: credentials present`))
    else if (partialCreds(ch)) { console.log(bad(`channel ${ch}: partial credentials - set BOTH WHATSAPP_API_TOKEN and WHATSAPP_PHONE_NUMBER_ID`)); problems++ }
    else console.log(dim(`  channel ${ch}: not configured (optional)`))
  }
  // The WhatsApp webhook trusts unsigned bodies when WHATSAPP_APP_SECRET is
  // unset (freddie verifies the X-Hub-Signature-256 HMAC only when the secret
  // is present). Without it anyone who can reach the webhook can forge inbound
  // farmer messages, so flag it loudly when the channel is otherwise live.
  if (hasCreds('whatsapp') && !process.env.WHATSAPP_APP_SECRET) {
    console.log(bad('WHATSAPP_APP_SECRET is required to enable WhatsApp (verify inbound webhook signatures)'))
    problems++
  }
  // casey's own WhatsappAdapter (src/adapters/whatsapp.js) requires
  // WHATSAPP_VERIFY_TOKEN and throws at start() when unset -- no silent
  // guessable-default fallback (the old freddie adapter's 'freddie' literal
  // default is gone). A hard problem, not just a warning.
  if (hasCreds('whatsapp') && !process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log(bad('WHATSAPP_VERIFY_TOKEN is unset - webhook verification will fail to start (set WHATSAPP_VERIFY_TOKEN to a real secret)'))
    problems++
  }
  // Not counted as a problem: `casey dashboard` is a legitimate way to run
  // with no channel at all. It does decide what the closing line may
  // recommend, though -- see noChannel below.
  const noChannel = !hasCreds('discord') && !hasCreds('whatsapp')
  if (noChannel) console.log(warn('no real channel connected - casey cannot start without at least one of discord/whatsapp configured'))
  // Which run mode this boot will actually take, and what that costs. With no
  // channel, `up` cannot start and the realistic command is `casey dashboard`
  // -- which calls createDashboard(store, {port}) and passes NONE of the
  // capabilities cmdUp and bin/worker.js pass it. The console then renders a
  // "Sweep now" button whose endpoint answers 501, and an "AI helper: unknown"
  // pill that is telling the truth because nothing handed it a way to ask.
  // Doctor already knows the channel state; saying what it implies is the
  // difference between a deployer discovering this here and discovering it by
  // pressing a button that was never going to work.
  if (noChannel) {
    console.log(dim('  run mode will be dashboard-only: no health sweep, and no AI-helper / receive / runtime status or reply sending in the console'))
  }
  // thatcher config -- same CASEY_CONFIG_DIR > cwd precedence as
  // case-store.js's own CaseStore constructor default (see there for why).
  const cfgFile = process.env.CASEY_CONFIG_DIR
    ? path.join(path.resolve(process.env.CASEY_CONFIG_DIR), 'thatcher.config.yml')
    : path.join(ROOT, 'thatcher.config.yml')
  console.log(existsSync(cfgFile) ? ok(`thatcher.config.yml present (${cfgFile})`) : bad(`thatcher.config.yml missing at ${cfgFile}`))
  if (!existsSync(cfgFile)) problems++
  // Validate the workflow stage graph the same way init() does, but without
  // booting thatcher or touching a DB (pure config read). A broken graph
  // (unknown transition target, status enum missing a stage) otherwise passes
  // doctor green and only crashes at `casey up`.
  else {
    try {
      createCaseStore({ config: cfgFile }).validateConfig()
      console.log(ok('case store / workflow config valid'))
    } catch (e) {
      console.log(bad(`case store / workflow config: ${e.message}`))
      problems++
    }
  }
  // Config drift: CASEY_CONFIG_DIR wholesale-REPLACES casey's base config
  // (src/config-loader.js resolves exactly one dir, no layering), so a
  // deployment's three config files are whole-file forks that nothing keeps in
  // step with casey's own. This row compares their SHAPE against casey's base
  // and names any key the deployment has fallen behind on. See
  // bin/casey-config-drift.js for why each file is compared the way it is.
  problems += checkConfigDrift()
  // dashboard auth -- per-operator login (dashboard/auth.js) gates every route
  // regardless of any env var; there is no bearer-token bypass any more.
  console.log(ok('dashboard requires per-operator login (no bearer-token bypass)'))
  // The public /report form's rate limiter keys on req.ip. Unset behind a real
  // reverse proxy, every client collapses to the proxy's own IP (the limiter
  // self-DoSes the whole form); set too high/untrusted, a client can spoof
  // X-Forwarded-For to bypass it outright. Neither failure crashes casey up,
  // so flag it here rather than let it surface as a silent production gap.
  if (process.env.CASEY_PUBLIC_URL && !process.env.CASEY_TRUST_PROXY_HOPS) {
    console.log(warn('CASEY_TRUST_PROXY_HOPS unset with CASEY_PUBLIC_URL set - if a reverse proxy fronts casey, the /report rate limiter will see every client as one IP; set CASEY_TRUST_PROXY_HOPS to the real proxy hop count'))
  }
  // public URL (optional but useful)
  console.log(process.env.CASEY_PUBLIC_URL ? ok(`CASEY_PUBLIC_URL set (${process.env.CASEY_PUBLIC_URL})`) : dim('  CASEY_PUBLIC_URL unset - contacts will not receive a web form link (optional)'))
  // The session cookie fails SAFE -- dashboard/auth.js adds Secure unless
  // CASEY_COOKIE_SECURE is explicitly '0' -- and .env.example documents that
  // opt-out as being for a plain-HTTP dev or LAN deployment. Neither of those
  // facts helps if the opt-out is still set when the deployment goes public,
  // which is the one combination worth naming: a session cookie without Secure
  // travels in the clear over any http:// hop, on the shared and mobile
  // networks this deployment actually runs on. Keyed on an https CASEY_PUBLIC_URL
  // because that is the deployment declaring itself publicly reachable over TLS;
  // a local http dev boot stays silent, which is the whole point of not making
  // this a blanket warning.
  if (process.env.CASEY_COOKIE_SECURE === '0' && /^https:/i.test(process.env.CASEY_PUBLIC_URL || '')) {
    console.log(bad('CASEY_COOKIE_SECURE=0 with an https CASEY_PUBLIC_URL - the dashboard session cookie is being sent WITHOUT the Secure flag on a deployment that declares itself publicly reachable over TLS; unset it (Secure is the default) or set it to 1'))
    problems++
  }
  // host timezone -- casey always renders absolute times in SAST regardless of
  // the host clock, so a non-SAST host is fine (not a problem), but flag it so
  // an operator reading raw OS timestamps elsewhere knows the offset.
  console.log(hostIsSAST() ? ok(`host timezone is SAST (${SAST_TZ})`) : warn(`host timezone is ${hostTimezone() || 'unknown'}, not ${SAST_TZ} - casey still shows all times in SAST, but your OS clock differs`))
  // alert webhook -- high-severity guardrail breaches page the team here during
  // a sweep; falls back to the handoff webhook. Optional: without either, breaches
  // still surface in the dashboard inbox, they just do not push a notification.
  const alertHook = process.env.CASEY_ALERT_WEBHOOK || process.env.CASEY_HANDOFF_WEBHOOK
  console.log(alertHook
    ? ok(`breach alerts on${process.env.CASEY_ALERT_WEBHOOK ? ' CASEY_ALERT_WEBHOOK' : ' CASEY_HANDOFF_WEBHOOK (fallback)'}`)
    : dim('  CASEY_ALERT_WEBHOOK unset - sweep breaches surface in the inbox but do not push an alert (optional)'))
  // data dir -- where the live case store lives (cwd-bound). The actual
  // filename is db.sqlite, not app.db: thatcher's own databasePath option
  // only ever contributes its DIRECTORY to busybase (databasePathToDir()
  // in thatcher's index.js strips the filename component entirely), and
  // busybase's own embedded.js hardcodes `${dir}/db.sqlite` as the real
  // file it opens -- confirmed by inspecting the live process's open file
  // descriptors, not by reading a doc. app.db is never created; checking
  // for it here always reported "no case data yet" even with real data on
  // disk.
  const dataDir = path.join(process.cwd(), 'data')
  const dbFile = path.join(dataDir, 'db.sqlite')
  console.log(existsSync(dbFile)
    ? ok(`case data at ${dbFile}`)
    : dim(`  no case data yet (will be created at ${dbFile})`))
  // Provenance raw log -- RawLog._load() skips a truncated JSONL line (a partial
  // write from a crash mid-append) rather than trusting half an observation as a
  // real record, and counts what it skipped. This is the only caller of that
  // count, so without this row the skipping happens correctly and no human ever
  // learns a record was lost. Read-only: constructing RawLog creates the
  // directory but writes no entry.
  // Has the health-guardrail sweep ever actually run? It is the mechanism that
  // detects stalled, stuck and abandoned cases, and in dashboard-only mode it
  // is never scheduled at all (casey.js starts the timer during casey's own
  // boot, which cmdDashboard does not perform). A store full of open cases and
  // zero health:* tags therefore looks identical to a store with nothing wrong,
  // and an operator reading a queue with no flags concludes the second. Read
  // the sqlite file directly rather than booting a CaseStore: doctor is a
  // preflight and must not create or migrate anything to answer a question.
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
      const corrupt = new RawLog({ dataDir }).corruptLineCount()
      if (corrupt > 0) { console.log(bad(`provenance raw log has ${corrupt} unreadable line(s) - a crash mid-append truncated ${corrupt} observation(s); they are skipped, not recoverable`)); problems++ }
      else console.log(ok('provenance raw log reads clean'))
    } catch (e) {
      console.log(warn(`provenance raw log could not be read (${e.message})`))
    }
  }
  // port
  const port = Number(flags.port || 4000)
  // Every other bad() row in this command counts itself into `problems`; this
  // one did not, so a busy port printed the red [x] marker and doctor still
  // finished with "all good - run casey up" and exit 0 -- telling an operator
  // to start a dashboard that cannot bind, in the one command whose whole job
  // is to catch that before they try.
  if (await portFree(port)) console.log(ok(`port ${port} is free`))
  else { console.log(bad(`port ${port} is in use - start with --port <other>`)); problems++ }
  // With no channel configured `casey up` genuinely cannot start -- the row
  // above says so in as many words -- so recommending it as the next step
  // contradicted the report the operator had just read. `casey dashboard`
  // is what actually runs in that state, so that is what gets suggested.
  const nextStep = noChannel ? 'casey dashboard' : 'casey up'
  console.log(problems
    ? red(`\n${problems} problem(s) to fix before ${cyan(nextStep)}`)
    : green(`\nall good - run ${nextStep}`))
  process.exit(problems ? 1 : 0)
}
