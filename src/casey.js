

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
import { ensurePin, placeText } from './pin-estimate.js'
import { startQuotaWatch } from './quota-watch.js'
import { AlertLog, AlertGate, fileAlertNotifier, SYSTEM_CONDITIONS } from './alert-log.js'
import { ALL_HEALTH_TAGS } from './case-health.js'
import { mergeTag } from './hooks/heuristics.js'
import { caseDeliveryTarget, splitExternalId } from './hooks/handler.js'
import { disposeAgent } from './agent/run-turn.js'
import { applyDeliveryStatus, snapshotDeliveryStatus, countUndeliveredCases } from './delivery-status.js'
import { proactiveRefusal } from './proactive-sends.js'

const CASE_HEALTH_SET = new Set(ALL_HEALTH_TAGS)

async function rosterFromAccounts(store) {
  try {
    const { listAccounts } = await import('./dashboard/auth.js')
    const accounts = await listAccounts(store)
    return accounts.filter(a => a.disabled !== '1').map(a => ({ id: a.username, name: a.display_name || a.username }))
  } catch { return [] }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const CASEY_EXTRA_PLUGINS_DIR = (() => {
  if (!process.env.CASEY_EXTRA_PLUGINS_DIR) return null
  const dir = path.resolve(process.env.CASEY_EXTRA_PLUGINS_DIR)
  if (!fs.existsSync(dir)) throw new Error(`CASEY_EXTRA_PLUGINS_DIR not found: ${dir}`)
  return dir
})()

const SWEEP_ALERT_BREACHES = new Set(['unanswered_handoff', 'unanswered_handoff_escalated', 'incomplete_critical', 'abandoned_intake', 'never_closed'])

const ESCALATION_BREACHES = new Set(['unanswered_handoff_escalated'])

export class Casey {
  constructor(opts = {}) {
    this.opts = opts
    this.channels = opts.channels || []
    this.store = null
    this.gateway = null
    this.adapters = {}
    this._inflight = new Set()
    this._sweepTimer = null
    this._alertWatchTimer = null
    this._coverageGapActive = false

    this._lastSweepAt = null
    this._startedAt = Date.now()

    this.receiveHealth = {}
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

    this.store = createCaseStore({ config: this.opts.config, log: this.log })
    await this.store.init()
    setCaseStore(this.store)

    const handler = makeCaseHandler(this.store, {
      callLLM: this.opts.callLLM || null,

      llmStatus: this.opts.llmStatus || null,
      autoRespond: this.opts.autoRespond !== false,
      log: this.log,
      notifyHandoff: this.opts.notifyHandoff || discordHandoffNotifier(undefined, this.log),
    })

    this._isContactClaimed = handler.isClaimed || null
    this._wireAlerting()

    const platforms = {}
    for (const ch of this.channels) platforms[ch] = await makeChannelAdapter(ch, { log: this.log, store: this.store, dataDir: this.store.dataDir, markConnected: (c) => this._markConnected(c), markInbound: (c) => this._markInbound(c) })
    this.adapters = platforms
    this._wireDeliveryStatus()
    return this._initFreddieAndHooks(handler)
  }

  _wireDeliveryStatus() {
    const wa = this.adapters?.whatsapp
    if (!wa || typeof wa.on !== 'function') return
    wa.on('status', (st) => {
      const p = applyDeliveryStatus(this.store, st, { log: this.log, recentSends: wa.recentSends })
        .catch(e => this.log?.warn?.('[casey] delivery status could not be applied', { error: e?.message || String(e) }))
      this._inflight.add(p)
      p.finally(() => this._inflight.delete(p))
    })
  }

  whatsappStatus(now = Date.now()) {
    const a = this.adapters?.whatsapp
    if (!a) return null
    const r = this.receiveHealth.whatsapp || {}
    const lastIn = Math.max(r.lastInboundAt || 0, this._waStoredInboundAt || 0) || null
    const hours = this._inboundSilenceHours()
    return {
      configured: true,
      last_inbound_at: lastIn,
      silent_for_ms: lastIn ? now - lastIn : null,
      silence_alarm_hours: hours,
      webhook: { ...(a.webhookStats || {}) },
      delivery: { ...snapshotDeliveryStatus(), open_cases_undelivered: this._undeliveredCases ?? null },
    }
  }

  _inboundSilenceHours() {
    const raw = process.env.CASEY_INBOUND_SILENCE_HOURS
    if (raw === undefined || raw === '') return 24
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : 24
  }

  async _refreshStoredInbound(now) {
    if (this._waStoredAt && now - this._waStoredAt < 10 * 60e3) return
    this._waStoredAt = now
    try {
      const rows = await this.store.t.list('event', { kind: 'inbound', channel: 'whatsapp' }, { limit: 1, sort: [{ field: 'created_at', dir: 'DESC' }] })
      const ts = Number(rows[0]?.created_at)
      if (Number.isFinite(ts) && ts > 0) this._waStoredInboundAt = ts * 1000
    } catch {  }
  }

  async _otherSignalAt() {
    let newest = 0
    const bump = (v) => { const n = Number(v); if (Number.isFinite(n) && n > newest) newest = n }
    try {
      const { listAccounts } = await import('./dashboard/auth.js')
      for (const a of await listAccounts(this.store)) bump(tsMs(a.last_login_at))
    } catch {  }
    try {
      const ops = await this.store.t.list('event', { actor: 'operator' }, { limit: 1, sort: [{ field: 'created_at', dir: 'DESC' }] })
      if (ops[0]) bump(Number(ops[0].created_at) * 1000)
      const others = await this.store.t.list('event', { kind: 'inbound', channel: { $ne: 'whatsapp' } }, { limit: 1, sort: [{ field: 'created_at', dir: 'DESC' }] })
      if (others[0]) bump(Number(others[0].created_at) * 1000)
    } catch {  }
    return newest || null
  }

  _wireAlerting() {

    this._notifyBreach = this.opts.notifyBreach || breachNotifier(undefined, this.log)

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

    try { this._alertGate = new AlertGate({ dataDir: this.store.dataDir }) }
    catch (e) { this._alertGate = null; this.log?.warn?.('[casey] alert gate unavailable; system-condition alerts are off', { error: e.message }) }

    this._notifyEscalation = this.opts.notifyEscalation
      || breachNotifier(process.env.CASEY_ESCALATE_WEBHOOK, this.log)
      || this._notifyBreach
  }

  async _initFreddieAndHooks(handler) {

    const boundHandler = handler.bind(this)
    this.gateway = {
      handleInbound: (platform, msg) => boundHandler(platform, msg),

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

    const notifyOnTransition = makeTransitionNotifier(this.store, this.sendReply.bind(this), { log: this.log })
    this.store.onTransition = async (ev) => {
      if (ev?.caseRow?.id && !isOpenCase({ status: ev.to })) disposeAgent(`case:${ev.caseRow.id}`)
      return notifyOnTransition(ev)
    }
    return this
  }

  _wrapInflight() {
    const orig = this.gateway.handleInbound.bind(this.gateway)
    this.gateway.handleInbound = (platform, msg) => {
      const p = orig(platform, msg).finally(() => this._inflight.delete(p))
      this._inflight.add(p)

      p.catch(e => { this.log?.error?.('[casey] handleInbound rejected (unexpected -- should have been caught internally)', { error: e?.message || String(e) }) })
      return p
    }
  }

  async sendReply(caseRow, text) {
    const noStart = proactiveRefusal({})
    if (noStart) throw new Error(noStart)
    const a = this.adapters[caseRow.channel]
    if (a?.send) await a.send({ to: caseDeliveryTarget(caseRow), text })
  }

  receiveStatus(now = Date.now()) {
    const channels = {}
    let worst = 'ok'
    for (const ch of this.channels) {
      if (ch === 'web' || ch === 'whatsapp') continue
      const r = this.receiveHealth[ch] || {}
      const connected = r.connectedAt != null
      const sinceInboundMs = r.lastInboundAt != null ? now - r.lastInboundAt : null
      const sinceConnectMs = r.connectedAt != null ? now - r.connectedAt : null
      const state = connected ? 'ok' : 'never-connected'
      if (state === 'never-connected') worst = 'never-connected'
      channels[ch] = { state, connected, sinceConnectMs, sinceInboundMs }
    }
    const whatsapp = this.whatsappStatus(now)
    return { state: Object.keys(channels).length ? worst : 'none', channels, ...(whatsapp ? { whatsapp } : {}) }
  }

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

  async backfillPins(limit = 6) {
    const callLLM = this.opts.callLLM
    if (typeof callLLM !== 'function') return 0
    const rows = await this.store.listCases({}, { limit: 400 })
    let done = 0
    for (const c of rows) {
      if (done >= limit) break
      if (!placeText(c) || c.location_source === 'gps' || c.location_source === 'confirmed' || (c.lat != null && (!c.location_basis || c.location_basis === placeText(c)))) continue
      if (await ensurePin({ store: this.store, callLLM, log: this.log, caseId: c.id })) done++
    }
    return done
  }

  async runSweepOnce(now = Date.now()) {

    if (this._sweeping) return { scanned: 0, deferred: true }
    this._sweeping = true
    try {

      const notifyBreach = this._notifyBreach
        ? async (caseId, breach, detail) => {
            if (!SWEEP_ALERT_BREACHES.has(breach)) return
            const c = await this.store.getCase(caseId).catch(() => null)
            if (!c) return

            const notify = ESCALATION_BREACHES.has(breach) ? this._notifyEscalation : this._notifyBreach
            if (notify) await notify(c, breach, detail)
          }
        : null

      const thresholds = await this.store.resolveThresholds(this.opts.healthThresholds)
      const summary = await sweepCases(this.store, now, thresholds, { log: this.log, notifyBreach })

      await this.backfillPins().catch(e => this.log?.warn?.('[casey] pin backfill failed', { error: e.message }))

      this._lastSweepAt = Date.now()

      try { this._lastSweepSummary = await this.store.recordSweepSummary(summary, now) }
      catch (e) { this.log?.warn?.('[casey] fleet-health persist failed', { error: e.message }) }

      try { await this._checkCoverageGap(now) }
      catch (e) { this.log?.warn?.('[casey] coverage-gap check failed', { error: e.message }) }
      return summary
    } finally { this._sweeping = false }
  }

  async _checkCoverageGap(now = Date.now()) {
    if (!this._notifyBreach) return

    const roster = await rosterFromAccounts(this.store)
    if (!roster.length) return
    const allCases = await this.store.listCases({}, { limit: 10000 })

    if (allCases.length >= 10000) this.log?.warn?.('[sweep] hit case-fetch cap in coverage-gap check; some cases may be unclassified', { fetched: allCases.length })
    const open = allCases.filter(isOpenCase)
    const breaching = open.filter(c => tagList(c).some(t => CASE_HEALTH_SET.has(t)))
    if (!breaching.length) {
      await this._coverageEdge(false, null, now)
      return
    }

    const eventsByCaseId = new Map()
    for (const c of breaching) eventsByCaseId.set(c.id, await this.store.listEvents(c.id).catch(() => []))
    const { detectCoverageGap } = await import('./case-sweep.js')
    const verdict = detectCoverageGap(open, eventsByCaseId, roster, now)
    await this._coverageEdge(verdict.gap, verdict, now)
    return verdict
  }

  async _coverageEdge(gap, verdict, now) {
    let edge = null
    if (this._alertGate) {
      try { edge = this._alertGate.evaluate('coverage_gap', !!gap, now) }
      catch (e) { this.log?.warn?.('[casey] alert gate failed', { condition: 'coverage_gap', error: e.message }) }
    } else if (gap && !this._coverageGapActive) { this._coverageGapActive = true; edge = { edge: 'raised', since: now, forMs: 0 } }
    else if (!gap) this._coverageGapActive = false
    if (!edge) return

    const detail = edge.edge === 'cleared'
      ? `coverage_gap has resolved; it stood for ${Math.round(edge.forMs / 60000)} minute(s)`
      : (verdict?.reason || 'coverage_gap')
    try { await this._notifyBreach({ ref: 'TEAM-COVERAGE' }, 'coverage_gap', detail, { event: edge.edge, since: edge.since, forMs: edge.forMs, at: now }) }
    catch (e) { this.log?.warn?.('[casey] coverage-gap page failed', { error: e.message }) }
    if (edge.edge === 'raised') this.log?.warn?.('[casey] coverage gap', { open_breaches: verdict?.open_breaches, roster_size: verdict?.roster_size })
  }

  startSweep(intervalMs = this.opts.sweepIntervalMs ?? 15 * 60e3) {
    this.stopSweep()
    if (!(intervalMs > 0)) return
    this._sweepTimer = setInterval(() => {

      const p = this.runSweepOnce().catch(e => this.log?.warn?.('[casey] sweep failed', { error: e.message }))
      this._inflight.add(p)
      p.finally(() => this._inflight.delete(p))
    }, intervalMs)

    this._sweepTimer.unref?.()
  }

  stopSweep() {
    if (this._sweepTimer) { clearInterval(this._sweepTimer); this._sweepTimer = null }
  }

  async _llmStatus() {
    try {
      const statusFn = this.resilientStatus
        || this.opts.llmStatus
        || (typeof this.opts.callLLM?.status === 'function' ? this.opts.callLLM.status.bind(this.opts.callLLM) : null)
      return statusFn ? await statusFn() : null
    } catch { return null }
  }

  async _checkSystemAlerts(now = Date.now()) {
    if (!this._notifyBreach || !this._alertGate) return null
    const verdicts = []

    const rs = this.receiveStatus(now)
    const deafChannels = Object.entries(rs.channels || {})
      .filter(([, v]) => v.state === 'never-connected')
      .map(([k]) => k)
    verdicts.push({
      condition: SYSTEM_CONDITIONS.CHANNEL_DEAF,
      active: rs.state === 'never-connected',
      detail: `casey is not hearing the field: channel ${deafChannels.join(', ') || 'unknown'} is configured but has never connected since start, so reports are arriving nowhere`,
    })

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

    const interval = this.opts.sweepIntervalMs ?? 15 * 60e3
    const sweepScheduled = interval > 0 && this._sweepTimer != null
    const lastPassAt = this._lastSweepAt || this._startedAt

    const stallMs = Math.max(3 * interval, 5 * 60e3)
    const stalledFor = now - lastPassAt
    verdicts.push({
      condition: SYSTEM_CONDITIONS.SWEEP_STALLED,
      active: sweepScheduled && stalledFor > stallMs,
      detail: `the guardrail sweep has not completed a pass in ${Math.round(stalledFor / 60000)} minutes (it runs every ${Math.round(interval / 60000)}); stale, stuck and abandoned cases are going undetected`,
    })

    const waHours = this.adapters?.whatsapp ? this._inboundSilenceHours() : 0
    if (waHours > 0) {
      const silenceMs = waHours * 3600e3
      await this._refreshStoredInbound(now)
      const r = this.receiveHealth.whatsapp || {}
      const baseline = Math.max(r.lastInboundAt || 0, this._waStoredInboundAt || 0) || this._startedAt
      const other = await this._otherSignalAt()
      const silent = now - baseline > silenceMs
      const alive = other != null && now - other < silenceMs
      verdicts.push({
        condition: SYSTEM_CONDITIONS.INBOUND_SILENT,
        active: silent && alive,
        detail: `WhatsApp is configured but no inbound message has arrived for ${Math.round((now - baseline) / 3600e3)} hours while the dashboard or other channels are in use. If people are messaging, Meta is not delivering: in the Meta developer console open WhatsApp -> Configuration -> Webhook fields and make sure "messages" is subscribed and the callback URL matches; run casey doctor to check.`,
      })
    }

    try { this._undeliveredCases = await countUndeliveredCases(this.store) } catch {  }

    const fired = []
    for (const v of verdicts) {
      let edge = null
      try { edge = this._alertGate.evaluate(v.condition, v.active, now) }
      catch (e) { this.log?.warn?.('[casey] alert gate failed', { condition: v.condition, error: e.message }) }
      if (!edge) continue

      const detail = edge.edge === 'cleared'
        ? `${v.condition} has resolved; it stood for ${Math.round(edge.forMs / 60000)} minute(s)`
        : v.detail
      try {

        await this._notifyBreach({ ref: 'SYSTEM' }, v.condition, detail, { event: edge.edge, since: edge.since, forMs: edge.forMs, at: now })
        fired.push({ condition: v.condition, event: edge.edge })
      } catch (e) { this.log?.warn?.('[casey] system alert delivery failed', { condition: v.condition, error: e.message }) }
      if (edge.edge === 'raised') this.log?.error?.('[casey] system alert', { condition: v.condition, detail })
    }
    return { verdicts: verdicts.map(v => ({ condition: v.condition, active: v.active })), fired }
  }

  startAlertWatch(intervalMs = this.opts.alertWatchIntervalMs ?? 60e3) {
    this.stopAlertWatch()
    if (!(intervalMs > 0)) return
    this._alertWatchTimer = setInterval(() => {

      const p = this._checkSystemAlerts().catch(e => this.log?.warn?.('[casey] alert watch failed', { error: e.message }))
      this._inflight.add(p)
      p.finally(() => this._inflight.delete(p))
    }, intervalMs)
    this._alertWatchTimer.unref?.()
  }

  stopAlertWatch() {
    if (this._alertWatchTimer) { clearInterval(this._alertWatchTimer); this._alertWatchTimer = null }
  }

  startDrainPoll(intervalMs = this.opts.drainPollIntervalMs ?? 60 * 1000) {
    this.stopDrainPoll()
    if (!(intervalMs > 0)) return
    this._drainPollTimer = setInterval(() => {

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

    if (this.opts.sweepIntervalMs !== 0) this.startSweep()

    this._stopQuotaWatch = startQuotaWatch({ log: this.log })

    if (this.opts.drainPollIntervalMs !== 0) this.startDrainPoll()

    if (this.opts.alertWatchIntervalMs !== 0) this.startAlertWatch()

    this._backfillIntakeMode().catch(e => this.log?.warn?.('[casey] intake_mode backfill failed', { error: e.message }))

    this._resumeSweepPromise = this.resumePendingTurns().catch(e => this.log?.warn?.('[casey] resume sweep failed', { error: e.message }))
  }

  async resumePendingTurns({ maxCases = 200, maxRedrives = Number(process.env.CASEY_RESUME_MAX_REDRIVES) || 10, spacingMs = Number(process.env.CASEY_RESUME_SPACING_MS) || 2000 } = {}) {
    if (this.opts.resumeOnBoot === false) return { scanned: 0, resumed: 0 }
    const handle = this.gateway?.handleInbound
    if (typeof handle !== 'function') return { scanned: 0, resumed: 0 }

    if (this._draining) return { scanned: 0, resumed: 0, deferred: true }
    this._draining = true
    try {
      return await resumePendingTurnsBody(
        { store: this.store, log: this.log, gateway: this.gateway, adapters: this.adapters, handle, isClaimed: this._isContactClaimed },
        { maxCases, maxRedrives, spacingMs },
      )
    } finally { this._draining = false }
  }

  async drainQueuedTurns({ maxCases = 200, maxRedrives = 50, retryCap = 5 } = {}) {
    if (this._draining) return { scanned: 0, drained: 0, deferred: true }
    const handle = this.gateway?.handleInbound
    if (typeof handle !== 'function') return { scanned: 0, drained: 0 }

    this._draining = true
    try {

      try {
        const statusFn = this.resilientStatus
          || this.opts.llmStatus
          || (typeof this.opts.callLLM?.status === 'function' ? this.opts.callLLM.status.bind(this.opts.callLLM) : null)
        const st = statusFn ? await statusFn() : null
        if (st && st.ok === false) {

          this.log?.info?.('[casey] queue drain skipped (backend degraded)', { source: st.source, degraded: st.degraded })
          return { scanned: 0, drained: 0, degraded: true }
        }
      } catch {  }
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

  async queueStatus({ maxCases = 200 } = {}) {
    let pending = 0, deadLettered = 0, truncated = false
    try {
      const caseRows = await this.store.listCases({}, { limit: maxCases, offset: 0 })

      if (caseRows.length >= maxCases) truncated = true
      if (!caseRows.length) return { pending, deadLettered, truncated }
      const caseIds = caseRows.map(c => c.id)

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

  async stop() {
    this.stopSweep()
    try { this._stopQuotaWatch?.() } catch {  }
    this.stopDrainPoll()
    this.stopAlertWatch()

    for (const a of Object.values(this.adapters || {})) a?.beginDrain?.()
    for (const a of Object.values(this.adapters || {})) { try { await a?.drainMedia?.() } catch {  } }
    await this.gateway?.stop()

    await this._resumeSweepPromise?.catch(() => {})
    try { await this.drain() } catch {  }
    await this.store?.close()
    resetCaseStore()
  }
}

export async function createCasey(opts) {
  const c = new Casey(opts)
  await c.init()

  if (!c.resilientStatus && opts?.llmStatus) c.resilientStatus = opts.llmStatus
  return c
}

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
