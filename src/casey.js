// casey.js  --  top-level assembly. Boots the case store, builds the
// channel adapters (casey's own, src/adapters/) and casey's case-aware
// inbound handler (gateway-hooks.js), then boots freddie's real Cordis tree
// (freddie-bundle/boot.js) -- freddie IS the agent for casey now: its own
// AgentLoop/ctx.tools/ctx.llm/ctx.webServer drive every turn, with casey's
// case-tools/llm-acptoapi/platform plugins mounted alongside freddie-base.
// this.gateway is a thin {handleInbound, start, stop} shim over the same
// adapters/handler, kept for every downstream call site (resume sweep,
// drain queue) that pre-dates the freddie port.
//
// Channels:
//   whatsapp  --  casey's own WhatsApp Cloud API webhook adapter, wired into
//                 freddie's ctx.webServer by the casey-platform Cordis plugin
//   discord   --  casey's own Discord gateway-websocket adapter (outbound
//                 client, no listening socket needed)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootCasey } from '../freddie-bundle/boot.js'
import { createCaseStore } from './case-store.js'
import { setCaseStore, resetCaseStore } from './case-runtime.js'
import { makeCaseHandler, makeTransitionNotifier, discordHandoffNotifier, breachNotifier } from './gateway-hooks.js'
import { isOpenCase } from './format.js'
import { tagList, tsMs } from './timestamp.js'
import { resumePendingTurnsBody } from './casey-resume.js'
import { drainQueuedTurnsBody } from './casey-drain.js'
import { makeChannelAdapter } from './casey-adapters.js'
import { sweepCases } from './case-sweep.js'
import { AlertLog, AlertGate, fileAlertNotifier, SYSTEM_CONDITIONS } from './alert-log.js'
import { ALL_HEALTH_TAGS } from './case-health.js'
import { mergeTag } from './hooks/heuristics.js'
import { caseDeliveryTarget, splitExternalId } from './hooks/handler.js'
import { disposeAgent } from './agent/run-turn.js'

const CASE_HEALTH_SET = new Set(ALL_HEALTH_TAGS)

// The real operator_account table, not the CASEY_OPERATORS env var --
// AGENTS.md already documents CASEY_OPERATORS as superseded everywhere else
// by this table (GET /api/operators, actingOperator(req)); this was the last
// live env-var read. Same {id, name} shape and same disabled-account
// exclusion as dashboard/server.js's own getRoster(), so the coverage-gap
// headcount now tracks the SAME authoritative roster the dashboard already
// shows, with no separate env var to keep in sync by hand. Tolerant: any
// store failure counts as no roster (never crashes the sweep).
async function rosterFromAccounts(store) {
  try {
    const { listAccounts } = await import('./dashboard/auth.js')
    const accounts = await listAccounts(store)
    return accounts.filter(a => a.disabled !== '1').map(a => ({ id: a.username, name: a.display_name || a.username }))
  } catch { return [] }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// A deployer package (e.g. serpent) can register its OWN casey-toolset
// Cordis plugins -- real ctx.tools.register(defineTool(...)) tools that need
// to be visible to the contact-facing agent's tool allowlist (see
// freddie-bundle/src/case-tools/tool-allowlist.js) without casey itself
// knowing anything about that domain's tools. CASEY_EXTRA_PLUGINS_DIR is a
// deployer-set env var (same discipline as CASEY_CONFIG_DIR: never
// contact-influenced, only ever set by whoever starts the process), pointing
// at a directory of plugin.js files (same {name, inject, apply(ctx)}
// contract as casey's own freddie-bundle plugins) inserted as additional
// patch rows alongside casey's own three -- additive, never a replacement.
// Absent, behavior is byte-identical to before this existed. Validated
// eagerly so a deployer's typo'd path fails loud at boot, matching
// CASEY_CONFIG_DIR's own fail-fast behavior (loadDomainConfig() throws on a
// missing dir).
const CASEY_EXTRA_PLUGINS_DIR = (() => {
  if (!process.env.CASEY_EXTRA_PLUGINS_DIR) return null
  const dir = path.resolve(process.env.CASEY_EXTRA_PLUGINS_DIR)
  if (!fs.existsSync(dir)) throw new Error(`CASEY_EXTRA_PLUGINS_DIR not found: ${dir}`)
  return dir
})()

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
    this._alertWatchTimer = null    // periodic system-condition watch interval handle
    this._coverageGapActive = false // rising-edge dedup so a persistent gap pages once
    // When the last guardrail sweep PASS COMPLETED. The alert watch below reads
    // it to answer "has the sweep stopped running", which nothing else in the
    // process could answer: the sweep's own silence is its only symptom.
    this._lastSweepAt = null
    this._startedAt = Date.now()
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

    // 2) build casey's case-aware inbound handler (see gateway-hooks.js) --
    //    freddie's own agent loop is the turn's actual LLM/tool-orchestration
    //    engine now (src/agent/run-turn.js), so the handler no longer takes a
    //    callLLM of its own to hand a gateway -- the case handler still owns
    //    the LLM decision (P4: one layer, one capability), it just reaches
    //    freddie's real agent instead of a casey-owned loop.
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
    this._wireAlerting()

    // 3) build adapters for the requested channels (casey's own DM/mention
    //    filtering, follow-up window, and receive-liveness tracking --
    //    unchanged from before the freddie port, see _makeDiscordAdapter).
    const platforms = {}
    for (const ch of this.channels) platforms[ch] = await makeChannelAdapter(ch, { log: this.log, store: this.store, markConnected: (c) => this._markConnected(c), markInbound: (c) => this._markInbound(c) })
    this.adapters = platforms
    return this._initFreddieAndHooks(handler)
  }

  // Everything that decides WHERE an alert goes, in one place so the choice can
  // be read (and exercised) without booting freddie's whole Cordis tree. Called
  // once from init(), after the store exists and before any timer starts.
  _wireAlerting() {
    // High-severity guardrail breaches alert the team over the same webhook
    // transport as a handoff (CASEY_ALERT_WEBHOOK, falling back to the handoff
    // webhook). Null when neither is set: the sweep still flags every case via
    // health:* tags, so the dashboard inbox surfaces them regardless.
    this._notifyBreach = this.opts.notifyBreach || breachNotifier(undefined, this.log)
    // THE PATH THAT NEEDS NO URL. breachNotifier returns null when neither
    // CASEY_ALERT_WEBHOOK nor CASEY_HANDOFF_WEBHOOK is set, and until now that
    // meant nothing in this deployment could tell a human anything unless a
    // human was already looking at the dashboard. src/alert-log.js is the
    // fallback for exactly that case: a bounded, rotating, greppable JSONL file
    // plus a stderr line, watchable by cron/systemd/`tail -f` on a box with no
    // outbound network. It is built ONLY when the webhook notifier is null, so
    // a configured webhook is never replaced, duplicated or downgraded by it.
    this._alertLog = null
    if (!this._notifyBreach) {
      try {
        this._alertLog = new AlertLog({ dataDir: this.store.dataDir })
        this._notifyBreach = fileAlertNotifier(this._alertLog, this.log)
        this.log?.info?.('[casey] no alert webhook configured; alerts go to the local alert log', { file: this._alertLog.file })
      } catch (e) {
        this.log?.warn?.('[casey] alert log unavailable; nothing will page anyone', { error: e.message })
      }
    }
    // The rising-edge state for the system-condition watch below. Built on both
    // paths (webhook and file), because the "page once per rising edge" rule is
    // about the CONDITION, not about which channel carries it -- case-sweep.js
    // holds the same rule for a per-case breach and _coverageGapActive holds it
    // for the team gap. Durable rather than in-memory so a crash-looping worker
    // does not re-raise a standing condition on every boot.
    try { this._alertGate = new AlertGate({ dataDir: this.store.dataDir }) }
    catch (e) { this._alertGate = null; this.log?.warn?.('[casey] alert gate unavailable; system-condition alerts are off', { error: e.message }) }
    // Distinct supervisor channel for the escalated handoff tier. Falls back to the
    // ordinary breach notifier when CASEY_ESCALATE_WEBHOOK is unset, so escalation
    // is never silently dropped -- it just shares the alert channel.
    this._notifyEscalation = this.opts.notifyEscalation
      || breachNotifier(process.env.CASEY_ESCALATE_WEBHOOK, this.log)
      || this._notifyBreach
  }

  async _initFreddieAndHooks(handler) {
    // 4) boot freddie's real Cordis tree (freddie-bundle/boot.js): mounts
    //    @freddie/freddie-base's LLM/agent-loop/session/tool plumbing, then
    //    casey's own case-tools/llm-acptoapi/platform plugins, which wire the
    //    already-built adapters above to the wrapped handler below.
    //
    // this.gateway keeps the SAME {handleInbound, start, stop} shape the old
    // freddie Gateway exposed -- every downstream call site below (resume
    // sweep, drain queue, start/stop, drain()) reaches through this.gateway
    // unchanged; only its construction moved from `new Gateway(...)` to
    // freddie's own boot() assembling the whole transport+agent-loop tree.
    const boundHandler = handler.bind(this)
    this.gateway = {
      handleInbound: (platform, msg) => boundHandler(platform, msg),
      // WhatsApp's own start() (an express-server listen) is never called --
      // its webhook route is registered directly on freddie's ctx.webServer
      // by casey-platform's apply() instead. Discord's start() (the real
      // gateway WebSocket connect) still needs calling explicitly here.
      start: async () => {
        for (const a of Object.values(this.adapters)) {
          if (a.platform !== 'whatsapp') await a.start?.()
        }
      },
      stop: async () => {
        for (const a of Object.values(this.adapters)) await a.stop?.()
      },
    }
    this._wrapInflight()
    this.freddieCtx = await bootCasey({
      channels: this.channels,
      handleInbound: (platform, msg) => this.gateway.handleInbound(platform, msg),
      adapters: this.adapters,
      extraPluginsDir: CASEY_EXTRA_PLUGINS_DIR,
    })

    // 5) proactive contact notes on OPERATOR stage changes. sendReply resolves
    //    the channel adapter and sends -- the same path the dashboard uses for
    //    operator replies. Null-safe: agent transitions and opted-out contacts
    //    are skipped inside the notifier.
    // Composed, not replaced: the contact-notify hook plus a live-agent
    // eviction. src/agent/run-turn.js keeps one freddie agent handle per
    // `case:<id>`; a resolved/closed case will not take another turn, so its
    // agent is dropped here, and this runs FIRST so a notifier failure cannot
    // skip it.
    //
    // This is no longer the ONLY thing standing between the process and
    // unbounded growth, and the previous version of this comment said it was.
    // run-turn.js now also sweeps on an idle TTL, which matters because a case
    // that stays OPEN never reaches this hook at all -- that was the actual
    // leak, and closing a case was never what bounded it. The other half was
    // wrong too: a reopened case does NOT "just get a fresh one". An evicted
    // key must RESUME, because a plain create() against a live backend returns
    // an empty session and its next turn dies on an id collision.
    const notifyOnTransition = makeTransitionNotifier(this.store, this.sendReply.bind(this), { log: this.log })
    this.store.onTransition = async (ev) => {
      if (ev?.caseRow?.id && !isOpenCase({ status: ev.to })) disposeAgent(`case:${ev.caseRow.id}`)
      return notifyOnTransition(ev)
    }
    return this
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
    if (a?.send) await a.send({ to: caseDeliveryTarget(caseRow), text })
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
    let timer
    await Promise.race([
      Promise.all(pending),
      new Promise(resolve => { timer = setTimeout(() => { timedOut = true; resolve() }, timeoutMs) }),
    ])
    clearTimeout(timer)
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
      // A completed pass, stamped here rather than in the timer callback: a
      // pass that threw halfway is not a pass, and the sweep_stalled alert must
      // fire on a sweep that is being SCHEDULED and failing just as it does on
      // one whose timer has died. Real wall-clock (not the injectable `now`)
      // because the watch compares it against real wall-clock.
      this._lastSweepAt = Date.now()
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
  // the real operator_account table (people expected to cover); with no roster
  // there is no one to page about a gap, so the check no-ops. The event load is
  // bounded to open cases and only runs when at least one breaching case exists
  // (no breaches -> no gap regardless of replies), so a healthy quiet hour costs
  // one cheap case scan.
  async _checkCoverageGap(now = Date.now()) {
    if (!this._notifyBreach) return                 // no alert channel configured
    // Re-read the account table on every sweep pass (this only runs on the
    // periodic health interval, not a hot path) rather than a boot-frozen
    // snapshot, so an added/disabled account takes effect on the next sweep
    // with no worker restart -- same fix dashboard/server.js's getRoster()
    // already gets for free by reading live on every request.
    const roster = await rosterFromAccounts(this.store)
    if (!roster.length) return                      // no one expected to cover
    const allCases = await this.store.listCases({}, { limit: 10000 })
    // Same silent-truncation risk case-sweep.js's own fetch has: as the case
    // table grows past this cap, some genuinely-open breaching cases could
    // fall outside the fetched window and the coverage gap check would never
    // see them, with zero warning. Log loud so an operator can raise the cap.
    if (allCases.length >= 10000) this.log?.warn?.('[sweep] hit case-fetch cap in coverage-gap check; some cases may be unclassified', { fetched: allCases.length })
    const open = allCases.filter(isOpenCase)
    const breaching = open.filter(c => tagList(c).some(t => CASE_HEALTH_SET.has(t)))
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
      // Tracked in _inflight the same way startDrainPoll's own timer callback
      // is (see below) -- without this, drain()'s shutdown wait never saw a
      // sweep's own store writes in flight, letting stop() close the store
      // mid-write on this background path exactly like the drain-poll case.
      // A sweep failure must never crash the loop or wedge the process.
      const p = this.runSweepOnce().catch(e => this.log?.warn?.('[casey] sweep failed', { error: e.message }))
      this._inflight.add(p)
      p.finally(() => this._inflight.delete(p))
    }, intervalMs)
    // Do not keep the event loop alive solely for the sweep (clean test/CLI exit).
    this._sweepTimer.unref?.()
  }

  stopSweep() {
    if (this._sweepTimer) { clearInterval(this._sweepTimer); this._sweepTimer = null }
  }

  // Live LLM-backend status, resolved the same way drainQueuedTurns' own hard
  // status gate resolves it (resilient status first, then the injected
  // llmStatus, then callLLM.status). Null when this process was never given a
  // way to ask -- which is a MODE, not a fault, and must never raise an alert.
  async _llmStatus() {
    try {
      const statusFn = this.resilientStatus
        || this.opts.llmStatus
        || (typeof this.opts.callLLM?.status === 'function' ? this.opts.callLLM.status.bind(this.opts.callLLM) : null)
      return statusFn ? await statusFn() : null
    } catch { return null }
  }

  // The three system-level failures worth waking someone for, evaluated on one
  // clock and pushed through the SAME notifyBreach seam the per-case sweep and
  // the team coverage gap already use -- so with a webhook configured they page
  // the webhook, and with none configured they land in the alert log
  // (src/alert-log.js). Every one of them is a failure whose only symptom is
  // that nothing else has a symptom: the process is up, the dashboard renders,
  // and /api/ready reports them -- to a monitor that has to be polling.
  //
  // Each is gated through AlertGate, so a standing condition writes ONE line
  // when it starts and one when it clears, never one per tick. The rule is
  // case-sweep.js's "exactly one observation per newly-entered breach" and
  // detectCoverageGap's once-per-rising-edge page, made durable across a
  // restart.
  async _checkSystemAlerts(now = Date.now()) {
    if (!this._notifyBreach || !this._alertGate) return null
    const verdicts = []

    // 1. THE CHANNEL IS DEAF. A configured real-time channel that has never
    //    connected since start: casey is not hearing the field at all, while
    //    the process, the HTTP server and outbound send all stay healthy. Same
    //    signal /api/ready reports as gateway_not_receiving.
    const rs = this.receiveStatus(now)
    const deafChannels = Object.entries(rs.channels || {})
      .filter(([, v]) => v.state === 'never-connected')
      .map(([k]) => k)
    verdicts.push({
      condition: SYSTEM_CONDITIONS.CHANNEL_DEAF,
      active: rs.state === 'never-connected',
      detail: `casey is not hearing the field: channel ${deafChannels.join(', ') || 'unknown'} is configured but has never connected since start, so reports are arriving nowhere`,
    })

    // 2. THE PROVIDER IS DOWN AND MESSAGES ARE QUEUING. Both halves are
    //    required. A provider outage with an empty queue has cost nobody a
    //    reply yet (and casey self-heals), and a queue behind a healthy
    //    provider is already draining on its own -- neither is worth a page.
    //    Together they mean real people are waiting with nothing coming.
    const st = await this._llmStatus()
    const providerDown = !!st && (st.ok === false || st.source === 'none')
    let q = { pending: 0, deadLettered: 0 }
    try { q = await this.queueStatus() } catch { q = { pending: 0, deadLettered: 0 } }
    const backlog = (q.pending || 0) + (q.deadLettered || 0)
    verdicts.push({
      condition: SYSTEM_CONDITIONS.PROVIDER_DOWN_BACKLOG,
      active: providerDown && backlog > 0,
      detail: `the AI provider is not answering and ${q.pending || 0} message(s) are queued behind it (${q.deadLettered || 0} dead-lettered); contacts are waiting with no reply`,
    })

    // 3. THE GUARDRAIL SWEEP HAS STOPPED RUNNING. Only meaningful where the
    //    sweep is actually scheduled (a dashboard-only console never schedules
    //    it, which is a mode and not a fault -- casey doctor already says so).
    //    Measured off a COMPLETED pass, so a sweep whose timer still fires but
    //    whose passes keep throwing counts as stalled too. This watch runs on
    //    its own timer, deliberately: a check that lived inside the sweep could
    //    never notice the sweep not running.
    const interval = this.opts.sweepIntervalMs ?? 15 * 60e3
    const sweepScheduled = interval > 0 && this._sweepTimer != null
    const lastPassAt = this._lastSweepAt || this._startedAt
    // Three intervals, floored at 5 minutes: one missed pass is a slow store or
    // a long sweep, three in a row is not.
    const stallMs = Math.max(3 * interval, 5 * 60e3)
    const stalledFor = now - lastPassAt
    verdicts.push({
      condition: SYSTEM_CONDITIONS.SWEEP_STALLED,
      active: sweepScheduled && stalledFor > stallMs,
      detail: `the guardrail sweep has not completed a pass in ${Math.round(stalledFor / 60000)} minutes (it runs every ${Math.round(interval / 60000)}); stale, stuck and abandoned cases are going undetected`,
    })

    const fired = []
    for (const v of verdicts) {
      let edge = null
      try { edge = this._alertGate.evaluate(v.condition, v.active, now) }
      catch (e) { this.log?.warn?.('[casey] alert gate failed', { condition: v.condition, error: e.message }) }
      if (!edge) continue
      // A cleared line must NOT restate the raised line's sentence: that
      // sentence is rebuilt from the CURRENT state every tick, so by the time
      // the condition clears it describes a situation that is no longer true
      // ("channel unknown has never connected" once the channel connected).
      // Say what actually happened instead -- the condition ended, and how long
      // it stood.
      const detail = edge.edge === 'cleared'
        ? `${v.condition} has resolved; it stood for ${Math.round(edge.forMs / 60000)} minute(s)`
        : v.detail
      try {
        // No contact identifier: a synthetic 'SYSTEM' ref, the same shape
        // _checkCoverageGap uses for 'TEAM-COVERAGE'. There is no case behind
        // this alert to open, and there is nothing about a person in it.
        await this._notifyBreach({ ref: 'SYSTEM' }, v.condition, detail, { event: edge.edge, since: edge.since, forMs: edge.forMs, at: now })
        fired.push({ condition: v.condition, event: edge.edge })
      } catch (e) { this.log?.warn?.('[casey] system alert delivery failed', { condition: v.condition, error: e.message }) }
      if (edge.edge === 'raised') this.log?.error?.('[casey] system alert', { condition: v.condition, detail })
    }
    return { verdicts: verdicts.map(v => ({ condition: v.condition, active: v.active })), fired }
  }

  // Start (or restart) the system-condition watch. Its own timer, not a
  // piggyback on the sweep: one of the three conditions it reports IS the sweep
  // having stopped, and a check riding the stalled thing can never fire.
  // Opt-in the same way the sweep is -- a non-positive interval disables it --
  // and the handle is stored so stop() can clear it.
  startAlertWatch(intervalMs = this.opts.alertWatchIntervalMs ?? 60e3) {
    this.stopAlertWatch()
    if (!(intervalMs > 0)) return
    this._alertWatchTimer = setInterval(() => {
      // Tracked in _inflight like the sweep and drain-poll timers, so drain()
      // waits out a watch tick's own writes rather than letting stop() close
      // the store mid-scan on this background path.
      const p = this._checkSystemAlerts().catch(e => this.log?.warn?.('[casey] alert watch failed', { error: e.message }))
      this._inflight.add(p)
      p.finally(() => this._inflight.delete(p))
    }, intervalMs)
    this._alertWatchTimer.unref?.()
  }

  stopAlertWatch() {
    if (this._alertWatchTimer) { clearInterval(this._alertWatchTimer); this._alertWatchTimer = null }
  }

  // Periodic drain-poll. This timer is the ONLY thing that notices an LLM
  // recovery on its own: the brain's onRecover edge fires only from a real
  // callLLM/status() call (a NEW inbound on the SAME conversation, or a human
  // loading the dashboard health row), and the boot-time resumePendingTurns
  // sweep skips any case already tagged resume-exhausted. Without it, a contact
  // who was queued during an outage and does not write again -- the ordinary
  // case, since they are waiting for casey -- sits in silence indefinitely
  // after the backend is healthy. Keep the interval much shorter than the
  // 15-minute case-health sweep: it directly gates how long a real contact is
  // left with no reply. It costs nothing when healthy -- drainQueuedTurns is an
  // empty scan with nothing queued, and its own status-gate skips the work
  // entirely while the backend is still down.
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
    // Default-on: the system-condition watch (deaf channel, provider down with
    // a backlog, sweep stopped). Started AFTER startSweep so its own
    // sweepScheduled check sees the real timer state.
    if (this.opts.alertWatchIntervalMs !== 0) this.startAlertWatch()
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
    // unawaited during boot and an LLM recovery edge can fire drainQueuedTurns
    // in the same window; without one shared guard the two race on
    // appendEvent/case locks for the same msgId and double-drive it.
    if (this._draining) return { scanned: 0, resumed: 0, deferred: true }
    this._draining = true
    try {
      return await resumePendingTurnsBody(
        { store: this.store, log: this.log, gateway: this.gateway, adapters: this.adapters, handle },
        { maxCases, maxRedrives, spacingMs },
      )
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
    // Claim the shared guard SYNCHRONOUSLY, immediately after the check above
    // and before the first await below -- the Set-less equivalent of the
    // check-then-act atomicity hooks/handler.js's inFlight.has+inFlight.add
    // documents for its own per-contact claim. Setting it after the
    // status-probe `await statusFn()` instead opens a real TOCTOU window: two
    // concurrent calls (the drain-poll tick racing an LLM-recovery onRecover
    // edge, or two recovery edges close together) both pass the
    // `if (this._draining)` check before either sets it and both enter the
    // scan/redrive body -- the exact double-drive this guard exists to
    // prevent. Every exit path below, the degraded-status early return
    // included, is covered by the trailing finally that resets _draining, so
    // the guard is never left stuck true.
    this._draining = true
    try {
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
      return await this._drainQueuedTurnsBody({ maxCases, maxRedrives, retryCap })
    } finally {
      this._draining = false
    }
  }

  async _drainQueuedTurnsBody({ maxCases, maxRedrives, retryCap }) {
    return await drainQueuedTurnsBody(
      { store: this.store, log: this.log, gateway: this.gateway, adapters: this.adapters },
      { maxCases, maxRedrives, retryCap },
    )
  }

  // Read-only queue-depth check for the dashboard health panel: how many
  // messages are currently sitting in the LLM-down queue (QUEUED-FOR-AGENT
  // recorded, no completing outbound/draft/dead-letter yet) and how many have
  // been dead-lettered (queue-drive-failed, exhausted retryCap). Mirrors
  // drainQueuedTurns' own event-marker scan (see its comments for the exact
  // marker vocabulary) but never drives a turn -- this must be cheap enough to
  // call on every /api/health poll, so it is capped the same way (maxCases)
  // and never touches _draining (a concurrent real drain is unaffected).
  // Single cross-case query (thatcher's case_id $in, via listAllEvents) instead
  // of a listCases + one listEvents-per-case fan-out -- the fan-out was a real
  // measured N+1 (up to 1+maxCases round trips per call; this route is polled
  // on every /api/health and /api/health/provider read, so the redundant cost
  // was paid on every poll, not just once). Grouping the flat cross-case result
  // by case_id in JS below reproduces the exact same per-case, in-order marker
  // scan the old per-case loop did -- completedAfter is still evaluated only
  // against events within the SAME case, in the same created_at/insertion
  // order, so the queued/dead/pending classification is unchanged, just
  // computed from one round trip instead of many. Still a live read every call
  // (no caching) -- only the number of queries changed, not what is read.
  async queueStatus({ maxCases = 200 } = {}) {
    let pending = 0, deadLettered = 0, truncated = false
    try {
      const caseRows = await this.store.listCases({}, { limit: maxCases, offset: 0 })
      // rows are last_event_at DESC, so hitting the cap means a case that went
      // quiet after being queued (once maxCases other cases had newer activity)
      // silently fell out of this scan -- surface that instead of reporting an
      // undisclosed undercount, same discipline countCases() already documents.
      if (caseRows.length >= maxCases) truncated = true
      if (!caseRows.length) return { pending, deadLettered, truncated }
      const caseIds = caseRows.map(c => c.id)
      // Only the 4 event kinds the marker scan below ever inspects -- narrows
      // the single cross-case query instead of pulling every event kind for
      // every case (transitions, autonomy_change, etc. are never read here).
      const { rows: allEvents } = await this.store.listAllEvents(
        { caseIds, kind: { $in: ['inbound', 'outbound', 'draft', 'observation'] } },
        { limit: caseIds.length * 200 },
      )
      const byCase = new Map()
      for (const ev of allEvents) {
        if (!byCase.has(ev.case_id)) byCase.set(ev.case_id, [])
        byCase.get(ev.case_id).push(ev)
      }
      for (const events of byCase.values()) {
        // allEvents is newest-first (listAllEvents' own contract); the marker
        // scan below depends on oldest-first order within a case (a queued
        // marker must be seen before the outbound/draft that completes it).
        events.sort((a, b) => Number(a.created_at) - Number(b.created_at))
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
    return { pending, deadLettered, truncated }
  }

  // Quiet sweep: cases with no intake_mode tag and channel != 'web' get intake_mode:channel.
  async _backfillIntakeMode() {
    const PAGE = 200; let offset = 0; let tagged = 0
    for (;;) {
      const rows = await this.store.listCases({}, { limit: PAGE, offset })
      if (!rows.length) break
      for (const c of rows) {
        const tags = tagList(c)
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
    this.stopAlertWatch()
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
