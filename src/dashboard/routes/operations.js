import { tagList, parseReport } from '../../timestamp.js'
import { snapshotDroppedIntake } from '../../hooks/dropped-intake.js'
import { snapshotStt } from '../../stt/metrics.js'
import { calculateDegradationRate } from '../../degraded-turns.js'
import { REPORT_ENTITY_LABEL, REPORT_SECTIONS, CRITICAL_FIELDS, SEVERITY_SIGNAL_FIELDS, fieldLabel, DASHBOARD_UI, TIER_LABELS, MANDATORY_MINIMUM_FIELDS, MANDATORY_MINIMUM_BLOCKED_STATUSES, FIELD_OPTIONS, hiddenFieldsFor, SYSTEM_SET_FIELDS } from '../../store/report-shape.js'
import { KNOWN_VALUE_FIELDS, isKnownValueField, readKnownValues, canonicalizeFieldValue } from '../../field-values.js'
import { mountRoutes } from './register.js'
import { assigneeNamer } from '../assignee-names.js'

const SWEEP_DEFAULT_INTERVAL_MS = 15 * 60 * 1000

const LLM_HEALTH_VIEWS = {
  acptoapi: { ok: true, label: 'AI helper: online', detail: 'Auto-replies are on. Contacts get an instant answer.' },
  none: { ok: false, label: 'AI helper: offline', detail: 'Auto-replies are paused. No message is sent; messages queue and re-drive once the provider recovers.' },
  unknown: { ok: false, label: 'AI helper: no answer yet', detail: 'The provider check has not come back, so whether auto-replies are working is not known yet. It usually resolves within a minute of start-up.' },
  unwired: { ok: false, label: 'AI helper: not visible in dashboard-only mode', detail: 'This console was started with `casey dashboard`, which reads and edits the store but is not attached to the running agent. It cannot see the AI helper, the message channels, the queued-message counts or the supervisor state, it cannot run a sweep, and a reply typed here is recorded on the timeline but NOT sent to the contact. All of that keeps working wherever `casey up` is running. Everything on this screen that reads the store is unaffected.' },
}

export const RUNTIME_STATES = new Set(['booting', 'healthy', 'restarting', 'degraded', 'stopping', 'stopped', 'standalone'])
const RUNTIME_LABELS = {
  booting: 'Runtime: starting', healthy: 'Runtime: healthy', restarting: 'Runtime: restarting',
  degraded: 'Runtime: degraded -- needs attention', stopping: 'Runtime: stopping', stopped: 'Runtime: stopped',
  standalone: 'Runtime: running', unknown: 'Runtime: unknown',
}

const ACTIVITY_KINDS = new Set(['inbound', 'outbound', 'transition', 'observation', 'note', 'action', 'autonomy_change'])
const DEFAULT_ACTORS = ['agent', 'operator', 'contact', 'system']

const resolve = async (v) => (typeof v === 'function' ? await v() : v)

export function llmHealthView(s) {
  const view = LLM_HEALTH_VIEWS[s.source] || LLM_HEALTH_VIEWS.unknown
  if (!view.ok || !s.degraded) return view
  const secs = Number.isFinite(s.lastMs) ? Math.round(s.lastMs / 1000) : null
  return {
    ok: false,
    label: 'AI helper: slow',
    detail: secs != null
      ? `Auto-replies are working but the AI helper is slow (last turn ${secs}s). Contacts may wait. Check the provider.`
      : 'Auto-replies are working but the AI helper is slow. Contacts may wait. Check the provider.',
  }
}

async function whatsappView(receiveStatus) {
  try {
    const rs = await resolve(receiveStatus)
    return rs && rs.whatsapp ? rs.whatsapp : null
  } catch { return null }
}

async function gatewayView(receiveStatus) {
  try {
    const rs = await resolve(receiveStatus)
    if (!rs || !rs.state || rs.state === 'none') return null
    const deaf = rs.state === 'never-connected'
    return {
      ok: !deaf,
      state: rs.state,
      label: deaf ? 'Messages: not connected' : 'Messages: connected',
      detail: deaf
        ? 'A message channel is not receiving. Contacts may be sending with no reply. Restart casey or check the connection.'
        : 'casey is connected and listening for messages.',
      channels: rs.channels || {},
    }
  } catch { return null }
}

function alertWebhookView(alertWebhookUrl, getWebhookDeliveryStatus) {
  if (!alertWebhookUrl) return { configured: false, ok: null, last_attempt_at: null, last_error: null }
  const ds = getWebhookDeliveryStatus(alertWebhookUrl)
  return ds
    ? { configured: true, ok: ds.ok, last_attempt_at: ds.lastAttemptAt, last_error: ds.ok ? null : ds.lastError }
    : { configured: true, ok: null, last_attempt_at: null, last_error: null }
}

export function getHealth({ store, llmStatus, receiveStatus, queueStatus, runSweep, sendReply, runtimeStatus, getWebhookDeliveryStatus, alertWebhookUrl }) {
  return async (req, res) => {
    const wired = llmStatus != null
    const s = (wired ? await resolve(llmStatus) : null) || { source: wired ? 'unknown' : 'unwired' }
    const view = llmHealthView(s)
    const model = s.model ? String(s.model).slice(0, 100) : null
    const url = s.url ? String(s.url).slice(0, 200) : null
    const gateway = await gatewayView(receiveStatus)
    const whatsapp = await whatsappView(receiveStatus)
    let queue = null
    try {
      const qs = typeof queueStatus === 'function' ? await queueStatus() : null
      if (qs) queue = { pending: qs.pending || 0, dead_lettered: qs.deadLettered || 0, truncated: !!qs.truncated }
    } catch { queue = null }
    let degradationRate = null
    try {
      degradationRate = await calculateDegradationRate(store, { hours: 1 })
    } catch {  }
    res.json({
      ...view, source: s.source, model, url, degraded: !!s.degraded,
      last_turn_ms: Number.isFinite(s.lastMs) ? s.lastMs : null,
      gateway, whatsapp, queue,
      capabilities: {
        llm: wired,
        receive: receiveStatus != null,
        queue: queueStatus != null,
        sweep: runSweep != null,
        reply: sendReply != null,
        runtime: runtimeStatus != null,
      },
      alert_webhook: alertWebhookView(alertWebhookUrl, getWebhookDeliveryStatus),
      degradation_rate: degradationRate,
      dropped_inbound: snapshotDroppedIntake(),
      stt: snapshotStt(),
    })
  }
}

export function getHealthProvider({ authed, llmStatus, queueStatus }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const wired = llmStatus != null
    let s = null
    if (wired) { try { s = await resolve(llmStatus) } catch { s = null } }
    s = s || { source: wired ? 'unknown' : 'unwired' }
    const status = s.source === 'acptoapi' ? (s.degraded ? 'degraded' : 'up') : (s.source === 'none' ? 'down' : (s.source === 'unwired' ? 'not_visible' : 'unknown'))
    let queued_turn_count = 0
    let dead_lettered_count = 0
    let queue_truncated = false
    try {
      const qs = typeof queueStatus === 'function' ? await queueStatus() : null
      if (qs) {
        queued_turn_count = Number.isFinite(qs.pending) ? qs.pending : 0
        dead_lettered_count = Number.isFinite(qs.deadLettered) ? qs.deadLettered : 0
        queue_truncated = !!qs.truncated
      }
    } catch {  }
    res.json({
      status,
      source: s.source || 'unknown',
      model: s.model ? String(s.model).slice(0, 100) : null,
      degraded: !!s.degraded,
      last_turn_ms: Number.isFinite(s.lastMs) ? s.lastMs : null,
      recent_slow_count: Number.isFinite(s.recentSlow) ? s.recentSlow : 0,
      queued_turn_count,
      dead_lettered_count,
      queue_truncated,
    })
  }
}

async function sweepStatusView(store) {
  const idle = {
    ok: true, last_run_at: null, interval_ms: SWEEP_DEFAULT_INTERVAL_MS, next_run_at: null,
    scanned: 0, flagged: 0, cleared: 0, errors: 0,
  }
  try {
    const fleetHealth = await store.getFleetHealth(1)
    const summary = fleetHealth?.latest
    if (!summary) return idle
    return {
      ok: !summary.degraded,
      last_run_at: summary.ts || null,
      interval_ms: SWEEP_DEFAULT_INTERVAL_MS,
      next_run_at: summary.ts ? summary.ts + SWEEP_DEFAULT_INTERVAL_MS : null,
      scanned: summary.scanned || 0,
      flagged: summary.flagged || 0,
      cleared: summary.cleared || 0,
      errors: summary.errors ? (Array.isArray(summary.errors) ? summary.errors.length : 0) : 0,
    }
  } catch { return idle }
}

export function getHealthCases({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const { classifyCaseHealth } = await import('../../case-health.js')
    const now = Date.now()
    const thresholds = await store.resolveThresholds()
    const openCases = (await store.listCases({}, { limit: 10000 }))
      .filter(c => c.status !== 'closed' && c.channel !== 'system')
    const named = await assigneeNamer(store, openCases)
    const cases = openCases.map(c => ({
      id: c.id,
      ref: c.ref,
      status: c.status,
      tags: tagList(c).join(','),
      assignee: named(c.assignee || ''),
      breaches: classifyCaseHealth(c, now, thresholds),
      updated_at: c.updated_at || c.created_at,
    })).filter(c => c.breaches.length > 0)
    const byOperatorMap = new Map()
    for (const c of cases) {
      const key = c.assignee || 'unassigned'
      if (!byOperatorMap.has(key)) byOperatorMap.set(key, { operator: key, case_count: 0, breach_count: 0 })
      const entry = byOperatorMap.get(key)
      entry.case_count += 1
      entry.breach_count += c.breaches.length
    }
    const byOperator = [...byOperatorMap.values()].sort((a, b) => b.breach_count - a.breach_count)
    const healthCaseCount = cases.length
    const label = healthCaseCount === 0
      ? 'Cases: all healthy'
      : healthCaseCount === 1
        ? 'Cases: 1 needs attention'
        : `Cases: ${healthCaseCount} need attention`
    res.json({
      ok: healthCaseCount === 0,
      label,
      detail: healthCaseCount === 0
        ? 'No cases are breaching guardrails. The team is keeping up.'
        : `${healthCaseCount} open case(s) are stale, stuck, or waiting for team action.`,
      sweep: await sweepStatusView(store),
      case_count: healthCaseCount,
      cases,
      by_operator: byOperator,
    })
  }
}

export function getRuntime({ authed, runtimeStatus }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const s = await resolve(runtimeStatus)
    if (!s) return res.json({ state: 'standalone', supervised: false, label: 'Runtime: running', ok: true })
    const state = String(s.state || 'unknown').slice(0, 32)
    const safeState = RUNTIME_STATES.has(state) ? state : 'unknown'
    const ok = safeState === 'healthy' || safeState === 'standalone'
    res.json({
      state: safeState, supervised: true, ok, label: RUNTIME_LABELS[safeState],
      restarts: Number.isFinite(s.restarts) ? s.restarts : 0,
      lastReloadAt: s.lastReloadAt != null ? Number(s.lastReloadAt) : null,
      lastCrashReason: s.lastCrashReason ? String(s.lastCrashReason).slice(0, 300) : null,
      since: s.since != null ? Number(s.since) : null,
    })
  }
}

export function getConfig({ store, authed, SAST_TZ, resolveWhatsappAdapter, fmtPhone27 }) {
  return (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    let botNumber = ''
    try { botNumber = fmtPhone27(resolveWhatsappAdapter?.()?.displayNumber?.() || '') } catch {  }
    res.json({
      whatsapp_number: req.caseyAccount?.role === 'viewer' ? '' : botNumber,
      run_routes: !!process.env.CASEY_EXTRA_DASHBOARD_ROUTES,
      stages: store.getValidStatuses(),
      open_stages: typeof store.getOpenStatuses === 'function' ? store.getOpenStatuses() : [],
      case_type: typeof store.getFieldEnum === 'function' ? store.getFieldEnum('case.case_type', []) : [],
      priority: typeof store.getFieldEnum === 'function' ? store.getFieldEnum('case.priority', []) : [],
      tz: SAST_TZ,
      tz_label: process.env.CASEY_TZ_LABEL || (process.env.CASEY_TZ ? '' : 'SAST'),
      country_code: (process.env.CASEY_COUNTRY_CODE || '27').replace(/\D/g, '') || '27',
      entity_label: REPORT_ENTITY_LABEL,
      report_sections: REPORT_SECTIONS.map(sec => ({ ...sec, keys: sec.keys.filter(([k]) => !SYSTEM_SET_FIELDS.has(k)) })).filter(sec => sec.keys.length),
      system_set_fields: [...SYSTEM_SET_FIELDS],
      visit_critical: CRITICAL_FIELDS.map(k => ({ key: k, label: fieldLabel(k) })),
      severity_signal_fields: SEVERITY_SIGNAL_FIELDS.map(k => ({ key: k, label: fieldLabel(k) })),
      known_value_fields: KNOWN_VALUE_FIELDS.map(k => ({ key: k, label: fieldLabel(k) })),
      mandatory_minimum: { fields: MANDATORY_MINIMUM_FIELDS.map(k => ({ key: k, label: fieldLabel(k) })), blocks_transition_to: MANDATORY_MINIMUM_BLOCKED_STATUSES },
      dashboard_ui: DASHBOARD_UI,
      field_options: FIELD_OPTIONS,
      hidden_fields: hiddenFieldsFor(req.caseyAccount?.role),
      tier_labels: TIER_LABELS,
    })
  }
}

const ATTENTION_OPEN_TTL_MS = 5000
const attentionOpenMemo = new WeakMap()

function openCasesMemo(store, isOpenCase) {
  const hit = attentionOpenMemo.get(store)
  if (hit && Date.now() - hit.at < ATTENTION_OPEN_TTL_MS) return hit.promise
  const promise = store.listCases({}, { limit: 10000 }).then((rows) => rows.filter(isOpenCase)).catch((e) => {
    attentionOpenMemo.delete(store)
    throw e
  })
  attentionOpenMemo.set(store, { at: Date.now(), promise })
  return promise
}

export function getAttention({ store, authed, isOpenCase, rankAttention }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const { classifyCaseHealth } = await import('../../case-health.js')
    const now = Date.now()
    const thresholds = await store.resolveThresholds()
    const open = await openCasesMemo(store, isOpenCase)
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500)
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0)
    const { total, items, atRisk, slaTargetMs } = rankAttention(open, now, { limit, offset })
    const named = await assigneeNamer(store, items, (x) => x.c.assignee)
    const cases = items.map(({ c, score, reason, waitMs }) => ({
      id: c.id, ref: c.ref, subject: c.subject || '', channel: c.channel,
      status: c.status, updated_at: c.updated_at || c.created_at,
      assignee: named(c.assignee || ''),
      wait_ms: waitMs == null ? null : waitMs,
      score, reason, breaches: classifyCaseHealth(c, now, thresholds),
      had_degraded_turn: tagList(c).includes('degraded-turn-seen'),
    }))
    res.json({ count: cases.length, total, limit, offset, at_risk: atRisk, sla_target_ms: slaTargetMs, cases })
  }
}

export function getSecretaryQueue({ store, authed, isOpenCase, rankAttention }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const { classifyCaseHealth } = await import('../../case-health.js')
    const { normalizeLocation } = await import('../../location-normalize.js')
    const now = Date.now()
    const thresholds = await store.resolveThresholds()
    const open = (await store.listCases({}, { limit: 10000 })).filter(isOpenCase)
    const { items } = rankAttention(open, now, { limit: 10000, offset: 0 })
    const me = req.caseyAccount?.username || ''
    const filter = req.query.assignee === 'me' ? 'me' : req.query.assignee === 'unassigned' ? 'unassigned' : 'all'
    const filtered = items.filter(({ c }) => {
      if (filter === 'me') return c.assignee === me
      if (filter === 'unassigned') return !c.assignee
      return true
    })
    const groups = new Map()
    const named = await assigneeNamer(store, filtered, (x) => x.c.assignee)
    for (const { c, score, reason, waitMs } of filtered) {
      let report = parseReport(c)
      const place = normalizeLocation(report.location) || 'unresolved'
      if (!groups.has(place)) groups.set(place, [])
      groups.get(place).push({
        id: c.id, ref: c.ref, subject: c.subject || '', channel: c.channel,
        status: c.status, updated_at: c.updated_at || c.created_at,
        assignee: named(c.assignee || ''),
        wait_ms: waitMs == null ? null : waitMs,
        score, reason, breaches: classifyCaseHealth(c, now, thresholds),
      })
    }
    const places = [...groups.entries()]
      .map(([place, cases]) => ({ place, count: cases.length, cases }))
      .sort((a, b) => b.count - a.count)
    res.json({ total: filtered.length, filter, places })
  }
}

export function getSlaAtRiskByType({ store, authed, isOpenCase }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const { atRiskCount } = await import('../../attn.js')
    const now = Date.now()
    const thresholds = await store.resolveThresholds()
    const slaTargetMs = Number.isFinite(thresholds?.handoffMs) ? thresholds.handoffMs : 30 * 60 * 1000
    const open = (await store.listCases({}, { limit: 10000 })).filter(isOpenCase)
    const byType = {}
    const groups = new Map()
    for (const c of open) {
      const t = c.case_type || 'unset'
      if (!groups.has(t)) groups.set(t, [])
      groups.get(t).push(c)
    }
    for (const [t, slice] of groups) byType[t] = atRiskCount(slice, now, slaTargetMs)
    const total = atRiskCount(open, now, slaTargetMs)
    res.json({ by_type: byType, total, sla_target_ms: slaTargetMs })
  }
}

export function getThresholds({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const { mergeThresholds, THRESHOLD_KEYS } = await import('../../thresholds.js')
    const patch = await store.getThresholdsPatch()
    const effective = patch ? mergeThresholds(patch).thresholds : (await import('../../case-health.js')).DEFAULT_THRESHOLDS
    res.json({ thresholds: effective, customized: !!patch, keys: THRESHOLD_KEYS })
  }
}

export function putThresholds({ store, authed, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const { mergeThresholds } = await import('../../thresholds.js')
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const { thresholds, applied, rejected } = mergeThresholds(body)
    if (!applied.length) {
      return res.status(400).json({ error: 'no valid threshold keys in patch', rejected })
    }
    const accepted = {}
    for (const k of applied) {
      if (k.startsWith('stageMaxDwellMs.')) {
        const sk = k.slice('stageMaxDwellMs.'.length)
        accepted.stageMaxDwellMs = accepted.stageMaxDwellMs || {}
        accepted.stageMaxDwellMs[sk] = thresholds.stageMaxDwellMs[sk]
      } else {
        accepted[k] = thresholds[k]
      }
    }
    await store.setThresholdsPatch(accepted, actingOperator(req))
    const effective = await store.resolveThresholds()
    res.json({ ok: true, thresholds: effective, applied, rejected })
  }
}

export function postSweep({ authed, runSweep }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    if (!runSweep) return res.status(501).json({ error: 'sweep not available in this mode' })
    const result = await runSweep()
    res.json({ ok: true, scanned: result?.scanned ?? null, flagged: result?.flagged ?? null, cleared: result?.cleared ?? null })
  }
}

export function getClusters({ store, authed, isOpenCase }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const { buildClusters } = await import('../../clusters.js')
    const pool = (await store.listCases({}, { limit: 500 }))
      .filter(c => isOpenCase(c) && !tagList(c).includes('merged'))
    const clusters = buildClusters(pool)
    res.json({ pool: pool.length, count: clusters.length, clusters })
  }
}

export function getGeo({ store, authed, isOpenCase }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const { buildGeo } = await import('../../geo.js')
    const open = (await store.listCases({}, { limit: 10000 })).filter(isOpenCase)
    res.json({ open: open.length, places: buildGeo(open) })
  }
}

export function getDistribution({ store, authed, isOpenCase }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const { buildSymptomDistribution } = await import('../../distribution.js')
    const since = req.query.since ? Number(req.query.since) : null
    if (req.query.since && !Number.isFinite(since)) return res.status(400).json({ error: 'since must be a unix-seconds number' })
    const open = (await store.listCases({}, { limit: 10000 })).filter(isOpenCase)
    res.json(buildSymptomDistribution(open, { since }))
  }
}

export function getActivity({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const ACTORS = new Set(
      typeof store.getFieldEnum === 'function' && store.getFieldEnum('event.actor', []).length
        ? store.getFieldEnum('event.actor', [])
        : DEFAULT_ACTORS)
    const kind = ACTIVITY_KINDS.has(req.query.kind) ? req.query.kind : null
    const actor = ACTORS.has(req.query.actor) ? req.query.actor : null
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500)
    const since = parseInt(req.query.since, 10) || 0
    let { rows, truncated } = await store.listAllEvents({ kind, actor }, { limit: limit + (since ? 500 : 0) })
    if (since) rows = rows.filter(e => Number(e.created_at) * 1000 >= since)
    const system = new Set((await store.listCases({ channel: 'system' }, { limit: 50 })).map(c => c.id))
    if (system.size) rows = rows.filter(e => !system.has(e.case_id))
    const events = rows.slice(0, limit).map(e => ({
      id: e.id, case_id: e.case_id, kind: e.kind, actor: e.actor,
      text: e.text || '', created_at: e.created_at,
    }))
    res.json({ count: events.length, kind, actor, events, truncated })
  }
}

export function getDegradedTurns({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const { evData } = await import('../../safe.js')
    const since = req.query.since ? Number(req.query.since) : (Date.now() - 3600_000)
    if (!Number.isFinite(since)) return res.status(400).json({ error: 'since must be a unix-ms number' })
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000)
    const { rows, truncated } = await store.listAllEvents({ kind: 'observation', actor: 'system' }, { limit: Math.max(limit * 4, 800) })
    const windowed = rows.filter(e => Number(e.created_at) * 1000 >= since)
    const parsed = windowed.map(e => ({ e, d: evData(e) }))
    const degraded = parsed
      .filter(({ d }) => d.degraded_turn === true)
      .slice(0, limit)
      .map(({ e, d }) => ({
        case_id: e.case_id, created_at: e.created_at,
        reason: d.reason || 'unknown', error: d.error || null,
      }))
    const deadLettered = parsed
      .filter(({ d }) => d.dead_lettered === true)
      .slice(0, limit)
      .map(({ e, d }) => ({
        case_id: e.case_id, created_at: e.created_at,
        reason: d.reason || 'unknown', msg_id: d.msg_id || null, error: d.error || null,
      }))
    res.json({ count: degraded.length, since, turns: degraded, truncated, dead_lettered_count: deadLettered.length, dead_lettered: deadLettered })
  }
}

export function getFieldValues({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const field = typeof req.query.field === 'string' ? req.query.field : ''
    if (!field) return res.status(400).json({ error: 'field required' })
    if (!isKnownValueField(field)) {
      return res.status(400).json({ error: `no known-value list for field: ${field}`, fields: KNOWN_VALUE_FIELDS })
    }
    const values = await readKnownValues(store, field)
    res.json({ field, label: fieldLabel(field), count: values.length, values })
  }
}

export function postFieldValueCanonicalize({ store, authed, str, callLLM }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const field = str(res, req.body, 'field'); if (field === undefined) return
    const value = str(res, req.body, 'value'); if (value === undefined) return
    if (!isKnownValueField(field)) {
      return res.status(400).json({ error: `no known-value list for field: ${field}`, fields: KNOWN_VALUE_FIELDS })
    }
    const known = await readKnownValues(store, field)
    const r = await canonicalizeFieldValue({ field, value, known, callLLM })
    res.json({ field, ...r })
  }
}

const ROUTES = [
  ['get', '/api/health', getHealth],
  ['get', '/api/health/provider', getHealthProvider],
  ['get', '/api/health/cases', getHealthCases],
  ['get', '/api/runtime', getRuntime],
  ['get', '/api/config', getConfig],
  ['get', '/api/attention', getAttention],
  ['get', '/api/secretary/queue', getSecretaryQueue],
  ['get', '/api/sla-at-risk/by-type', getSlaAtRiskByType],
  ['get', '/api/thresholds', getThresholds],
  ['put', '/api/thresholds', putThresholds],
  ['post', '/api/sweep', postSweep],
  ['get', '/api/clusters', getClusters],
  ['get', '/api/geo', getGeo],
  ['get', '/api/distribution', getDistribution],
  ['get', '/api/field-values', getFieldValues],
  ['post', '/api/field-values/canonicalize', postFieldValueCanonicalize],
  ['get', '/api/activity', getActivity],
  ['get', '/api/turns/degraded', getDegradedTurns],
]

export function registerOperations(app, deps) {
  mountRoutes(app, deps, ROUTES)
}
