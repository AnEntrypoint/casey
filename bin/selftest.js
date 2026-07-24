#!/usr/bin/env node
// casey selftest -- drives real turns through casey's actual conversation
// handler (the SAME code path a real Discord/WhatsApp inbound hits) via a
// synthetic in-process adapter, with a real LLM backend, entirely without
// Discord/WhatsApp. Exists so a real reply (or a real degraded/failed turn)
// can be observed and iterated on directly, instead of trusting aggregate
// health signals (process alive, /api/health, gateway READY) that -- by
// design -- do not individually witness whether any specific turn actually
// produced a reply. Always runs against an ISOLATED data directory (never the
// live data/app.db) and never touches a real channel.
//
// Usage:
//   node bin/selftest.js "hi there"
//   node bin/selftest.js --scenario stop
//   node bin/selftest.js --contact worker1 --tier field_worker "whats on today"
//   node bin/selftest.js --scenarios          (run every built-in scenario)
//   node bin/selftest.js --measure "hi there" (report request size, no LLM call)
import { createCasey } from '../src/casey.js'
import { createCaseStore } from '../src/case-store.js'
import { reporterTierExcludedToolNames } from '../src/case-tools.js'
import { caseSystemPrompt } from '../src/hooks/prompt.js'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// .env loading lives in bin/selftest-bootstrap.mjs, NOT here -- run this
// file via that bootstrap (`node bin/selftest-bootstrap.mjs ...`), never
// directly. A process.loadEnvFile() call placed in THIS file's own top-level
// body still runs too late: ES module `import` statements above (createCasey
// etc.) are hoisted and evaluate before any of this file's own top-level
// code, so by the time a loadEnvFile() call here would run, hooks/handler.js
// has already captured its own module-level constants (e.g.
// TURN_HARD_DEADLINE_MS) from a process.env that hadn't been loaded yet --
// live-witnessed directly this session: a selftest run kept measuring
// against the stale 60000ms default no matter what CASEY_TURN_HARD_DEADLINE_MS
// was set to in .env. The bootstrap file has no static imports of its own,
// loads .env, then dynamically imports this file -- only a dynamic import()
// begins evaluating its target after the loading line actually runs.

function parseFlags(argv) {
  const f = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) { f[key] = next; i++ }
      else f[key] = true
    } else positional.push(a)
  }
  return { f, positional }
}

// Built-in scenarios mirror the ones this session already live-verified by
// hand, repeatedly, via one-off scratch scripts -- collecting them here so
// they are a standing, reusable pathway instead of re-typed every session.
const SCENARIOS = {
  greeting: { text: 'hi there', tier: 'reporter' },
  report: { text: 'my cattle are sick near Bela-Bela, three showing blisters', tier: 'reporter' },
  stop: { text: 'stop messaging me', tier: 'reporter' },
  help: { text: 'HELP', tier: 'reporter', pre: 'stop' },
  human: { text: 'I want to talk to a real person', tier: 'reporter' },
  offtopic: { text: 'what is 2+2', tier: 'reporter' },
  enquiry: { text: "what's on today", tier: 'field_worker' },
  nonenglish: { text: 'sawubona, izinkomo zami ziyagula eGoli', tier: 'reporter' },
}

async function makeIsolatedCasey({ log = console } = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'casey-selftest-'))
  const cfgSrc = readFileSync(path.join(ROOT, 'thatcher.config.yml'), 'utf8')
  writeFileSync(path.join(tmp, 'thatcher.config.yml'), cfgSrc)
  const prevCwd = process.cwd()
  process.chdir(tmp)
  const casey = await createCasey({
    channels: [],           // no real adapter -- avoids any Discord/WhatsApp connect attempt
    config: './thatcher.config.yml',
    sweepIntervalMs: 0,     // no background health sweep during a one-shot test run
    drainPollIntervalMs: 0, // no background queue-drain poll either
    log,
  })
  return { casey, tmp, prevCwd }
}

// Synthetic adapter: a real EventEmitter matching freddie's Gateway.register
// contract (adapter.on('message', ...), adapter.send(reply)) -- casey.js's
// gateway is a genuine freddie Gateway instance and cannot tell this apart
// from a real Discord/WhatsApp adapter at the handleInbound layer, which is
// the whole point: the turn that runs is byte-identical to what a live
// message would drive.
function makeSyntheticAdapter() {
  const emitter = new EventEmitter()
  const sent = []
  emitter.send = async (reply) => { sent.push(reply); return { ok: true } }
  emitter.sent = sent
  return emitter
}

async function runOneTurn(casey, { platform = 'testplatform', contact = 'selftest-worker', tier = 'reporter', text }) {
  const adapter = makeSyntheticAdapter()
  casey.gateway.platforms.set(platform, adapter)
  if (tier === 'field_worker') {
    // Elevate the contact's tier BEFORE the turn so toolCtx.tier resolves
    // field_worker on this exact turn, matching how an operator promotes a
    // contact via the dashboard/CLI in production (never self-service, never
    // LLM-settable -- same fail-closed discipline this harness must respect
    // rather than bypass).
    const c = await casey.store.findOrCreateContact({ channel: platform, external_id: contact })
    await casey.store.t.update('contact', c.id, { tier: 'field_worker' }, { id: 'selftest', role: 'system' })
  }
  // A real msg.raw.id matters beyond silencing the missing-id warning: it is
  // the dedup key (messageId() in handler.js) -- without a unique one here,
  // every selftest turn for the same contact would collide on dedup the same
  // way a real duplicate-webhook-delivery would, masking whether a SECOND
  // real turn actually ran.
  const msg = { from: contact, text, platform, raw: { channel_id: contact, id: `selftest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` } }
  const started = Date.now()
  // casey.js's own _wrapInflight tracks this on gateway.handleInbound, NOT a
  // bare casey.handleInbound (there is no such method) -- the exact
  // reference mistake round 5 of this session's own maximize-quality audit
  // found and fixed in casey's burst-message-replay path (commit d067829),
  // worth getting right here too since this harness exists specifically to
  // drive the SAME tracked path a real inbound uses.
  await casey.gateway.handleInbound(platform, msg)
  const elapsedMs = Date.now() - started
  let events = null
  if (process.env.CASEY_SELFTEST_DEBUG) {
    // Real diagnosis instead of guessing: when a turn produces no reply, the
    // case's own event timeline (observation/action rows) almost always
    // names exactly why -- an outbound scrub (JARGON-HELD, prompt-echo,
    // stock-ack, isMetaCommentary), an autonomy=observe gate, or a genuine
    // degraded-turn marker (data.degraded_turn, see AGENTS.md's reply-path
    // observability principle). Reading it here beats re-guessing blind.
    try {
      const { case: c } = await casey.store.findOrCreateCase({ channel: platform, external_id: contact })
      events = await casey.store.listEvents(c.id)
    } catch { /* best-effort diagnostic only */ }
  }
  return { adapter, elapsedMs, sent: adapter.sent, events }
}

async function measureRequestSize({ tier = 'reporter' } = {}) {
  // No LLM call at all -- pure structural measurement of what WOULD be sent,
  // reusing the exact same prompt-construction and tool-schema-filtering code
  // the real turn uses, so this measurement can never silently drift from
  // what a real turn actually ships.
  const store = createCaseStore()
  await store.init()
  const { case: c } = await store.findOrCreateCase({ channel: 'measure', external_id: 'measure-worker' })
  const events = await store.listEvents(c.id)
  const prompt = caseSystemPrompt(c, events, null, { orient: null })
  const { bootHost, getEnabledToolSchemas } = await import('freddie')
  await bootHost([path.join(ROOT, 'plugins')])
  const excluded = tier === 'field_worker' ? [] : reporterTierExcludedToolNames()
  const schemas = await getEnabledToolSchemas(['cases'], excluded)
  const schemaJson = JSON.stringify(schemas)
  await store.close()
  return {
    tier,
    promptChars: prompt.length, promptTokensEst: Math.round(prompt.length / 4),
    toolCount: schemas.length, toolSchemaChars: schemaJson.length, toolSchemaTokensEst: Math.round(schemaJson.length / 4),
    totalTokensEst: Math.round(prompt.length / 4) + Math.round(schemaJson.length / 4),
  }
}

async function main() {
  const { f, positional } = parseFlags(process.argv.slice(2))
  if (f.help) {
    console.log(`casey selftest -- drive real turns through the real conversation handler, no Discord.

  node bin/selftest.js "<message text>"           run one turn with default reporter tier
  node bin/selftest.js --tier field_worker "..."   run one turn as a field_worker
  node bin/selftest.js --contact <id> "..."        pin the synthetic contact identity
  node bin/selftest.js --scenario <name>           run one named built-in scenario
  node bin/selftest.js --scenarios                 run every built-in scenario in sequence
  node bin/selftest.js --measure [--tier ...]       report request size only, no LLM call
  node bin/selftest.js --list                       list built-in scenario names

Built-in scenarios: ${Object.keys(SCENARIOS).join(', ')}
Always runs against an isolated temp data dir; never touches the live data/app.db or a real channel.`)
    return
  }
  if (f.list) { console.log(Object.keys(SCENARIOS).join('\n')); return }

  if (f.measure) {
    const tier = f.tier === 'field_worker' ? 'field_worker' : 'reporter'
    const m = await measureRequestSize({ tier })
    console.log(JSON.stringify(m, null, 2))
    return
  }

  const { casey, tmp, prevCwd } = await makeIsolatedCasey()
  try {
    const runScenario = async (name) => {
      const sc = SCENARIOS[name]
      if (!sc) { console.log(`unknown scenario: ${name}`); return }
      console.log(`\n=== scenario: ${name} ===`)
      const contact = `selftest-${name}`
      if (sc.pre) {
        console.log(`  (pre-step: sending "${SCENARIOS[sc.pre].text}" first)`)
        await runOneTurn(casey, { contact, tier: sc.tier, text: SCENARIOS[sc.pre].text })
      }
      const r = await runOneTurn(casey, { contact, tier: sc.tier, text: sc.text })
      console.log(`  sent: "${sc.text}"`)
      console.log(`  elapsed: ${r.elapsedMs}ms`)
      if (r.sent.length) {
        for (const s of r.sent) console.log(`  REPLY: ${JSON.stringify(s.text)}${s.degraded ? '  [DEGRADED]' : ''}`)
      } else {
        console.log('  REPLY: (none sent -- check for a queued/degraded/observe-mode turn)')
        if (r.events) {
          console.log('  --- CASEY_SELFTEST_DEBUG event timeline ---')
          for (const e of r.events) console.log(`    [${e.kind}/${e.actor}] ${e.text}`)
        }
      }
      return r
    }

    if (f.scenarios) {
      const results = {}
      for (const name of Object.keys(SCENARIOS)) results[name] = await runScenario(name)
      const failed = Object.entries(results).filter(([, r]) => !r.sent.length || r.sent.some(s => s.degraded))
      console.log(`\n=== summary: ${Object.keys(results).length - failed.length}/${Object.keys(results).length} scenarios got a real reply ===`)
      if (failed.length) console.log('degraded/no-reply scenarios:', failed.map(([n]) => n).join(', '))
    } else if (f.scenario) {
      await runScenario(f.scenario)
    } else {
      const text = positional.join(' ') || 'hi there'
      const tier = f.tier === 'field_worker' ? 'field_worker' : 'reporter'
      const contact = f.contact || 'selftest-worker'
      const r = await runOneTurn(casey, { contact, tier, text })
      console.log(`sent: "${text}"  (tier=${tier})`)
      console.log(`elapsed: ${r.elapsedMs}ms`)
      if (r.sent.length) {
        for (const s of r.sent) console.log(`REPLY: ${JSON.stringify(s.text)}${s.degraded ? '  [DEGRADED]' : ''}`)
      } else {
        console.log('REPLY: (none sent)')
      }
    }
  } finally {
    await casey.stop()
    process.chdir(prevCwd)
    // better-sqlite3's OS-level file handle can stay briefly held past the
    // JS-visible store.close() resolving (witnessed live on Windows: an
    // immediate rmSync threw EPERM). A short bounded retry rather than an
    // unbounded one -- if the handle is still held after this, something
    // else is wrong and leaving the temp dir behind (harmless, OS temp) beats
    // a silent infinite retry loop.
    for (let attempt = 0; attempt < 5; attempt++) {
      try { rmSync(tmp, { recursive: true, force: true }); break }
      catch (e) {
        if (attempt === 4) { console.error(`[selftest] could not clean up ${tmp}: ${e.message} (left behind, harmless)`); break }
        await new Promise(r => setTimeout(r, 200))
      }
    }
  }
  // acptoapi's own extra-providers.js starts a real periodic re-probe timer
  // (lib/extra-providers.js start(), via a module-level singleton
  // ensureExtraProvidersStarted in acptoapi's index.js) the first time a
  // chain call actually runs -- casey.stop()'s own shutdown chain never
  // touches it (a real, separate gap from this harness's own scope; casey's
  // own long-running `casey up` process never needed to worry about this
  // because it never exits on its own). Without an explicit process.exit()
  // here, that timer keeps the event loop alive indefinitely and this
  // script would hang forever after a successful run instead of returning
  // control to whoever invoked it.
  process.exit(0)
}

// Exported so other scripts (bin/adversarial-epoch.mjs) can drive real,
// multi-turn conversations against the SAME real handler path this file's
// own single-turn/scenario modes use, without duplicating the isolated-
// data-dir/synthetic-adapter setup a second time.
//
// selftest.js is ALWAYS loaded via bin/selftest-bootstrap.mjs's dynamic
// import() (never run directly -- see that file's own header for why: an
// .env-loading-order bug), so process.argv[1] is the bootstrap's own path,
// never this file's -- an import.meta.url-vs-argv[1] direct-execution check
// (the usual ESM equivalent of CJS's `require.main === module`) would
// therefore ALWAYS read false here regardless of caller intent, silently
// skipping main() even for a genuine CLI invocation through the bootstrap.
// Exporting runCli() explicitly and having each caller decide whether to
// invoke it (the bootstrap always does; bin/adversarial-epoch.mjs never
// does, it drives runOneTurn/makeIsolatedCasey directly instead) is the
// correct, unambiguous alternative to a heuristic that cannot work through
// an intentional bootstrap indirection layer.
export { makeIsolatedCasey, runOneTurn, SCENARIOS, runCli }

async function runCli() {
  await main()
}
