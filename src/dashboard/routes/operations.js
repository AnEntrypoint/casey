// Operational/health surfaces: AI-helper + gateway + runtime health, live
// client config bootstrap, the attention inbox + SLA-at-risk breakdown,
// operator-tunable thresholds, manual sweep trigger, cross-case
// clusters/geo/distribution/activity views. These are the "is the system
// working, and what needs attention right now" routes.
//
// deps: store, wrap, authed, actingOperator, isOpenCase, rankAttention,
//   getWebhookDeliveryStatus, SAST_TZ, llmStatus, runSweep, receiveStatus,
//   runtimeStatus, queueStatus, alertWebhookUrl
export function registerOperations(app, deps) {
  const {
    store, wrap, authed, actingOperator, isOpenCase, rankAttention, getWebhookDeliveryStatus,
    SAST_TZ, llmStatus, runSweep, receiveStatus, runtimeStatus, queueStatus,
    alertWebhookUrl,
  } = deps

  // Plain-words health for the operator: is the AI helper connected? Low-literacy
  // operators must know WHY auto-replies may be paused (acptoapi offline) without
  // reading logs. llmStatus is an object or a (sync/async) fn returning one; we
  // normalise to {source, model, url} and translate to a friendly label + tone.
  app.get('/api/health', wrap(async (req, res) => {
    let s = typeof llmStatus === 'function' ? await llmStatus() : llmStatus
    s = s || { source: 'unknown' }
    const map = {
      acptoapi: { ok: true, label: 'AI helper: online', detail: 'Auto-replies are on. Contacts get an instant answer.' },
      none: { ok: false, label: 'AI helper: offline', detail: 'Auto-replies are paused. No message is sent; messages queue and re-drive once the provider recovers.' },
      unknown: { ok: false, label: 'AI helper: unknown', detail: 'Cannot tell if the AI helper is connected.' },
    }
    let view = map[s.source] || map.unknown
    // Completion-path degradation: source resolved (acptoapi) but recent real
    // turns are slow/failing. Reachability is a false green here -- the brain
    // answers /v1/models but every turn hangs -- so override the online pill to
    // a degraded amber so the operator sees "answering, but slowly" not "fine".
    if (view.ok && s.degraded) {
      const secs = Number.isFinite(s.lastMs) ? Math.round(s.lastMs / 1000) : null
      view = {
        ok: false,
        label: 'AI helper: slow',
        detail: secs != null
          ? `Auto-replies are working but the AI helper is slow (last turn ${secs}s). Contacts may wait. Check the provider.`
          : 'Auto-replies are working but the AI helper is slow. Contacts may wait. Check the provider.',
      }
    }
    // Bound the externally-supplied model/url so a misconfigured or hostile
    // llmStatus cannot return a multi-megabyte string into the operator's UI.
    const model = s.model ? String(s.model).slice(0, 100) : null
    const url = s.url ? String(s.url).slice(0, 200) : null
    // Receive-liveness for real-time channels: a zombie gateway socket leaves
    // casey deaf while the LLM pill stays green. Surface it as `gateway` so the
    // operator can tell "online" from "online but answering nobody". A channel
    // configured yet never connected since start is the actionable red signal.
    let gateway = null
    try {
      const rs = typeof receiveStatus === 'function' ? await receiveStatus() : receiveStatus
      if (rs && rs.state && rs.state !== 'none') {
        const deaf = rs.state === 'never-connected'
        gateway = {
          ok: !deaf,
          state: rs.state,
          label: deaf ? 'Messages: not connected' : 'Messages: connected',
          detail: deaf
            ? 'A message channel is not receiving. Contacts may be sending with no reply. Restart casey or check the connection.'
            : 'casey is connected and listening for messages.',
          channels: rs.channels || {},
        }
      }
    } catch { gateway = null }   // receive status is best-effort; never break health
    // LLM-down queue depth (pending re-drives + dead-lettered) so an operator
    // sees not just "AI helper offline" but how much is actually backed up
    // behind that outage. Best-effort: a scan failure never breaks health.
    let queue = null
    try {
      const qs = typeof queueStatus === 'function' ? await queueStatus() : null
      if (qs) queue = { pending: qs.pending || 0, dead_lettered: qs.deadLettered || 0 }
    } catch { queue = null }
    // Alert-webhook delivery status: distinguishes "no breach has fired since
    // boot" (ds === null, nothing to report) from "the webhook itself is
    // failing" (ds.ok === false) -- previously a failed POST only ever logged
    // a console warning, invisible on a headless deployment. No URL/detail
    // ever leaks the webhook itself (a secret), only pass/fail + timing.
    let alertWebhook = null
    if (alertWebhookUrl) {
      const ds = getWebhookDeliveryStatus(alertWebhookUrl)
      alertWebhook = ds
        ? { configured: true, ok: ds.ok, last_attempt_at: ds.lastAttemptAt, last_error: ds.ok ? null : ds.lastError }
        : { configured: true, ok: null, last_attempt_at: null, last_error: null }
    } else {
      alertWebhook = { configured: false, ok: null, last_attempt_at: null, last_error: null }
    }
    res.json({ ...view, source: s.source, model, url, degraded: !!s.degraded, last_turn_ms: Number.isFinite(s.lastMs) ? s.lastMs : null, gateway, queue, alert_webhook: alertWebhook })
  }))

  // Runtime/supervisor state: the lifecycle the SUPERVISOR (parent process) drives
  // -- healthy/restarting/degraded, restart count, last reload/crash. The parent
  // pushes this snapshot down over IPC (PARENT_MSG.STATE) and the worker exposes it
  // here so the operator can tell "the runtime got bounced and why" rather than
  // seeing a silent gap. Token-gated like every other API. Null runtimeStatus (the
  // legacy single-process path with no supervisor) reports a benign 'standalone'
  // so the SPA pill never shows a false 'restarting'.
  app.get('/api/runtime', wrap(async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    let s = typeof runtimeStatus === 'function' ? await runtimeStatus() : runtimeStatus
    if (!s) return res.json({ state: 'standalone', supervised: false, label: 'Runtime: running', ok: true })
    // Bound and whitelist the fields so a malformed snapshot cannot inject markup
    // or unbounded strings into the operator UI. No external_id ever appears here.
    const state = String(s.state || 'unknown').slice(0, 32)
    const okStates = new Set(['booting', 'healthy', 'restarting', 'degraded', 'stopping', 'stopped', 'standalone'])
    const safeState = okStates.has(state) ? state : 'unknown'
    const ok = safeState === 'healthy' || safeState === 'standalone'
    const labelMap = {
      booting: 'Runtime: starting', healthy: 'Runtime: healthy', restarting: 'Runtime: restarting',
      degraded: 'Runtime: degraded -- needs attention', stopping: 'Runtime: stopping', stopped: 'Runtime: stopped',
      standalone: 'Runtime: running', unknown: 'Runtime: unknown',
    }
    res.json({
      state: safeState, supervised: true, ok, label: labelMap[safeState],
      restarts: Number.isFinite(s.restarts) ? s.restarts : 0,
      lastReloadAt: s.lastReloadAt != null ? Number(s.lastReloadAt) : null,
      lastCrashReason: s.lastCrashReason ? String(s.lastCrashReason).slice(0, 300) : null,
      since: s.since != null ? Number(s.since) : null,
    })
  }))

  // Config-driven client bootstrap: the workflow stage list and the case_type/
  // priority enums are declared once in thatcher.config.yml (via CaseStore) --
  // this exposes them so the SPA can build its stage-select options, status
  // labels, and "notified on move" set from the LIVE config instead of a
  // hardcoded literal duplicated in several places in the client script. A
  // deployment that adds/renames a workflow stage or case_type value is
  // reflected in the dashboard with no client code change. PII-free (labels
  // and enum names only).
  app.get('/api/config', wrap((req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    res.json({
      stages: store.getValidStatuses(),
      open_stages: typeof store.getOpenStatuses === 'function' ? store.getOpenStatuses() : [],
      case_type: typeof store.getFieldEnum === 'function' ? store.getFieldEnum('case.case_type', []) : [],
      priority: typeof store.getFieldEnum === 'function' ? store.getFieldEnum('case.priority', []) : [],
      // Display-only locale knobs (CASEY_TZ/CASEY_TZ_LABEL/CASEY_COUNTRY_CODE,
      // see format.js) so the client's inlined fmtTime/fmtPhone track the same
      // deployment-configured timezone/country code as the CLI/server side,
      // instead of a hardcoded 'Africa/Johannesburg'/'27' baked into the SPA.
      tz: SAST_TZ,
      tz_label: process.env.CASEY_TZ_LABEL || (process.env.CASEY_TZ ? '' : 'SAST'),
      country_code: (process.env.CASEY_COUNTRY_CODE || '27').replace(/\D/g, '') || '27',
    })
  }))

  // Cases the time-guardrails flagged as going wrong: stale, stuck, an unanswered
  // request for a person, an abandoned intake, or resolved-but-never-closed. Driven
  // by the health:* tags the sweep maintains, with the live breach detail recomputed
  // so the reason is current, not a stale snapshot.
  app.get('/api/attention', wrap(async (req, res) => {
    const { classifyCaseHealth } = await import('../../case-health.js')
    const now = Date.now()
    // Use the LIVE operator-tuned thresholds, not the hard defaults. Passing no
    // thresholds here was a latent bug: a team that tightened handoffMs via
    // /api/thresholds still saw the inbox classify against the shipped default.
    const thresholds = await store.resolveThresholds()
    // Rank over ALL open cases with the SAME enum-weighted scorer the SPA used
    // to render (src/attn.js), so a high-urgency case outside the page window
    // the client fetched still reaches the inbox -- the ranking is no longer
    // capped by loadCases' 200-row limit.
    const open = (await store.listCases({}, { limit: 10000 })).filter(isOpenCase)
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500)
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0)
    const { total, items, atRisk, slaTargetMs } = rankAttention(open, now, { limit, offset })
    // Recompute the live breach detail per ranked case so the reason is current,
    // not a stale tag snapshot. classifyCaseHealth is the source of detail text.
    // waitMs is the live SLA clock -- ms the contact has waited on a human reply
    // (null when nobody owes a reply), so the row can show "waited 18m, target 30m"
    // without the SPA recomputing it. The header at_risk count is aggregate-only.
    const cases = items.map(({ c, score, reason, waitMs }) => ({
      id: c.id, ref: c.ref, subject: c.subject || '', channel: c.channel,
      status: c.status, updated_at: c.updated_at || c.created_at,
      assignee: c.assignee || '',
      wait_ms: waitMs == null ? null : waitMs,
      score, reason, breaches: classifyCaseHealth(c, now, thresholds)
    }))
    res.json({ count: cases.length, total, limit, offset, at_risk: atRisk, sla_target_ms: slaTargetMs, cases })
  }))

  // How many open cases are waiting past the reply SLA, bucketed by case_type, so an
  // operator can attack the worst category first (e.g. "4 outbreaks past SLA vs 1
  // follow_up"). Reuses the live handoff threshold (resolveThresholds) and the same
  // atRiskCount the inbox header shows, run per case_type slice. Aggregate-only --
  // counts only, never a case ref or external_id.
  app.get('/api/sla-at-risk/by-type', wrap(async (req, res) => {
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
  }))

  // Operator-tunable health thresholds. GET returns the live effective values
  // (persisted patch merged over defaults); PUT validates+clamps a partial patch
  // against the known keys, persists it as an audited observation, and returns the
  // new effective values plus which keys applied/were rejected. Both are gated by
  // the global auth middleware above. The PUT feeds BOTH the live sweep and the
  // /api/attention classifier, since both read store.resolveThresholds() at call
  // time -- a change here takes effect on the next sweep and the next inbox scan.
  app.get('/api/thresholds', wrap(async (req, res) => {
    const { mergeThresholds, THRESHOLD_KEYS } = await import('../../thresholds.js')
    const patch = await store.getThresholdsPatch()
    const effective = patch ? mergeThresholds(patch).thresholds : (await import('../../case-health.js')).DEFAULT_THRESHOLDS
    res.json({ thresholds: effective, customized: !!patch, keys: THRESHOLD_KEYS })
  }))

  app.put('/api/thresholds', wrap(async (req, res) => {
    const { mergeThresholds } = await import('../../thresholds.js')
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const { thresholds, applied, rejected } = mergeThresholds(body)
    if (!applied.length) {
      return res.status(400).json({ error: 'no valid threshold keys in patch', rejected })
    }
    // Persist only the accepted, clamped values (not the raw body), so a replay
    // reproduces exactly what took effect.
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
  }))

  // Trigger a health-guardrail sweep now (operator-initiated). Only available
  // when the casey instance passed a runSweep callback; returns 501 otherwise.
  app.post('/api/sweep', wrap(async (req, res) => {
    if (!runSweep) return res.status(501).json({ error: 'sweep not available in this mode' })
    const result = await runSweep()
    res.json({ ok: true, scanned: result?.scanned ?? null, flagged: result?.flagged ?? null, cleared: result?.cleared ?? null })
  }))

  // Fleet-wide outbreak view: connected components of the open/non-merged pool
  // under the same correlation scorer the per-case suggestions use. Surfaces
  // "these N cases look like one outbreak" so the team sees a spreading disease
  // without opening each case. On-demand (one O(n^2) scan over the bounded pool),
  // never per-poll; merge stays per-pair and human-confirmed.
  app.get('/api/clusters', wrap(async (req, res) => {
    const { buildClusters } = await import('../../clusters.js')
    const pool = (await store.listCases({}, { limit: 500 }))
      .filter(c => isOpenCase(c)
        && !String(c.tags || '').split(',').map(s => s.trim()).includes('merged'))
    const clusters = buildClusters(pool)
    res.json({ pool: pool.length, count: clusters.length, clusters })
  }))

  // Hotspots by area: open cases grouped by their stored location token(s),
  // ranked by count, each with species mix and most-recent report time. Re-groups
  // stored location only (no new data); aggregate-only, on-demand.
  app.get('/api/geo', wrap(async (req, res) => {
    const { buildGeo } = await import('../../geo.js')
    const open = (await store.listCases({}, { limit: 10000 })).filter(isOpenCase)
    res.json({ open: open.length, places: buildGeo(open) })
  }))

  // Symptom/species distribution: the pure-aggregation view this system leans
  // on INSTEAD of outbreak/severity inference (see clusters.js's own header
  // comment on why clusterSeverity was removed). Purely a frequency count of
  // what was actually reported -- species x symptom co-occurrence, ranked by
  // count -- so an operator or field worker reads the real pattern themselves
  // rather than being handed a system-guessed diagnosis. `since` (unix
  // seconds) narrows to a recent window; omit for the full open pool.
  app.get('/api/distribution', wrap(async (req, res) => {
    const { buildSymptomDistribution } = await import('../../distribution.js')
    const since = req.query.since ? Number(req.query.since) : null
    if (req.query.since && !Number.isFinite(since)) return res.status(400).json({ error: 'since must be a unix-seconds number' })
    const open = (await store.listCases({}, { limit: 10000 })).filter(isOpenCase)
    res.json(buildSymptomDistribution(open, { since }))
  }))

  // Cross-case activity/audit stream: every event newest-first, filterable by
  // kind/actor (validated against known enums) and a since-timestamp window, each
  // row deep-linking to its case. Read-only. Reuses the same per-case timeline
  // data, just merged across cases for review.
  app.get('/api/activity', wrap(async (req, res) => {
    const KINDS = new Set(['inbound', 'outbound', 'transition', 'observation', 'note', 'action', 'autonomy_change'])
    const ACTORS = new Set(['agent', 'operator', 'contact', 'system'])
    const kind = KINDS.has(req.query.kind) ? req.query.kind : null
    const actor = ACTORS.has(req.query.actor) ? req.query.actor : null
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500)
    const since = parseInt(req.query.since, 10) || 0
    let { rows, truncated } = await store.listAllEvents({ kind, actor }, { limit: limit + (since ? 500 : 0) })
    if (since) rows = rows.filter(e => Number(e.created_at) * 1000 >= since)
    const events = rows.slice(0, limit).map(e => ({
      id: e.id, case_id: e.case_id, kind: e.kind, actor: e.actor,
      text: e.text || '', created_at: e.created_at,
    }))
    res.json({ count: events.length, kind, actor, events, truncated })
  }))

  // Real per-turn reply-path health, distinct from /api/health's aggregated
  // "is the AI helper currently reachable/degraded" pill. The pill's own
  // MIN_SAMPLES_FOR_DEGRADED window (llm.js) deliberately never flips on a
  // single failed turn -- by design, to avoid a lone rate-limited hop flapping
  // the whole dashboard red. That correctness comes at a real observability
  // cost: a genuine one-off turn failure (a real contact getting the
  // guaranteed-response fallback text) can happen while every "is it working"
  // signal (process alive, /api/health, gateway connected) still reads green,
  // because none of them individually witness whether a specific reply
  // actually generated. This route answers the question those cannot: query
  // the durable data.degraded_turn marker (hooks/handler.js) directly, across
  // every case, so "did any real turn actually fail recently, and why" has a
  // real answer without already knowing which case to look at or grepping the
  // raw log file. `since` (unix ms, default last hour) windows the query.
  app.get('/api/turns/degraded', wrap(async (req, res) => {
    const { evData } = await import('../../safe.js')
    const since = req.query.since ? Number(req.query.since) : (Date.now() - 3600_000)
    if (!Number.isFinite(since)) return res.status(400).json({ error: 'since must be a unix-ms number' })
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000)
    // Over-fetch (data.degraded_turn is not a thatcher-queryable column, only
    // discoverable after parsing each row's JSON data blob) then filter+window
    // client-side; listAllEvents' own truncated flag still reports honestly if
    // even the over-fetch pool itself was capped before filtering ran.
    const { rows, truncated } = await store.listAllEvents({ kind: 'observation', actor: 'system' }, { limit: Math.max(limit * 4, 800) })
    const windowed = rows.filter(e => Number(e.created_at) * 1000 >= since)
    const degraded = windowed
      .map(e => ({ e, d: evData(e) }))
      .filter(({ d }) => d.degraded_turn === true)
      .slice(0, limit)
      .map(({ e, d }) => ({
        case_id: e.case_id, created_at: e.created_at,
        reason: d.reason || 'unknown', error: d.error || null,
      }))
    res.json({ count: degraded.length, since, turns: degraded, truncated })
  }))
}
