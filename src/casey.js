// casey.js  --  top-level assembly. Boots the case store, registers casey's
// freddie plugin (case-tools), wires a freddie Gateway with the chosen channel
// adapters + casey's case hooks, and exposes start/stop.
//
// Channels:
//   whatsapp  --  freddie's Meta Graph webhook adapter (real)
//   discord  --  freddie's adapter + our WS receive (real simulation)

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const pathToFileUrl = (p) => pathToFileURL(p).href
import { Gateway, bootHost } from 'freddie'
import { createCaseStore } from './case-store.js'
import { setCaseStore, resetCaseStore } from './case-runtime.js'
import { makeCaseHandler, makeTransitionNotifier, discordHandoffNotifier, breachNotifier } from './gateway-hooks.js'
import { sweepCases } from './case-sweep.js'
import { ALL_HEALTH_TAGS } from './case-health.js'
import { parseListEnv } from './safe.js'
import { mergeTag } from './hooks/heuristics.js'

const CASE_HEALTH_SET = new Set(ALL_HEALTH_TAGS)

// Roster size from CASEY_OPERATORS (comma-separated id:Name or a JSON array). We
// only need the count of people EXPECTED to cover for the coverage-gap check, so a
// tolerant count is enough: a malformed roster counts as no roster (never a crash).
function rosterFromEnv(raw = process.env.CASEY_OPERATORS) {
  return parseListEnv(raw)
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
    this.channels = opts.channels || []
    this.store = null
    this.gateway = null
    this.adapters = {}
    this._inflight = new Set()      // track in-flight inbound turns for drain-tracking
    this._sweepTimer = null         // periodic health-guardrail interval handle
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
    //    context-free turn. We then wrap it to track in-flight turns so a caller
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

  // Channel registry: channel name -> async factory returning a ready adapter
  // instance. Adding a new channel (SMS, Telegram, Signal) means adding ONE
  // entry here (a new `_makeXAdapter` method plus a registry line) instead of
  // editing an if/else control-flow chain -- the registry is the single place
  // that answers "what channels does casey support" and "how do I add one".
  // A channel still needs its own thatcher.config.yml enum edit (contact.
  // channel/case.channel/event.channel) since the channel name is also a
  // stored data value, not just a code branch -- that part is inherent to
  // channel being a config-declared enum (see case-type-enum-config-driven /
  // priority-levels-config-driven for the same enum-vs-code-literal split) and
  // is not solved by this registry, only the ADAPTER WIRING side is.
  _channelRegistry() {
    return {
      discord: () => this._makeDiscordAdapter(),
      whatsapp: () => this._makeWhatsappAdapter(),
    }
  }

  async _makeAdapter(ch) {
    const registry = this._channelRegistry()
    const factory = registry[ch]
    if (!factory) throw new Error(`unknown channel "${ch}"`)
    return factory()
  }

  // whatsapp / discord come from freddie's platform plugins, registered on the
  // host's pi.platforms registry. We instantiate their adapter classes directly
  // for gateway use.
  //
  // Discord's gateway connect/reconnect/heartbeat/typing mechanics live
  // ENTIRELY in freddie's own DiscordAdapter now (plugins/platform-discord/
  // handler.js) -- casey previously carried a second, parallel implementation
  // (discord-receive.js) because an earlier freddie build's built-in receive
  // loop lacked a reconnect backoff ceiling and zombie-heartbeat detection.
  // freddie's adapter has since been upgraded to include both (merged in from
  // casey's own implementation, per the project's layering mandate: agentic
  // harness -> freddie, casey is setup + configuration only) plus a `ready`
  // event and a `botUserId` getter, so casey's wrapper here is now purely
  // CONFIGURATION -- filtering which inbound events open a case, and
  // verifying outbound delivery status -- never adapter mechanics. Follow
  // this method as the template for a future realtime-socket channel.
  async _makeDiscordAdapter() {
    {
      const { DiscordAdapter } = await import(freddieFile('plugins/platform/platform-discord/handler.js'))
      const a = new DiscordAdapter({ log: this.log })
      // Filter guild channel messages to only DMs (guild_id absent) or @mentions of
      // the bot. Without this, every message in any guild channel creates a case --
      // surveillance intake should only trigger when someone deliberately contacts
      // the bot, not from general server conversation.
      const origEmit = a.emit.bind(a)
      a.emit = (event, msg, ...rest) => {
        if (event === 'message') {
          const raw = msg?.raw || {}
          // DM: no guild_id. Guild: only if bot is @mentioned.
          const isDM = !raw.guild_id
          const mentions = Array.isArray(raw.mentions) ? raw.mentions : []
          // Fail CLOSED when botUserId is not yet known (process boot, or a
          // reconnect that lost the cached id), not open: the old fallback
          // (mentions.length > 0) treated ANY guild message mentioning ANY
          // user as "the bot was mentioned", opening a case from ordinary
          // guild chatter that never referenced casey at all -- the opposite
          // of this gate's whole purpose. The OBSERVABILITY log below already
          // records a.botUserId (null or real) on every filtered message, so
          // an operator can still distinguish "filtered because identity
          // isn't known yet" from "filtered because not a mention" with no
          // further plumbing.
          const botMentioned = a.botUserId ? mentions.some(u => u.id === a.botUserId) : false
          if (!isDM && !botMentioned) {
            // OBSERVABILITY: this filter used to drop a message with ZERO trace
            // anywhere -- not even a debug log line -- so a real inbound that
            // failed this check for any reason (a.botUserId not yet captured
            // from READY, Discord's mentions array shaped differently than
            // expected, a genuine non-mention message) was structurally
            // invisible: no case created, no receive-health stamp, nothing to
            // grep for. Live-witnessed this session: a real "@memobot hi" got
            // a guaranteed-fallback reply from an OLD, unrelated case while
            // the actual live message left no log trace at all, making this
            // exact gate the prime suspect with no way to confirm it. Log
            // every filtered-out message loud (never PII -- author id only,
            // never message content) so a silent drop is never silent again.
            this.log?.warn?.('[discord] message filtered (not a DM, bot not mentioned)', {
              channelId: raw.channel_id || null,
              guildId: raw.guild_id || null,
              authorId: raw?.author?.id || null,
              botUserId: a.botUserId || null,
              mentionIds: mentions.map(u => u?.id).filter(Boolean),
            })
            return false
          }
          // We received a real, addressed-to-us inbound: receive is alive. Stamp
          // BEFORE delegating so a throw downstream still records that we heard.
          this._markInbound('discord')
          this.log?.info?.('[discord] message accepted for intake', {
            channelId: raw.channel_id || null,
            guildId: raw.guild_id || null,
            authorId: raw?.author?.id || null,
            isDM,
            botMentioned,
          })
        }
        return origEmit(event, msg, ...rest)
      }
      // 'ready' fires on the REAL READY/RESUMED gateway dispatch events inside
      // the adapter -- stamps connectedAt so GET /api/health reflects true
      // receive-liveness (a live TCP socket is not the same as a dead gateway
      // delivering no inbound; see AGENTS.md's receive-liveness principle).
      a.on('ready', () => this._markConnected('discord'))
      // Outbound delivery is verified upstream: freddie's DiscordAdapter.send()
      // (freddie ^0.0.212) already routes through its own verifiedSend(), which
      // throws on a non-2xx / errored response body, so the caller here already
      // gets a rejected promise on a failed send.
      return a
    }
  }

  // WhatsApp needs no receive-resilience wrapper: freddie's WhatsappAdapter is
  // webhook-driven (Meta posts to us), not a persistent socket casey must
  // reconnect -- a genuinely simpler channel than Discord's realtime gateway.
  // A future webhook-driven channel (e.g. SMS via a carrier webhook) likely
  // fits this simpler shape rather than Discord's.
  async _makeWhatsappAdapter() {
    const { WhatsappAdapter } = await import(freddieFile('plugins/platform/platform-whatsapp/handler.js'))
    return new WhatsappAdapter({ port: this.opts.whatsappPort || 0 })
  }

  // Wrap gateway.handleInbound so every invocation is tracked + awaitable.
  _wrapInflight() {
    const orig = this.gateway.handleInbound.bind(this.gateway)
    this.gateway.handleInbound = (platform, msg) => {
      const p = orig(platform, msg).finally(() => this._inflight.delete(p))
      this._inflight.add(p)
      // freddie's Gateway fires handleInbound without awaiting it (AGENTS.md), so a
      // rejection here would otherwise surface only as Node's default
      // unhandledRejection handler -- which terminates the whole process, killing
      // every OTHER in-flight conversation over one bad turn. Attach a silent catch
      // on a SEPARATE promise chain (not the one stored in _inflight or returned to
      // the caller) purely to mark the rejection handled; the real error is already
      // logged deep inside makeCaseHandler's own try/catch.
      p.catch(e => { this.log?.error?.('[casey] handleInbound rejected (unexpected -- should have been caught internally)', { error: e?.message || String(e) }) })
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
  // so the health surface can distinguish "online" from "deaf". `web` is
  // request-driven and `whatsapp` is webhook-driven (Meta posts to us) --
  // neither holds a persistent socket that can go zombie, so both are
  // omitted. A channel is `ok` once it has connected; `quiet` is
  // informational only (a real channel can legitimately receive nothing for
  // long stretches), so quietness alone never flips the pill -- only
  // "configured but never connected since start" does, which is the
  // actionable signal an operator can act on (a wedged/zombie initial
  // connect). `now` is injectable for tests.
  receiveStatus(now = Date.now()) {
    const channels = {}
    let worst = 'ok'
    for (const ch of this.channels) {
      if (ch === 'web' || ch === 'whatsapp') continue   // no real-time receive socket
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

  // Await all in-flight inbound turns (used for drain-on-shutdown and test determinism).
  // Bounded by a timeout: one wedged turn (a hung adapter.send, an unreleased
  // store lock) must not block shutdown/drain forever -- the timeout branch logs
  // and lets the caller proceed, rather than hanging the whole process.
  async drain({ timeoutMs = Number(process.env.CASEY_DRAIN_TURN_TIMEOUT_MS) || 30000 } = {}) {
    const pending = [...this._inflight]
    if (!pending.length) return
    let timedOut = false
    await Promise.race([
      Promise.all(pending),
      new Promise(resolve => setTimeout(() => { timedOut = true; resolve() }, timeoutMs)),
    ])
    if (timedOut) this.log?.warn?.('[casey] drain() timed out waiting on in-flight turns', { pending: pending.length, timeoutMs })
  }

  // Run one health-guardrail sweep now. Exposed for tests and manual runs; the
  // scheduler calls the same path. Isolated: a sweep error is the caller's to log.
  async runSweepOnce(now = Date.now()) {
    // Re-entrancy guard, same pattern as resumePendingTurns/drainQueuedTurns's
    // shared _draining boolean. Without it, a sweep pass that runs longer than
    // sweepIntervalMs can overlap a second concurrent pass -- both would append
    // a "newly breaching" observation event and both would call notifyBreach
    // for the same case (violating case-sweep.js's own "never re-spammed"
    // contract), and both could race the unlocked _coverageGapActive
    // read-then-set, double-paging the team-lead.
    if (this._sweeping) return { scanned: 0, deferred: true }
    this._sweeping = true
    try {
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
    } finally { this._sweeping = false }
  }

  // Compute the team coverage gap and page once on the rising edge. The roster is
  // the configured CASEY_OPERATORS (people expected to cover); with no roster there
  // is no one to page about a gap, so the check no-ops. The event load is bounded to
  // open cases and only runs when at least one breaching case exists (no breaches ->
  // no gap regardless of replies), so a healthy quiet hour costs one cheap case scan.
  async _checkCoverageGap(now = Date.now()) {
    if (!this._notifyBreach) return                 // no alert channel configured
    // Re-read CASEY_OPERATORS on every sweep pass (this only runs on the
    // periodic health interval, not a hot path) rather than a boot-frozen
    // snapshot, so a roster edit takes effect on the next sweep with no
    // worker restart -- same fix as dashboard/server.js's getRoster().
    const roster = rosterFromEnv()
    if (!roster.length) return                      // no one expected to cover
    const allCases = await this.store.listCases({}, { limit: 10000 })
    // Same silent-truncation risk case-sweep.js's own fetch has: as the case
    // table grows past this cap, some genuinely-open breaching cases could
    // fall outside the fetched window and the coverage gap check would never
    // see them, with zero warning. Log loud so an operator can raise the cap.
    if (allCases.length >= 10000) this.log?.warn?.('[sweep] hit case-fetch cap in coverage-gap check; some cases may be unclassified', { fetched: allCases.length })
    const open = allCases.filter(c => c.status !== 'closed' && c.status !== 'resolved')
    const breaching = open.filter(c => String(c.tags || '').split(',').map(s => s.trim()).some(t => CASE_HEALTH_SET.has(t)))
    if (!breaching.length) {                        // no breaches -> gap is impossible
      this._coverageGapActive = false
      return
    }
    // detectCoverageGap only reads events for cases whose tags intersect the
    // health-tag set (breaching) -- fetching events for every open case here
    // was O(open) work for an O(breaching) need, a cost that grows with total
    // case count rather than the actually-relevant subset.
    const eventsByCaseId = new Map()
    for (const c of breaching) eventsByCaseId.set(c.id, await this.store.listEvents(c.id).catch(() => []))
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

  // Periodic drain-poll: drainQueuedTurns is otherwise only reached via the
  // brain's onRecover edge (which itself only fires from a real callLLM/status()
  // call -- i.e. a NEW inbound on the SAME conversation, or a human loading the
  // dashboard health row) or the boot-time resumePendingTurns sweep (which
  // deliberately skips any case already tagged resume-exhausted). A contact whose
  // message got queued during a real outage, who then does not write again
  // (the ordinary case -- they are waiting for casey, not casey waiting for
  // them) and whom no operator happens to check on, has its queued reply sit
  // forever even once the backend is fully healthy again -- live-witnessed: a
  // real "hi there" queued during a genuine LLM-down window stayed queued with
  // no reply long after the backend had recovered, because nothing in the
  // running process was ever polling status() in the background to notice the
  // recovery and fire the drain. This timer is that missing background poll --
  // deliberately much shorter than the 15-minute case-health sweep, since it
  // directly gates how long a real contact is left in silence. drainQueuedTurns
  // itself is a cheap no-op when nothing is queued (an empty scan), and its own
  // status-gate gets the backend to skip work entirely while still down, so a
  // short interval costs nothing during normal healthy operation.
  startDrainPoll(intervalMs = this.opts.drainPollIntervalMs ?? 60 * 1000) {
    this.stopDrainPoll()
    if (!(intervalMs > 0)) return
    this._drainPollTimer = setInterval(() => {
      // Tracked in _inflight the same way gateway.handleInbound is (see
      // _wrapInflight) -- without this, drain()'s shutdown wait never saw
      // this poll's own store writes in flight, letting stop() close the
      // store mid-write on this exact background path.
      const p = this.drainQueuedTurns().catch(e => this.log?.warn?.('[casey] drain poll failed', { error: e.message }))
      this._inflight.add(p)
      p.finally(() => this._inflight.delete(p))
    }, intervalMs)
    this._drainPollTimer.unref?.()
  }

  stopDrainPoll() {
    if (this._drainPollTimer) { clearInterval(this._drainPollTimer); this._drainPollTimer = null }
  }

  async start() {
    await this.gateway.start()
    // Default-on guardrails: enabled unless explicitly disabled (sweepIntervalMs<=0).
    if (this.opts.sweepIntervalMs !== 0) this.startSweep()
    // Default-on: enabled unless explicitly disabled (drainPollIntervalMs<=0).
    if (this.opts.drainPollIntervalMs !== 0) this.startDrainPoll()
    // One-time backfill: tag channel-created cases that predate intake_mode tagging.
    this._backfillIntakeMode().catch(e => this.log?.warn?.('[casey] intake_mode backfill failed', { error: e.message }))
    // One-shot boot recovery: re-drive turns that started but never replied (the
    // process crashed/reloaded mid-turn). Bounded; never blocks start; never
    // double-sends (each re-drive is marked BEFORE it runs). Tracked so stop()
    // can await it -- unawaited-and-untracked here meant drain()'s _inflight
    // scan (which only ever saw wrapped gateway.handleInbound calls) could
    // return immediately while this sweep was still mid-write, letting
    // store.close() race a concurrent store.appendEvent/updateCase call from
    // this same sweep -- the exact torn-shutdown race stop()'s own header
    // comment claims to prevent.
    this._resumeSweepPromise = this.resumePendingTurns().catch(e => this.log?.warn?.('[casey] resume sweep failed', { error: e.message }))
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
  async resumePendingTurns({ maxCases = 200, maxRedrives = Number(process.env.CASEY_RESUME_MAX_REDRIVES) || 10, spacingMs = Number(process.env.CASEY_RESUME_SPACING_MS) || 2000 } = {}) {
    if (this.opts.resumeOnBoot === false) return { scanned: 0, resumed: 0 }
    const handle = this.gateway?.handleInbound
    if (typeof handle !== 'function') return { scanned: 0, resumed: 0 }
    // Share the SAME _draining guard drainQueuedTurns uses. start() fires this
    // unawaited during boot, and an LLM recovery edge can fire drainQueuedTurns
    // around the same window -- without this guard the two race on
    // appendEvent/case locks for the same msgId, exactly the double-drive the
    // (until now, only aspirational) comment on drainQueuedTurns claims is
    // prevented.
    if (this._draining) return { scanned: 0, resumed: 0, deferred: true }
    this._draining = true
    let scanned = 0, resumed = 0
    try {
      const openStatuses = new Set(this.store.getOpenStatuses?.() || [])
      const rows = await this.store.listCases({}, { limit: maxCases, offset: 0 })
      for (const c of rows) {
        if (resumed >= maxRedrives) break
        // Only re-drive cases still open (a closed/won case wants no further reply).
        if (openStatuses.size && !openStatuses.has(c.status)) continue
        // Skip channels with no live adapter to send on.
        if (!this.adapters[c.channel]?.send) continue
        // CASE-LEVEL DEAD-LETTER: a case already flagged resume-exhausted (below)
        // has NO genuinely-pending msgId left -- every one it ever had is either
        // completed or has hit RESUME_DEGRADED_RETRY_CAP. Skip it before even
        // fetching its event log, the cheapest possible short-circuit. Without
        // this, the per-msgId cap alone was not enough: a case with MANY
        // historical inbound messages (a contact who sent several messages
        // during an outage) picks a DIFFERENT still-under-cap msgId on each
        // boot's sweep, so the case as a whole never actually stopped being
        // re-driven -- live-witnessed this session as ~28 ancient stuck cases
        // (some carrying 5-10 distinct pending msgIds each) getting walked on
        // EVERY single boot for hours, each walk burning a full provider-chain
        // attempt per msgId and competing directly with live traffic for the
        // same rate-limited capacity. A dead-lettered case still shows up in
        // the operator's needs-human queue (tagged below) -- nothing is lost,
        // it just stops silently consuming provider budget forever.
        if ((c.tags || '').split(',').map(s => s.trim()).includes('resume-exhausted')) continue
        let events
        try { events = await this.store.listEvents(c.id) } catch { continue }
        scanned++
        // Walk chronologically. Track, per msgId, whether its turn started, whether a
        // completion (outbound/draft) followed, and whether a resume was already
        // attempted. A completion or a later inbound for the SAME msgId is positional.
        const started = new Map()       // msgId -> inbound event
        const completedAfter = new Set()
        const attempted = new Set()     // resume-attempted this boot's own pass (same-boot dedup only)
        const degradedCount = new Map() // msgId -> count of resume-degraded markers across ALL boots
        for (const ev of events) {
          if (ev.kind === 'inbound' && ev.msg_id) started.set(ev.msg_id, ev)
          else if (ev.kind === 'observation' && typeof ev.text === 'string') {
            let m = ev.text.match(/^resume-attempted:(.+)$/)
            if (m) attempted.add(m[1])
            m = ev.text.match(/^resume-degraded:(.+)$/)
            if (m) degradedCount.set(m[1], (degradedCount.get(m[1]) || 0) + 1)
          }
          // Any outbound/draft completes EVERY turn started before it: a reply on the
          // conversation answers the latest inbound, so an earlier unanswered inbound
          // is no longer pending (the contact got a response on this thread).
          if (ev.kind === 'outbound' || ev.kind === 'draft') {
            for (const id of started.keys()) completedAfter.add(id)
          }
        }
        // The pending msgId: started, not completed, and either never attempted
        // OR previously attempted-but-degraded (no real reply) with retries
        // still under the cap. A msgId marked resume-attempted with NO
        // resume-degraded marker is treated as a genuine, silent completion
        // (the handler threw, or something unexpected happened with no
        // observation recorded) -- still not retried, matching the ORIGINAL
        // at-most-once-forever behavior for that specific failure shape, since
        // there is no positive signal here (unlike degraded) that another
        // attempt would behave differently. RESUME_DEGRADED_RETRY_CAP bounds
        // total retries across all future boots so a permanently-broken
        // backend still stops trying eventually, same discipline as
        // drainQueuedTurns' retryCap -> queue-drive-failed dead-letter.
        const RESUME_DEGRADED_RETRY_CAP = 5
        // Age ceiling, independent of attempt count: a message that has sat
        // unanswered this long has almost certainly had its sender move on --
        // continuing to resume-retry it provides no real value to anyone and
        // only keeps consuming provider budget shared with live traffic.
        // Bounds the total number of BOOTS a stuck msgId can ever be retried
        // across (not just attempts within one boot), which the attempt-count
        // cap alone did not do: a case with many old distinct pending msgIds
        // could keep finding a fresh under-cap one to retry, boot after boot,
        // indefinitely -- live-witnessed as ~28 cases some untouched for many
        // hours still being walked on every single restart tonight.
        const RESUME_MAX_AGE_MS = Number(process.env.CASEY_RESUME_MAX_AGE_MS) || 24 * 60 * 60 * 1000
        const nowMs = Date.now()
        let pending = null
        let anyCapped = false
        for (const [id, ev] of started) {
          if (completedAfter.has(id)) continue
          const wasAttempted = attempted.has(id)
          const degraded = degradedCount.get(id) || 0
          if (wasAttempted && degraded === 0) continue           // silent non-degraded completion: leave it alone
          const ageMs = nowMs - (Number(ev.created_at) || nowMs)
          if (degraded >= RESUME_DEGRADED_RETRY_CAP || ageMs >= RESUME_MAX_AGE_MS) { anyCapped = true; continue }  // exhausted retries or too old: stop trying
          if (!pending || ev.created_at >= pending.ev.created_at) pending = { id, ev }
        }
        if (!pending) {
          // No genuinely-pending msgId survives (each is either completed,
          // a silent non-degraded miss, or capped) -- if at least one was a
          // REAL exhausted retry (anyCapped), this case has demonstrably
          // never going to self-resolve via more resume attempts. Dead-letter
          // it so it stops consuming a scan+event-fetch AND, more importantly,
          // never re-enters the pending selection above on a future boot.
          // A case whose only uncompleted msgIds are silent (non-degraded)
          // misses is left alone deliberately -- unlike a capped degraded
          // retry, a silent miss has no positive signal that resuming would
          // ever have helped in the first place, so there is nothing to
          // conclude by giving up.
          if (anyCapped) {
            try {
              await this.store.updateCase(c.id, { tags: mergeTag(mergeTag(c.tags, 'resume-exhausted'), 'needs-human') })
              await this.store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: 'resume-exhausted: every pending message hit the resume-degraded retry cap; this case will no longer be auto-resumed and needs a human.' })
            } catch (e) { this.log?.warn?.('[casey] resume-exhausted tag failed', { caseId: c.id, error: e.message }) }
          }
          continue
        }
        // Mark BEFORE re-drive -- at-most-once PER BOOT. A crash now leaves
        // attempted-not-done, and the next boot within the SAME resume pass
        // would otherwise re-drive the same msgId twice; the per-boot marker
        // prevents that immediate double-drive. It does NOT mean permanently
        // done -- see the completion check below, which appends a SEPARATE
        // resume-degraded:<id> marker when the redrive itself came back
        // degraded (blanked, no real reply), so a LATER boot's sweep still
        // sees this msgId as pending (resume-attempted alone no longer
        // suffices to mark it completedAfter-equivalent) and gets another
        // shot once the underlying model/provider issue clears. Previously
        // handle.call(...)'s return value was never inspected -- ANY
        // non-throwing call (including one whose reply was correctly blanked
        // by the degraded-turn guards) was treated as a permanent success,
        // silently abandoning a contact whose message was never actually
        // answered. Witnessed live this session: case mrm1kieg-fdvbupbo had
        // two "hi there I'm in tweni" messages each marked resume-attempted
        // yet neither ever received a real outbound reply -- confirmed via
        // the case's own event log (resume-attempted with no following
        // outbound/degraded-with-no-retry-path).
        // Spaced, not a burst: each re-drive walks the SAME provider chain a
        // brand-new live contact's message would, and a boot with many stuck
        // cases fires them back-to-back with no delay between -- directly
        // competing for the same tiny per-minute rate-limit windows a real
        // inbound needs right now. Live-witnessed: a genuine "hey whats up"
        // arrived mid-sweep and timed out because every configured provider
        // was still rate-limited from the sweep's OWN traffic seconds
        // earlier. maxRedrives also dropped from 50 to a
        // CASEY_RESUME_MAX_REDRIVES-tunable default of 10 for the same
        // reason -- most boots have few or zero genuinely-stuck cases; a high
        // count is itself a symptom (heavy testing/restart churn) that should
        // not compound into starving live traffic. Gated on resumed > 0 so
        // the FIRST re-drive of a boot still fires immediately (nothing to
        // wait behind yet); placed here (immediately before the actual
        // re-drive), not earlier in the loop, so cases skipped by the
        // eligibility filters above never pay the delay.
        if (resumed > 0 && spacingMs > 0) await new Promise(r => setTimeout(r, spacingMs))
        try {
          await this.store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `resume-attempted:${pending.id}` })
        } catch (e) { this.log?.warn?.('[casey] resume marker failed', { caseId: c.id, error: e.message }); continue }
        const platform = c.channel
        // Same channel_id split as drainQueuedTurns below: external_id is the
        // CASE IDENTITY (conversationKey's "container:author" shape on a
        // multi-author channel), not a valid Discord channel snowflake on its
        // own -- replyTarget() reads msg.raw.channel_id directly, so passing
        // the combined external_id through unsplit sent every resumed reply
        // on a multi-author Discord channel to Discord as an invalid channel
        // id (400 Invalid Form Body, NUMBER_TYPE_COERCE), silently never
        // reaching the contact even when the LLM call itself succeeded.
        const parts = c.external_id.split(':')
        const container = parts[0]
        // SEVERE COMPOUNDING-KEY BUG, fixed here: msg.from must be the bare
        // AUTHOR id only -- passing the whole combined external_id back in as
        // `from` (as this line used to) makes conversationKey() (which
        // computes `container:from`) recombine it into
        // `container:container:author` on THIS redrive's own next write,
        // growing by one duplicated container segment on every single
        // resume-sweep pass. Live-witnessed: real production external_ids for
        // this channel's cases had accumulated the SAME channel id 30+ times,
        // colon-joined, after weeks of nightly resume sweeps silently
        // corrupting them one redrive at a time -- conversationKey() itself
        // was never the bug (it always emits a clean two-part key), the bug
        // was this call site feeding its own prior output back in as raw
        // input. The real author is always the LAST colon-separated segment,
        // regardless of how many duplicated container segments already
        // accumulated in front of it -- taking the last part both fixes the
        // bug going forward AND self-heals existing corrupted keys on their
        // very next successful resume (the freshly split-and-rejoined key
        // this redrive writes collapses back to a clean two-part
        // container:author, no separate one-off migration needed).
        const author = parts[parts.length - 1]
        const msg = {
          from: author,
          text: pending.ev.text || '',
          platform,
          resume: true,
          raw: { channel_id: container, id: pending.id, author: {} },
        }
        try {
          const res = await handle.call(this.gateway, platform, msg)
          resumed++
          if (res && res.degraded) {
            this.log?.warn?.('[casey] resumed turn came back degraded; still no reply', { caseId: c.id, channel: c.channel })
            try { await this.store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `resume-degraded:${pending.id}` }) }
            catch (e2) { this.log?.warn?.('[casey] resume-degraded marker failed', { caseId: c.id, error: e2.message }) }
          } else {
            this.log?.info?.('[casey] resumed pending turn', { caseId: c.id, channel: c.channel })
          }
        } catch (e) {
          // Already marked attempted, so it will not be re-driven again THIS
          // sweep, but the throw itself means no observation was recorded for
          // it either -- log loud so an operator can see the failure even
          // though no resume-degraded marker exists to name it as such.
          this.log?.warn?.('[casey] resume re-drive failed', { caseId: c.id, error: e.message })
        }
      }
      // Always log the sweep's outcome, not just when it actually redrove
      // something -- a silent "nothing happened" completion is exactly as
      // important to see as a busy one when diagnosing whether the sweep is
      // running at all vs. genuinely idle vs. quietly stuck. Previously
      // gated on `if (resumed)`, so a fully-idle sweep (the common,
      // healthy case once the dead-letter fix above is doing its job) left
      // zero trace it ever ran.
      this.log?.info?.('[casey] resume sweep complete', { scanned, resumed })
      return { scanned, resumed }
    } finally { this._draining = false }
  }

  // Drain messages QUEUED while the LLM backend was down. A message that arrived
  // during an outage is recorded as QUEUED-FOR-AGENT:<msgId> and NOT driven
  // through the agent (no fallback text is sent -- see the no-fallback directive
  // in gateway-hooks.js) -- it waits for the model. This drains that queue when
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
    // (a) hard status gate -- only drain when the backend is actually back. Falls
    // back to opts.llmStatus / callLLM.status when resilientStatus was not wired
    // (e.g. an embedded/test Casey built via createCasey without a worker shell).
    try {
      const statusFn = this.resilientStatus
        || this.opts.llmStatus
        || (typeof this.opts.callLLM?.status === 'function' ? this.opts.callLLM.status.bind(this.opts.callLLM) : null)
      const st = statusFn ? await statusFn() : null
      if (st && st.ok === false) {
        // Same "always log the outcome" discipline as the post-scan completion
        // log below -- this early bail is the MOST common outcome of a routine
        // drain-poll tick (the backend is still down between recovery windows)
        // and was previously silent, making it indistinguishable from the timer
        // never having fired at all. Live-witnessed needing this while
        // verifying the drain-poll fix itself.
        this.log?.info?.('[casey] queue drain skipped (backend degraded)', { source: st.source, degraded: st.degraded })
        return { scanned: 0, drained: 0, degraded: true }
      }
    } catch { /* if status is unavailable, fall through and let the turn throw-guard handle it */ }
    this._draining = true
    let scanned = 0, drained = 0
    try {
      const openStatuses = new Set(this.store.getOpenStatuses?.() || [])
      const rows = await this.store.listCases({}, { limit: maxCases, offset: 0 })
      for (const c of rows) {
        if (drained >= maxRedrives) break
        if (openStatuses.size && !openStatuses.has(c.status)) continue
        if (!this.adapters[c.channel]?.send) continue
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
          // queuedRedrive marks this as a QUEUE re-drive (vs a boot resume): a
          // degraded turn then records an observation instead of an outbound so
          // the queued msgId is never positionally burned.
          //
          // external_id is the CASE IDENTITY (conversationKey's own "container:author"
          // shape on a multi-author channel -- see hooks/handler.js's conversationKey/
          // replyTarget split) -- it is NOT a valid Discord channel snowflake on its
          // own. replyTarget(msg) reads msg.raw.channel_id directly, so passing the
          // combined external_id through unsplit sent every queued-redrive reply on a
          // multi-author Discord channel to Discord as an invalid channel id (400
          // Invalid Form Body, NUMBER_TYPE_COERCE) -- the queued reply silently never
          // reached the contact. Recover the real container id (the FIRST segment)
          // and the real author id (the LAST segment) -- same compounding-key fix
          // as resumePendingTurns above: passing the whole combined external_id
          // through as `from` let conversationKey() recombine it into an
          // ever-growing container:container:...:author on every redrive. Taking
          // the last segment also self-heals an already-corrupted multi-segment
          // key back to a clean two-part one on this redrive's own write.
          const qParts = c.external_id.split(':')
          const container = qParts[0]
          const author = qParts[qParts.length - 1]
          const msg = { from: author, text: ev.text || '', platform: c.channel, resume: true, queuedRedrive: true, raw: { channel_id: container, id, author: {} } }
          try {
            const res = await handle.call(this.gateway, c.channel, msg)
            // A DEGRADED re-drive (the turn ended in the fallback path -- the agent
            // never actually understood the message) is a FAILED attempt, not a
            // completion: count it toward the retry cap and keep the msg queued.
            if (res && res.degraded) {
              const n = (attempts.get(id) || 0) + 1
              this.log?.warn?.('[casey] queue drive degraded', { caseId: c.id, msgId: id, attempt: n })
              if (n >= retryCap) {
                try { await this.store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `queue-drive-failed:${id}` }) } catch { /* best effort */ }
              } else {
                try { await this.store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `queue-drive-retry:${id}` }) } catch { /* best effort */ }
              }
              // The backend is evidently still shaky -- stop this case's drain.
              break
            }
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
      // Always log the outcome, not just when something drained -- matching the
      // same fix already applied to resumePendingTurns's sweep-complete log
      // (see its own comment). A silent "nothing queued" completion is exactly
      // as important to see as a busy one when diagnosing whether the periodic
      // drain-poll timer (startDrainPoll) is actually running at all vs.
      // genuinely idle vs. quietly stuck/never-started -- live-witnessed
      // needing this while verifying the drain-poll fix itself: with no log on
      // an empty scan, a real stuck case sitting un-drained was indistinguishable
      // from "the timer never fired" and "the timer fired but found nothing".
      this.log?.info?.('[casey] queue drain complete', { scanned, drained })
      return { scanned, drained }
    } finally {
      this._draining = false
    }
  }

  // Read-only queue-depth check for the dashboard health panel: how many
  // messages are currently sitting in the LLM-down queue (QUEUED-FOR-AGENT
  // recorded, no completing outbound/draft/dead-letter yet) and how many have
  // been dead-lettered (queue-drive-failed, exhausted retryCap). Mirrors
  // drainQueuedTurns' own event-marker scan (see its comments for the exact
  // marker vocabulary) but never drives a turn -- this must be cheap enough to
  // call on every /api/health poll, so it is capped the same way (maxCases)
  // and never touches _draining (a concurrent real drain is unaffected).
  async queueStatus({ maxCases = 200 } = {}) {
    let pending = 0, deadLettered = 0
    try {
      const rows = await this.store.listCases({}, { limit: maxCases, offset: 0 })
      for (const c of rows) {
        let events
        try { events = await this.store.listEvents(c.id) } catch { continue }
        const queued = new Map()
        const completedAfter = new Set()
        const dead = new Set()
        for (const ev of events) {
          if (ev.kind === 'observation' && typeof ev.text === 'string') {
            let m = ev.text.match(/^QUEUED-FOR-AGENT:(.+)$/)
            if (m) { const inb = events.find(e => e.kind === 'inbound' && e.msg_id === m[1]); if (inb) queued.set(m[1], inb) }
            m = ev.text.match(/^queue-drive-failed:(.+)$/)
            if (m) dead.add(m[1])
          }
          if (ev.kind === 'outbound' || ev.kind === 'draft') {
            for (const id of queued.keys()) completedAfter.add(id)
          }
        }
        for (const id of queued.keys()) {
          if (dead.has(id)) deadLettered++
          else if (!completedAfter.has(id)) pending++
        }
      }
    } catch (e) { this.log?.warn?.('[casey] queueStatus scan failed', { error: e.message }) }
    return { pending, deadLettered }
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
    this.stopDrainPoll()
    await this.gateway?.stop()
    // Wait out the boot-time resume sweep too, not just gateway.handleInbound's
    // own in-flight turns -- see start()'s comment on why this is tracked
    // separately (resumePendingTurns is not itself a gateway.handleInbound call
    // so _wrapInflight never saw it).
    await this._resumeSweepPromise?.catch(() => {})
    try { await this.drain() } catch { /* in-flight turn errored; already logged */ }
    await this.store?.close()
    resetCaseStore()   // clear the process-wide singleton so the next boot is clean
  }
}

export async function createCasey(opts) {
  const c = new Casey(opts)
  await c.init()
  // Wire the drain gate's status source when the caller gave one, so an embedded
  // Casey (tests) gets the same hard status()-gate as the worker shell, which
  // overwrites this with the resilient backend's status.
  if (!c.resilientStatus && opts?.llmStatus) c.resilientStatus = opts.llmStatus
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
