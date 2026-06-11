// casey.js  --  top-level assembly. Boots the case store, registers casey's
// freddie plugin (case-tools), wires a freddie Gateway with the chosen channel
// adapters + casey's case hooks, and exposes start/stop.
//
// Channels:
//   whatsapp  --  freddie's Meta Graph webhook adapter (real)
//   discord  --  freddie's adapter + our WS receive (real simulation)
//   sim  --  MockAdapter (offline, no credentials)

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const pathToFileUrl = (p) => pathToFileURL(p).href
import { Gateway, bootHost } from 'freddie'
import { createCaseStore } from './case-store.js'
import { setCaseStore } from './case-runtime.js'
import { makeCaseHandler, makeTransitionNotifier, discordHandoffNotifier } from './gateway-hooks.js'
import { sweepCases } from './case-sweep.js'
import { MockAdapter } from './sim/inject.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CASEY_PLUGINS = path.resolve(__dirname, '..', 'plugins')
// freddie's package "exports" map blocks subpath imports, so we reach its
// platform adapter classes by absolute path under node_modules.
const FREDDIE_ROOT = path.resolve(__dirname, '..', 'node_modules', 'freddie')
const freddieFile = (rel) => pathToFileUrl(path.join(FREDDIE_ROOT, rel))

export class Casey {
  constructor(opts = {}) {
    this.opts = opts
    this.channels = opts.channels || ['sim']
    this.store = null
    this.gateway = null
    this.adapters = {}
    this._inflight = new Set()      // track inbound turns for deterministic sim
    this._disconnects = []
    this._sweepTimer = null         // periodic health-guardrail interval handle
  }

  async init() {
    this.log = this.opts.log || makeLogger()
    // 1) case store (thatcher) up first so plugin handlers have it.
    this.store = createCaseStore({ config: this.opts.config, log: this.log })
    await this.store.init()
    setCaseStore(this.store)

    // 2) boot freddie host with casey's plugin root so case_* tools register.
    //    bootHost is memoised; doing it here means freddie's later internal
    //    bootHost() calls reuse this fully-loaded host.
    await bootHost([CASEY_PLUGINS])

    // 3) build adapters for the requested channels.
    const platforms = {}
    for (const ch of this.channels) platforms[ch] = await this._makeAdapter(ch)
    this.adapters = platforms

    // 4) gateway. casey REPLACES handleInbound with its case-aware handler
    //    (see gateway-hooks.js) rather than layering hooks around freddie's
    //    context-free turn. We then wrap it to track in-flight turns so the sim
    //    can await them (freddie fires inbound handling without awaiting).
    // casey replaces gateway.handleInbound entirely, so the gateway never uses a
    // callLLM of its own -- the case handler owns the LLM decision (P4: one layer,
    // one capability). Passing it to the gateway too was dead coupling.
    this.gateway = new Gateway({ platforms })
    const handler = makeCaseHandler(this.store, {
      callLLM: this.opts.callLLM || null,
      autoRespond: this.opts.autoRespond !== false,
      log: this.log,
      notifyHandoff: this.opts.notifyHandoff || discordHandoffNotifier(undefined, this.log),
    })
    this.gateway.handleInbound = handler.bind(this.gateway)
    this._wrapInflight()

    // 5) proactive contact notes on OPERATOR stage changes. sendReply resolves
    //    the channel adapter and sends -- the same path the dashboard uses for
    //    operator replies. Null-safe: agent transitions and opted-out contacts
    //    are skipped inside the notifier.
    this.store.onTransition = makeTransitionNotifier(this.store, this.sendReply.bind(this), { log: this.log })
    return this
  }

  async _makeAdapter(ch) {
    if (ch === 'sim') return new MockAdapter('sim')
    // whatsapp / discord come from freddie's platform plugins, registered on the
    // host's pi.platforms registry. We instantiate their adapter classes directly
    // for gateway use.
    if (ch === 'discord') {
      const { DiscordAdapter } = await import(freddieFile('plugins/platform-discord/handler.js'))
      const a = new DiscordAdapter()
      // freddie's DiscordAdapter now opens the gateway WebSocket itself (it
      // emits a 'message' event after IDENTIFY/RESUME). Older freddie builds
      // only did the gateway lookup, so if the adapter has no native receive we
      // attach casey's connectDiscordReceive as a fallback.
      const hasNativeReceive = typeof a._connect === 'function' || a.receive !== undefined
      if (!hasNativeReceive) {
        const { connectDiscordReceive } = await import('./discord-receive.js')
        const orig = a.start.bind(a)
        a.start = async () => { await orig(); this._disconnects.push(connectDiscordReceive(a)) }
      }
      return a
    }
    if (ch === 'whatsapp') {
      const { WhatsappAdapter } = await import(freddieFile('plugins/platform-whatsapp/handler.js'))
      return new WhatsappAdapter({ port: this.opts.whatsappPort || 0 })
    }
    throw new Error(`unknown channel "${ch}"`)
  }

  // Wrap gateway.handleInbound so every invocation is tracked + awaitable.
  _wrapInflight() {
    const orig = this.gateway.handleInbound.bind(this.gateway)
    this.gateway.handleInbound = (platform, msg) => {
      const p = orig(platform, msg).finally(() => this._inflight.delete(p))
      this._inflight.add(p)
      return p
    }
  }

  // Send a message to a case's contact on their channel. Shared by the proactive
  // transition notifier and available to the dashboard wiring. No-op (resolves)
  // when the channel adapter is absent, so logging-only setups never throw.
  async sendReply(caseRow, text) {
    const a = this.adapters[caseRow.channel]
    if (a?.send) await a.send({ to: caseRow.external_id, text })
  }

  // Await all in-flight inbound turns (used by sim for determinism).
  async drain() { await Promise.all([...this._inflight]) }

  // Run one health-guardrail sweep now. Exposed for tests and manual runs; the
  // scheduler calls the same path. Isolated: a sweep error is the caller's to log.
  async runSweepOnce(now = Date.now()) {
    return sweepCases(this.store, now, this.opts.healthThresholds, { log: this.log })
  }

  // Start (or restart) the periodic guardrail sweep. Opt-in: a non-positive
  // interval disables it. The handle is stored so stop() can clear it -- a leaked
  // interval is itself an over-time failure, so cleanup is structural, not hoped-for.
  startSweep(intervalMs = this.opts.sweepIntervalMs ?? 15 * 60e3) {
    this.stopSweep()
    if (!(intervalMs > 0)) return
    this._sweepTimer = setInterval(() => {
      // A sweep failure must never crash the loop or wedge the process.
      this.runSweepOnce().catch(e => this.log?.warn?.('[casey] sweep failed', { error: e.message }))
    }, intervalMs)
    // Do not keep the event loop alive solely for the sweep (clean test/CLI exit).
    this._sweepTimer.unref?.()
  }

  stopSweep() {
    if (this._sweepTimer) { clearInterval(this._sweepTimer); this._sweepTimer = null }
  }

  async start() {
    await this.gateway.start()
    // Default-on guardrails: enabled unless explicitly disabled (sweepIntervalMs<=0).
    if (this.opts.sweepIntervalMs !== 0) this.startSweep()
  }

  // Graceful shutdown: stop accepting input, let in-flight agent turns finish,
  // close channel receivers, then close the store so the DB flushes cleanly
  // (avoids the WAL/libuv teardown race seen on abrupt exit).
  async stop() {
    this.stopSweep()
    for (const d of this._disconnects) { try { d() } catch { /* ignore */ } }
    await this.gateway?.stop()
    try { await this.drain() } catch { /* in-flight turn errored; already logged */ }
    await this.store?.close()
  }
}

export async function createCasey(opts) {
  const c = new Casey(opts)
  await c.init()
  return c
}

// Minimal structured logger: one JSON line per event with a level + message +
// context. Quiet when CASEY_LOG=silent.
export function makeLogger(component = 'casey') {
  const silent = process.env.CASEY_LOG === 'silent'
  const emit = (level, msg, ctx) => {
    if (silent) return
    const line = JSON.stringify({ t: new Date().toISOString(), level, component, msg, ...(ctx || {}) })
    if (level === 'error') console.error(line)
    else console.log(line)
  }
  return {
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
  }
}
