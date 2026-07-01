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
import { setCaseStore, resetCaseStore } from './case-runtime.js'
import { makeCaseHandler, makeTransitionNotifier, discordHandoffNotifier, breachNotifier } from './gateway-hooks.js'
import { sweepCases } from './case-sweep.js'
import { ALL_HEALTH_TAGS } from './case-health.js'
import { MockAdapter } from './sim/inject.js'

const CASE_HEALTH_SET = new Set(ALL_HEALTH_TAGS)

// Roster size from CASEY_OPERATORS (comma-separated id:Name or a JSON array). We
// only need the count of people EXPECTED to cover for the coverage-gap check, so a
// tolerant count is enough: a malformed roster counts as no roster (never a crash).
function rosterFromEnv(raw = process.env.CASEY_OPERATORS) {
  const s = String(raw || '').trim()
  if (!s) return []
  if (s.startsWith('[')) {
    try { const a = JSON.parse(s); return Array.isArray(a) ? a.filter(Boolean) : [] } catch { return [] }
  }
  return s.split(',').map(t => t.trim()).filter(Boolean)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CASEY_PLUGINS = path.resolve(__dirname, '..', 'plugins')
// freddie's package "exports" map blocks subpath imports, so we reach its
// platform adapter classes by absolute path under node_modules.
const FREDDIE_ROOT = path.resolve(__dirname, '..', 'node_modules', 'freddie')
const freddieFile = (rel) => pathToFileUrl(path.join(FREDDIE_ROOT, rel))

// Guardrail breaches severe enough to alert the team during a sweep. The rest
// (stale/stuck/timestamp_corrupt) still tag the case for the inbox but do not page.
const SWEEP_ALERT_BREACHES = new Set(['unanswered_handoff', 'unanswered_handoff_escalated', 'incomplete_critical', 'abandoned_intake', 'never_closed'])
// The escalated handoff tier routes to a DISTINCT supervisor channel when one is
// configured (CASEY_ESCALATE_WEBHOOK); otherwise it falls back to the same alert
// channel as every other breach.
const ESCALATION_BREACHES = new Set(['unanswered_handoff_escalated'])

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
    this._roster = rosterFromEnv()  // people expected to cover (for the coverage-gap check)
    this._coverageGapActive = false // rising-edge dedup so a persistent gap pages once
    // Per-channel receive liveness. A gateway WebSocket can go zombie (TCP still
    // ESTABLISHED, gateway-dead) and silently stop delivering inbound while the
    // process, the HTTP server, and outbound send all stay healthy -- the exact
    // "casey looks online but answers nobody" failure. We stamp the last time we
    // saw a connect (READY) and the last inbound on each real-time channel so the
    // health surface can flag a deaf receive instead of reporting a false green.
    this.receiveHealth = {}         // { [channel]: { connectedAt, lastInboundAt } }
  }

  _markConnected(channel) {
    const r = (this.receiveHealth[channel] ||= {})
    r.connectedAt = Date.now()
  }

  _markInbound(channel) {
    const r = (this.receiveHealth[channel] ||= {})
    r.lastInboundAt = Date.now()
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
      // Live backend health so the handler can QUEUE an inbound (instead of a
      // deterministic fallback) when the LLM provider is down; the down->up edge
      // drains the queue (drainQueuedTurns). Absent -> the handler treats the
      // backend as available and lets runTurn's own throw drive the safe fallback.
      llmStatus: this.opts.llmStatus || null,
      autoRespond: this.opts.autoRespond !== false,
      log: this.log,
      notifyHandoff: this.opts.notifyHandoff || discordHandoffNotifier(undefined, this.log),
    })
    // High-severity guardrail breaches alert the team over the same webhook
    // transport as a handoff (CASEY_ALERT_WEBHOOK, falling back to the handoff
    // webhook). Null when neither is set: the sweep still flags every case via
    // health:* tags, so the dashboard inbox surfaces them regardless.
    this._notifyBreach = this.opts.notifyBreach || breachNotifier(undefined, this.log)
    // Distinct supervisor channel for the escalated handoff tier. Falls back to the
    // ordinary breach notifier when CASEY_ESCALATE_WEBHOOK is unset, so escalation
    // is never silently dropped -- it just shares the alert channel.
    this._notifyEscalation = this.opts.notifyEscalation
      || breachNotifier(process.env.CASEY_ESCALATE_WEBHOOK, this.log)
      || this._notifyBreach
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
        a.start = async () => {
          // A failed Discord start (bad token, gateway unreachable) must surface,
          // not leave the channel half-initialised with no receive and no log.
          try { await orig() }
          catch (e) { this.log?.error?.('[casey] discord adapter.start failed', { error: e.message }); throw e }
          this._disconnects.push(connectDiscordReceive(a))
        }
      }
      // Filter guild channel messages to only DMs (guild_id absent) or @mentions of
      // the bot. Without this, every message in any guild channel creates a case --
      // surveillance intake should only trigger when someone deliberately contacts
      // the bot, not from general server conversation.
      let botUserId = null
      const origEmit = a.emit.bind(a)
      a.emit = (event, msg, ...rest) => {
        if (event === 'message') {
          const raw = msg?.raw || {}
          // DM: no guild_id. Guild: only if bot is @mentioned.
          const isDM = !raw.guild_id
          const mentions = Array.isArray(raw.mentions) ? raw.mentions : []
          const botMentioned = botUserId ? mentions.some(u => u.id === botUserId) : mentions.length > 0
          if (!isDM && !botMentioned) return false
          // We received a real, addressed-to-us inbound: receive is alive. Stamp
          // BEFORE delegating so a throw downstream still records that we heard.
          this._markInbound('discord')
        }
        return origEmit(event, msg, ...rest)
      }
      // Capture bot user ID from READY event so mention filter is precise, and
      // stamp the connect so a long silence after a healthy READY is observable
      // as a possibly-zombie socket rather than a false green.
      const origDispatch = a._dispatch?.bind(a)
      if (origDispatch) {
        a._dispatch = (p) => {
          if (p.t === 'READY') { if (p.d?.user?.id) botUserId = p.d.user.id; this._markConnected('discord') }
          if (p.t === 'RESUMED') this._markConnected('discord')
          return origDispatch(p)
        }
      }
      // Verify outbound delivery. freddie's adapter.send does fetch(...).then(
      // r => r.json()) with NO status check, so a non-2xx (wrong channel, missing
      // perms, rate-limit, revoked token) is swallowed and casey would still log a
      // clean outbound -- a reply that never arrived. Wrap send to inspect the
      // Discord response: a successful message has an `id`; an error body carries a
      // numeric `code` and `message` and no `id`. Throw on a detected failure so the
      // caller records it as an observation rather than a false-positive outbound.
      const origSend = a.send.bind(a)
      a.send = async (reply) => {
        const resp = await origSend(reply)
        if (resp && typeof resp === 'object' && !resp.id && (resp.code != null || resp.message)) {
          throw new Error(`discord send rejected (code ${resp.code ?? '?'}): ${String(resp.message || '').slice(0, 200)}`)
        }
        return resp
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

  // Receive-liveness snapshot for the real-time channels (currently discord),
  // so the health surface can distinguish "online" from "deaf". `sim`/`web` are
  // request-driven and have no socket to go zombie, so they are omitted. A channel
  // is `ok` once it has connected; `quiet` is informational only (a real channel
  // can legitimately receive nothing for long stretches), so quietness alone never
  // flips the pill -- only "configured but never connected since start" does, which
  // is the actionable signal an operator can act on (a wedged/zombie initial
  // connect). `now` is injectable for tests.
  receiveStatus(now = Date.now()) {
    const channels = {}
    let worst = 'ok'
    for (const ch of this.channels) {
      if (ch === 'sim' || ch === 'web') continue   // no real-time receive socket
      const r = this.receiveHealth[ch] || {}
      const connected = r.connectedAt != null
      const sinceInboundMs = r.lastInboundAt != null ? now - r.lastInboundAt : null
      const sinceConnectMs = r.connectedAt != null ? now - r.connectedAt : null
      const state = connected ? 'ok' : 'never-connected'
      if (state === 'never-connected') worst = 'never-connected'
      channels[ch] = { state, connected, sinceConnectMs, sinceInboundMs }
    }
    return { state: Object.keys(channels).length ? worst : 'none', channels }
  }

  // Await all in-flight inbound turns (used by sim for determinism).
  async drain() { await Promise.all([...this._inflight]) }

  // Run one health-guardrail sweep now. Exposed for tests and manual runs; the
  // scheduler calls the same path. Isolated: a sweep error is the caller's to log.
  async runSweepOnce(now = Date.now()) {
    // Only the breaches a person must act on raise an alert; stale/stuck are
    // surfaced in the inbox but do not page the team. The sweep passes
    // (caseId, breach, detail); we look the case up so the alert carries its ref.
    const notifyBreach = this._notifyBreach
      ? async (caseId, breach, detail) => {
          if (!SWEEP_ALERT_BREACHES.has(breach)) return
          const c = await this.store.getCase(caseId).catch(() => null)
          if (!c) return
          // The escalated tier goes to the supervisor channel; everything else to
          // the ordinary breach channel.
          const notify = ESCALATION_BREACHES.has(breach) ? this._notifyEscalation : this._notifyBreach
          if (notify) await notify(c, breach, detail)
        }
      : null
    // Read the live thresholds (persisted operator patch over the boot override
    // over defaults) at call time, so a /api/thresholds change takes effect on the
    // very next sweep without a restart.
    const thresholds = await this.store.resolveThresholds(this.opts.healthThresholds)
    const summary = await sweepCases(this.store, now, thresholds, { log: this.log, notifyBreach })
    // Persist the rich summary as a rolling audited observation so the dashboard
    // can show a trend over time and a degraded-sweep banner -- otherwise the
    // breaches/errors detail is logged once and lost. A persistence failure must
    // not fail the sweep itself, so it is best-effort and recorded as a warning.
    try { this._lastSweepSummary = await this.store.recordSweepSummary(summary, now) }
    catch (e) { this.log?.warn?.('[casey] fleet-health persist failed', { error: e.message }) }
    // Team-level coverage gap: distinct from a per-case breach. If the whole roster
    // is idle while breaches pile up, page the team-lead once on the rising edge and
    // clear on the falling edge (the same "once per newly-entered breach" discipline
    // as the per-case path, so a persistent gap is not re-spammed every 15 minutes).
    // Best-effort: a coverage-check failure must never fail the sweep itself.
    try { await this._checkCoverageGap(now) }
    catch (e) { this.log?.warn?.('[casey] coverage-gap check failed', { error: e.message }) }
    return summary
  }

  // Compute the team coverage gap and page once on the rising edge. The roster is
  // the configured CASEY_OPERATORS (people expected to cover); with no roster there
  // is no one to page about a gap, so the check no-ops. The event load is bounded to
  // open cases and only runs when at least one breaching case exists (no breaches ->
  // no gap regardless of replies), so a healthy quiet hour costs one cheap case scan.
  async _checkCoverageGap(now = Date.now()) {
    if (!this._notifyBreach) return                 // no alert channel configured
    const roster = this._roster || []
    if (!roster.length) return                      // no one expected to cover
    const open = (await this.store.listCases({}, { limit: 10000 }))
      .filter(c => c.status !== 'closed' && c.status !== 'resolved')
    const breaching = open.filter(c => String(c.tags || '').split(',').map(s => s.trim()).some(t => CASE_HEALTH_SET.has(t)))
    if (!breaching.length) {                        // no breaches -> gap is impossible
      this._coverageGapActive = false
      return
    }
    const eventsByCaseId = new Map()
    for (const c of open) eventsByCaseId.set(c.id, await this.store.listEvents(c.id).catch(() => []))
    const { detectCoverageGap } = await import('./case-sweep.js')
    const verdict = detectCoverageGap(open, eventsByCaseId, roster, now)
    if (verdict.gap && !this._coverageGapActive) {
      // Rising edge: page once. Reuse the breach webhook transport; the synthetic
      // case carries a stable ref so the alert reads as a team-coverage page, not a
      // per-case one. No external_id -- aggregate-only.
      this._coverageGapActive = true
      try { await this._notifyBreach({ ref: 'TEAM-COVERAGE' }, 'coverage_gap', verdict.reason) }
      catch (e) { this.log?.warn?.('[casey] coverage-gap page failed', { error: e.message }) }
      this.log?.warn?.('[casey] coverage gap', { open_breaches: verdict.open_breaches, roster_size: verdict.roster_size })
    } else if (!verdict.gap) {
      this._coverageGapActive = false               // falling edge: armed to page again
    }
    return verdict
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
    // One-time backfill: tag channel-created cases that predate intake_mode tagging.
    this._backfillIntakeMode().catch(e => this.log?.warn?.('[casey] intake_mode backfill failed', { error: e.message }))
    // One-shot boot recovery: re-drive turns that started but never replied (the
    // process crashed/reloaded mid-turn). Bounded; never blocks start; never
    // double-sends (each re-drive is marked BEFORE it runs).
    this.resumePendingTurns().catch(e => this.log?.warn?.('[casey] resume sweep failed', { error: e.message }))
  }

  // Boot-time recovery for the "contact messaged, casey crashed before replying"
  // failure. Scan a bounded window of recent open cases; for each, find an inbound
  // whose agent turn STARTED (a `TURN-START:<msgId>` observation -- written by the
  // handler before the LLM call) but never COMPLETED (no later outbound and no
  // later draft), and re-drive the handler for it exactly once.
  //
  // At-most-once is structural: a durable `resume-attempted:<msgId>` observation is
  // appended BEFORE the re-drive. If the re-drive itself crashes, the next boot sees
  // the marker and skips -- a possible MISS is preferred over a contact-facing
  // double-send (design principle: never nag). A turn whose outbound send merely
  // failed is NOT re-driven: it has a following outbound (the send-failure path
  // still records the outbound event), so it reads as completed here.
  //
  // The reconstructed msg must round-trip through the handler's own derivations:
  // conversationKey(msg) === case.external_id (so it finds the SAME case, not a new
  // one) and messageId(msg) === event.msg_id (so the inbound is recognised as the
  // already-recorded one). conversationKey reads raw.channel_id first; messageId
  // reads raw.id first -- so both live in `raw`. `resume:true` tells the handler the
  // already-recorded inbound is expected, not a duplicate to drop.
  async resumePendingTurns({ maxCases = 200, maxRedrives = 50 } = {}) {
    if (this.opts.resumeOnBoot === false) return { scanned: 0, resumed: 0 }
    const handle = this.gateway?.handleInbound
    if (typeof handle !== 'function') return { scanned: 0, resumed: 0 }
    let scanned = 0, resumed = 0
    const openStatuses = new Set(this.store.getOpenStatuses?.() || [])
    const rows = await this.store.listCases({}, { limit: maxCases, offset: 0 })
    for (const c of rows) {
      if (resumed >= maxRedrives) break
      // Only re-drive cases still open (a closed/won case wants no further reply).
      if (openStatuses.size && !openStatuses.has(c.status)) continue
      // Skip channels with no live adapter to send on (e.g. a sim-only boot).
      if (!this.adapters[c.channel]?.send && c.channel !== 'sim') continue
      let events
      try { events = await this.store.listEvents(c.id) } catch { continue }
      scanned++
      // Walk chronologically. Track, per msgId, whether its turn started, whether a
      // completion (outbound/draft) followed, and whether a resume was already
      // attempted. A completion or a later inbound for the SAME msgId is positional.
      const started = new Map()       // msgId -> inbound event
      const completedAfter = new Set()
      const attempted = new Set()
      for (const ev of events) {
        if (ev.kind === 'inbound' && ev.msg_id) started.set(ev.msg_id, ev)
        else if (ev.kind === 'observation' && typeof ev.text === 'string') {
          const m = ev.text.match(/^resume-attempted:(.+)$/)
          if (m) attempted.add(m[1])
        }
        // Any outbound/draft completes EVERY turn started before it: a reply on the
        // conversation answers the latest inbound, so an earlier unanswered inbound
        // is no longer pending (the contact got a response on this thread).
        if (ev.kind === 'outbound' || ev.kind === 'draft') {
          for (const id of started.keys()) completedAfter.add(id)
        }
      }
      // The pending msgId: started, not completed, not already attempted. Take the
      // most recent such inbound only -- one re-drive answers the live thread.
      let pending = null
      for (const [id, ev] of started) {
        if (completedAfter.has(id) || attempted.has(id)) continue
        if (!pending || ev.created_at >= pending.ev.created_at) pending = { id, ev }
      }
      if (!pending) continue
      // Mark BEFORE re-drive -- at-most-once. A crash now leaves attempted-not-done,
      // and the next boot skips this msgId rather than re-driving (miss over double).
      try {
        await this.store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `resume-attempted:${pending.id}` })
      } catch (e) { this.log?.warn?.('[casey] resume marker failed', { caseId: c.id, error: e.message }); continue }
      const platform = c.channel
      const msg = {
        from: c.external_id,
        text: pending.ev.text || '',
        platform,
        resume: true,
        raw: { channel_id: c.external_id, id: pending.id, author: {} },
      }
      try {
        await handle.call(this.gateway, platform, msg)
        resumed++
        this.log?.info?.('[casey] resumed pending turn', { caseId: c.id, channel: c.channel })
      } catch (e) {
        // Already marked attempted, so it will not be retried -- log and move on.
        this.log?.warn?.('[casey] resume re-drive failed', { caseId: c.id, error: e.message })
      }
    }
    if (resumed) this.log?.info?.('[casey] resume sweep complete', { scanned, resumed })
    return { scanned, resumed }
  }

  // Drain messages QUEUED while the LLM backend was down. A message that arrived
  // during an outage is recorded as QUEUED-FOR-AGENT:<msgId> (plus one HOLDING-ACK
  // observation) and NOT driven through the agent -- there is no deterministic
  // fallback classification, so it waits for the model. This drains that queue when
  // the provider recovers. It diverges from resumePendingTurns deliberately:
  //   (a) HARD status()-gate at entry -- if the backend is still down, return early
  //       (never burn a queued message against a dead provider);
  //   (b) process ALL queued msgIds per case oldest->newest, serialized (not most-
  //       recent-only) -- every queued message deserves its turn, in order;
  //   (c) write queue-drive-attempted:<msgId> only AFTER a successful outbound/draft
  //       lands, so a re-drive that hits an again-degraded backend does NOT burn the
  //       attempt (the message stays queued for the next recovery);
  //   (d) a bounded retry cap -> queue-drive-failed:<msgId> dead-letter that surfaces
  //       to the inbox, so a permanently-failing message is not retried forever.
  // Serialized with resumePendingTurns behind one in-flight guard (_draining) across
  // boot + sweep + the recovery edge to avoid a double-drive.
  async drainQueuedTurns({ maxCases = 200, maxRedrives = 50, retryCap = 5 } = {}) {
    if (this._draining) return { scanned: 0, drained: 0, deferred: true }
    const handle = this.gateway?.handleInbound
    if (typeof handle !== 'function') return { scanned: 0, drained: 0 }
    // (a) hard status gate -- only drain when the backend is actually back.
    try {
      const st = await this.resilientStatus?.()
      if (st && st.ok === false) return { scanned: 0, drained: 0, degraded: true }
    } catch { /* if status is unavailable, fall through and let the turn throw-guard handle it */ }
    this._draining = true
    let scanned = 0, drained = 0
    try {
      const openStatuses = new Set(this.store.getOpenStatuses?.() || [])
      const rows = await this.store.listCases({}, { limit: maxCases, offset: 0 })
      for (const c of rows) {
        if (drained >= maxRedrives) break
        if (openStatuses.size && !openStatuses.has(c.status)) continue
        if (!this.adapters[c.channel]?.send && c.channel !== 'sim') continue
        let events
        try { events = await this.store.listEvents(c.id) } catch { continue }
        // Per msgId: the queued inbound, whether an outbound/draft completed it, the
        // attempt count, and whether it was dead-lettered.
        const queued = new Map()        // msgId -> inbound event
        const completedAfter = new Set()
        const attempts = new Map()      // msgId -> count
        const dead = new Set()
        for (const ev of events) {
          if (ev.kind === 'inbound' && ev.msg_id) { /* inbound seen; queued only if marked below */ }
          if (ev.kind === 'observation' && typeof ev.text === 'string') {
            let m = ev.text.match(/^QUEUED-FOR-AGENT:(.+)$/)
            if (m) { const inb = events.find(e => e.kind === 'inbound' && e.msg_id === m[1]); if (inb) queued.set(m[1], inb) }
            m = ev.text.match(/^queue-drive-(?:attempted|retry):(.+)$/)
            if (m) attempts.set(m[1], (attempts.get(m[1]) || 0) + 1)
            m = ev.text.match(/^queue-drive-failed:(.+)$/)
            if (m) dead.add(m[1])
          }
          if (ev.kind === 'outbound' || ev.kind === 'draft') {
            for (const id of queued.keys()) completedAfter.add(id)
          }
        }
        // (b) all still-queued msgIds, oldest-first.
        const pending = [...queued.entries()]
          .filter(([id]) => !completedAfter.has(id) && !dead.has(id))
          .sort((a, b) => a[1].created_at - b[1].created_at)
        if (!pending.length) continue
        scanned++
        for (const [id, ev] of pending) {
          if (drained >= maxRedrives) break
          const msg = { from: c.external_id, text: ev.text || '', platform: c.channel, resume: true, raw: { channel_id: c.external_id, id, author: {} } }
          try {
            await handle.call(this.gateway, c.channel, msg)
            // (c) mark attempted only AFTER a successful drive (handle sends/records
            // the reply). A throw skips the marker so the message stays queued.
            await this.store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `queue-drive-attempted:${id}` })
            drained++
          } catch (e) {
            const n = (attempts.get(id) || 0) + 1
            this.log?.warn?.('[casey] queue drive failed', { caseId: c.id, msgId: id, attempt: n, error: e.message })
            // (d) dead-letter after retryCap so a permanently-failing message stops.
            if (n >= retryCap) {
              try { await this.store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `queue-drive-failed:${id}` }) } catch { /* best effort */ }
            } else {
              // Record the failed attempt so the count advances toward the cap, but do
              // NOT mark drive-attempted (that only lands on success).
              try { await this.store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `queue-drive-retry:${id}` }) } catch { /* best effort */ }
            }
            // Stop this case's drain on a throw -- the backend likely went down again;
            // the next recovery edge re-enters and continues in order.
            break
          }
        }
      }
      if (drained) this.log?.info?.('[casey] queue drain complete', { scanned, drained })
      return { scanned, drained }
    } finally {
      this._draining = false
    }
  }

  // Quiet sweep: cases with no intake_mode tag and channel != 'web' get intake_mode:channel.
  async _backfillIntakeMode() {
    const PAGE = 200; let offset = 0; let tagged = 0
    for (;;) {
      const rows = await this.store.listCases({}, { limit: PAGE, offset })
      if (!rows.length) break
      for (const c of rows) {
        const tags = String(c.tags || '').split(',').map(s => s.trim()).filter(Boolean)
        const hasMode = tags.some(t => t.startsWith('intake_mode:'))
        if (!hasMode && c.channel && c.channel !== 'web') {
          await this.store.updateCaseQuiet(c.id, { tags: [...tags, 'intake_mode:channel'].join(',') })
          tagged++
        }
      }
      if (rows.length < PAGE) break
      offset += PAGE
    }
    if (tagged) this.log?.info?.('[casey] intake_mode backfill complete', { tagged })
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
    resetCaseStore()   // clear the process-wide singleton so the next boot is clean
  }
}

export async function createCasey(opts) {
  const c = new Casey(opts)
  await c.init()
  return c
}

// Minimal structured logger: one JSON line per event with a level + message +
// context. Quiet when CASEY_LOG=silent.
function makeLogger(component = 'casey') {
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
