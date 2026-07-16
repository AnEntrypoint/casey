// Management reporting/aggregation surfaces: the CSV/JSON/HTML management
// briefing, the compliance audit trail, shift handover, overview KPIs,
// per-operator workload, intake-mode stats, and the fleet-health trend.
// Aggregate-only (no external_id) per AGENTS.md's audited-classification list.
//
// deps: store, wrap, esc, actingOperator, isOpenCase, rankAttention, getRoster,
//   csvCell, fmtTimeSAST, printableReportRow, printableReportTable,
//   printableReport, computeFillRate
export function registerReports(app, deps) {
  const {
    store, wrap, esc, isOpenCase, rankAttention, getRoster, csvCell,
    fmtTimeSAST, printableReportRow, printableReportTable, printableReport,
    computeFillRate, actingOperator,
  } = deps

  // Aggregate stats comparing intake modes. Returns fill-rate breakdown by source.
  app.get('/api/stats', wrap(async (req, res) => {
    const cases = await store.listCases({}, { limit: 10000, offset: 0 })
    const byMode = { channel: [], manual: [], public_form: [], unknown: [] }
    for (const c of cases) {
      const tags = String(c.tags || '').split(',').map(t => t.trim())
      const hasChannel = tags.includes('intake_mode:channel')
      const hasManual = tags.includes('intake_mode:manual')
      const hasPublic = tags.includes('intake_mode:public_form')
      const fill = computeFillRate(c.report)
      if (hasChannel) byMode.channel.push(fill)
      if (hasManual) byMode.manual.push(fill)
      if (hasPublic) byMode.public_form.push(fill)
      if (!hasChannel && !hasManual && !hasPublic) byMode.unknown.push(fill)
    }
    const avg = (arr, key) => arr.length ? Math.round(arr.reduce((s, r) => s + r[key], 0) / arr.length * 10) / 10 : null
    const summary = {}
    for (const [mode, arr] of Object.entries(byMode)) {
      if (!arr.length) continue
      summary[mode] = {
        count: arr.length,
        avg_filled: avg(arr, 'filled'),
        avg_vc_filled: avg(arr, 'visit_critical_filled'),
        vc_complete: arr.filter(r => r.visit_critical_filled >= r.visit_critical_total).length,
        total_fields: arr[0]?.total_fields ?? 0,
        vc_total: arr[0]?.visit_critical_total ?? 0,
      }
    }
    res.json({ total: cases.length, by_mode: summary })
  }))

  // Fleet-health trend: the rolling log of SCHEDULED guardrail-sweep summaries
  // (persisted by casey.runSweepOnce as audited observations). Returns the latest
  // summary, the last N for a trend line, and a degraded flag (true when the
  // latest sweep hit errors). Read-only, store-backed -- no casey-instance handle
  // needed. ?n clamps the history depth (default 50, 1..500). The header pill
  // wiring is the client-side half (blocked on the browser surface).
  app.get('/api/fleet-health', wrap(async (req, res) => {
    const n = Math.min(Math.max(parseInt(req.query.n, 10) || 50, 1), 500)
    const fh = await store.getFleetHealth(n)
    res.json(fh)
  }))

  // Management KPIs over the live case+event history: time-to-first-reply
  // (median/p90), median dwell per stage from transition events, opened-vs-closed
  // per day, open backlog by stage. Aggregate-only -- no per-contact rows or
  // external_id leak. On-demand (one scan), not a background poll. ?days scopes
  // the per-day window (default 14, clamped 1..90). buildOverview is the pure
  // aggregator shared with the CLI/CSV so the maths is identical everywhere.
  app.get('/api/overview', wrap(async (req, res) => {
    const { buildOverview } = await import('../../overview.js')
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 90)
    const cases = await store.listCases({}, { limit: 10000, offset: 0 })
    const eventsByCaseId = new Map()
    for (const c of cases) eventsByCaseId.set(c.id, await store.listEvents(c.id).catch(() => []))
    const overview = buildOverview(cases, eventsByCaseId, Date.now(), days * 24 * 3600 * 1000)
    res.json({ days, ...overview })
  }))

  // Per-operator workload + accountability: open cases each person holds, stale
  // claims (held but untouched too long), replies sent in the last 24h, median
  // first-reply on their cases, and their oldest-waiting case. Aggregate-only --
  // no per-contact rows, no external_id. On-demand single scan, never per-poll.
  // buildWorkload is the pure aggregator (like overview/attn) so the maths is one
  // place. The stale window reads the live operator-tuned thresholds when present.
  app.get('/api/operators/workload', wrap(async (req, res) => {
    const { buildWorkload } = await import('../../workload.js')
    const cases = await store.listCases({}, { limit: 10000, offset: 0 })
    const eventsByCaseId = new Map()
    for (const c of cases) eventsByCaseId.set(c.id, await store.listEvents(c.id).catch(() => []))
    const th = (store.resolveThresholds ? await store.resolveThresholds() : null) || {}
    const staleMs = Number.isFinite(th.staleMs) ? th.staleMs : 24 * 3600 * 1000
    const out = buildWorkload(cases, eventsByCaseId, await getRoster(), Date.now(), staleMs)
    res.json(out)
  }))

  // Management briefing: one aggregate report (counts by stage + area, opened/
  // closed this period, median/p90 first-response, live breach counts) over a
  // ?days window. .csv for spreadsheets, .html for a print-friendly page; both
  // render the same buildReport numbers. Read-only, aggregate-only, SAST.
  async function gatherReport(days) {
    const { classifyCaseHealth } = await import('../../case-health.js')
    const thresholds = await store.resolveThresholds()
    const now = Date.now()
    const cases = await store.listCases({}, { limit: 10000, offset: 0 })
    const eventsByCaseId = new Map()
    for (const c of cases) eventsByCaseId.set(c.id, await store.listEvents(c.id).catch(() => []))
    const breachRows = cases
      .filter(isOpenCase)
      .flatMap(c => classifyCaseHealth(c, now, thresholds))
    const staleMs = Number.isFinite(thresholds?.staleMs) ? thresholds.staleMs : 24 * 3600 * 1000
    const { buildReport } = await import('../../report.js')
    return buildReport(cases, eventsByCaseId, breachRows, now, days, await getRoster(), staleMs)
  }
  const reportDays = (req) => Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 90)
  const msToHrs = (ms) => ms == null ? '' : Math.round(ms / 3600000 * 10) / 10

  app.get('/api/report.csv', wrap(async (req, res) => {
    const r = await gatherReport(reportDays(req))
    const lines = []
    lines.push(['section', 'key', 'value'].join(','))
    lines.push(['totals', 'all', csvCell(r.totals.all)].join(','))
    lines.push(['totals', 'open', csvCell(r.totals.open)].join(','))
    lines.push(['totals', 'closed', csvCell(r.totals.closed)].join(','))
    lines.push(['period', 'days', csvCell(r.period_days)].join(','))
    lines.push(['period', 'opened_this_period', csvCell(r.opened_this_period)].join(','))
    lines.push(['period', 'closed_this_period', csvCell(r.closed_this_period)].join(','))
    lines.push(['response', 'median_first_response_hours', csvCell(msToHrs(r.median_first_response_ms))].join(','))
    lines.push(['response', 'p90_first_response_hours', csvCell(msToHrs(r.p90_first_response_ms))].join(','))
    for (const [stage, n] of Object.entries(r.by_stage)) lines.push(['by_stage', csvCell(stage), csvCell(n)].join(','))
    for (const a of r.by_area) lines.push(['by_area', csvCell(a.place), csvCell(a.count)].join(','))
    for (const [b, n] of Object.entries(r.breaches)) lines.push(['breach', csvCell(b), csvCell(n)].join(','))
    // Per-operator workload, one line per metric so the flat section/key/value
    // shape holds. Aggregate-only: operator name + counts, never a contact id.
    for (const o of r.by_operator) {
      const k = (m) => csvCell(o.name + ' ' + m)
      lines.push(['by_operator', k('open_assigned'), csvCell(o.open_assigned)].join(','))
      lines.push(['by_operator', k('stale_claims'), csvCell(o.stale_claims)].join(','))
      lines.push(['by_operator', k('replies_24h'), csvCell(o.replies_24h)].join(','))
      lines.push(['by_operator', k('first_reply_hours'), csvCell(msToHrs(o.first_reply_ms_median))].join(','))
      lines.push(['by_operator', k('oldest_waiting_hours'), csvCell(msToHrs(o.oldest_waiting_ms))].join(','))
    }
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', 'attachment; filename="casey-management-report.csv"')
    res.send(lines.join('\n'))
  }))

  // Same management briefing as .csv/.html but as structured JSON for BI ingest,
  // plus three analytics the flat briefing does not carry: SLA compliance pass/
  // fail, period-over-period comparison, and per-intake-channel response speed.
  // Aggregate-only (no external_id); read-only. The SLA target is the live handoff
  // threshold (what "should have been answered by"), falling back to 30 minutes.
  app.get('/api/report.json', wrap(async (req, res) => {
    const days = reportDays(req)
    const r = await gatherReport(days)
    const { buildSLAReport, buildReportComparison, buildChannelMetrics, buildSLAReportByType, buildCaseTypeMetrics } = await import('../../report-analytics.js')
    const thresholds = await store.resolveThresholds()
    const now = Date.now()
    const cases = await store.listCases({}, { limit: 10000, offset: 0 })
    const eventsByCaseId = new Map()
    for (const c of cases) eventsByCaseId.set(c.id, await store.listEvents(c.id).catch(() => []))
    const slaTargetMs = Number.isFinite(thresholds?.handoffMs) ? thresholds.handoffMs : 30 * 60 * 1000
    res.json({
      ...r,
      sla: buildSLAReport(cases, eventsByCaseId, slaTargetMs, now),
      sla_by_type: buildSLAReportByType(cases, eventsByCaseId, slaTargetMs, now),
      comparison: buildReportComparison(cases, eventsByCaseId, now, days * 24 * 3600 * 1000),
      by_channel: buildChannelMetrics(cases, eventsByCaseId),
      by_case_type: buildCaseTypeMetrics(cases, eventsByCaseId),
    })
  }))

  // Compliance audit trail: a flat CSV of every mutation over a ?days window,
  // one row per event, joined to its case ref. Built off the same append-only
  // event log the timeline uses, parsed via evData(). NEVER emits external_id or
  // any contact phone/handle -- the actor is the operator/agent/system id, and
  // the to/from fields are scrubbed of the case external_id so a delivered-reply
  // event cannot leak the contact number into a compliance export. Read-only.
  app.get('/api/audit.csv', wrap(async (req, res) => {
    const { evData } = await import('../../overview.js')
    const days = reportDays(req)
    const sinceSec = Math.floor((Date.now() - days * 24 * 3600 * 1000) / 1000)
    const optActor = ['agent', 'operator', 'contact', 'system'].includes(req.query.actor) ? req.query.actor : null
    const cases = await store.listCases({}, { limit: 10000, offset: 0 })
    const refById = new Map(cases.map(c => [c.id, c.ref]))
    const extById = new Map(cases.map(c => [c.id, String(c.external_id || '')]))
    let rows = await store.listAllEvents(optActor ? { actor: optActor } : {}, { limit: 100000 })
    rows = rows.filter(e => Number(e.created_at) >= sinceSec)
    const lines = []
    lines.push(['case_ref', 'timestamp_sast', 'actor', 'action', 'field', 'old_value', 'new_value', 'reason'].join(','))
    for (const e of rows) {
      const d = evData(e)
      const ext = extById.get(e.case_id) || ''
      // scrub: drop any value equal to the case external_id (contact id/number)
      const scrub = (v) => (v != null && ext && String(v) === ext) ? '[contact]' : (v == null ? '' : String(v))
      const field = d.field || (d.from != null || d.to != null ? 'status' : (d.claimed_by != null ? 'assignee' : ''))
      const oldVal = d.from != null ? d.from : (d.was != null ? d.was : (d.old != null ? d.old : ''))
      const newVal = d.to != null ? scrub(d.to) : (d.claimed_by != null ? d.claimed_by : (d.new != null ? d.new : ''))
      const reason = d.reason || ''
      lines.push([
        csvCell(refById.get(e.case_id) || e.case_id),
        csvCell(fmtTimeSAST(Number(e.created_at))),
        csvCell(e.actor || ''),
        csvCell(e.kind || ''),
        csvCell(field),
        csvCell(scrub(oldVal)),
        csvCell(newVal),
        csvCell(reason),
      ].join(','))
    }
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', 'attachment; filename="casey-audit-trail.csv"')
    res.send(lines.join('\n'))
  }))

  app.get('/api/report.html', wrap(async (req, res) => {
    const r = await gatherReport(reportDays(req))
    const row = (k, v) => printableReportRow([k, v])
    const stageRows = Object.entries(r.by_stage).map(([s, n]) => row(s, n)).join('')
    const areaRows = r.by_area.slice(0, 20).map(a => row(a.place, a.count)).join('')
    const breachRows = Object.entries(r.breaches).map(([b, n]) => row(b, n)).join('') || row('none', 0)
    const opHead = printableReportRow(['operator', 'open', 'stale claims', 'replies 24h', 'first reply (hrs)', 'oldest waiting (hrs)'])
    const opRows = r.by_operator.map(o =>
      printableReportRow([o.name, o.open_assigned, o.stale_claims, o.replies_24h, msToHrs(o.first_reply_ms_median), msToHrs(o.oldest_waiting_ms)])).join('')
      || printableReportRow(['none', '0', '0', '0', '', ''])
    const body = `<h1>casey management report</h1>`
      + `<p>Generated ${esc(fmtTimeSAST(Math.floor(r.generated_at / 1000)))} -- last ${esc(r.period_days)} days</p>`
      + `<h2>Totals</h2><table>${row('all cases', r.totals.all)}${row('open', r.totals.open)}${row('closed', r.totals.closed)}${row('opened this period', r.opened_this_period)}${row('closed this period', r.closed_this_period)}</table>`
      + `<h2>Response time</h2><table>${row('median first reply (hours)', msToHrs(r.median_first_response_ms))}${row('p90 first reply (hours)', msToHrs(r.p90_first_response_ms))}</table>`
      + `<h2>By stage</h2><table>${stageRows}</table>`
      + `<h2>Hotspots by area</h2><table>${areaRows || row('none', 0)}</table>`
      + `<h2>Team workload</h2><table>${opHead}${opRows}</table>`
      + `<h2>Current health breaches</h2><table>${breachRows}</table>`
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(printableReport('casey management report', body))
  }))

  // Shift handover: a printable digest of what the next person needs to pick up.
  // Built entirely from the event log + attention engine, scoped to "since the
  // last Start-of-shift marker" (or the full open pool when no shift was started).
  // No per-operator scoping -- a rotating field team shares one shift line.
  async function gatherHandover() {
    const now = Date.now()
    const marker = await store.getShiftMarker()
    const since = marker?.ts || 0
    const open = (await store.listCases({}, { limit: 10000 })).filter(isOpenCase)
    const tagsOf = (c) => String(c.tags || '').split(',').map(t => t.trim()).filter(Boolean)
    // Cases still needing attention, ranked by the same scorer the inbox uses.
    const { items } = rankAttention(open, now, { limit: 50, offset: 0 })
    const attention = items.map(({ c, score, reason }) => ({
      id: c.id, ref: c.ref, subject: c.subject || '', channel: c.channel,
      status: c.status, assignee: c.assignee || '', score, reason,
    }))
    // Open handoffs not yet taken: a person was asked for and no operator owns it.
    const handoffs = open.filter(c => tagsOf(c).includes('needs-human'))
      .map(c => ({ id: c.id, ref: c.ref, subject: c.subject || '', channel: c.channel, assignee: c.assignee || '' }))
    // Unsent assisted drafts waiting for an operator to approve or discard.
    const drafts = open.filter(c => tagsOf(c).includes('draft-pending'))
      .map(c => ({ id: c.id, ref: c.ref, subject: c.subject || '', channel: c.channel }))
    // Cases touched since the shift began, with their last action, newest-first.
    const touched = []
    for (const c of open) {
      const at = c.last_event_at || c.updated_at || c.created_at || 0
      if (!since || at < since) continue
      const evs = await store.listEvents(c.id).catch(() => [])
      const last = evs.length ? evs[evs.length - 1] : null
      touched.push({
        id: c.id, ref: c.ref, subject: c.subject || '', channel: c.channel,
        at, last_kind: last?.kind || '', last_actor: last?.actor || '',
      })
    }
    touched.sort((a, b) => b.at - a.at)
    return { generated_at: now, since, since_by: marker?.by || null, attention, handoffs, drafts, touched: touched.slice(0, 50) }
  }

  app.get('/api/handover', wrap(async (req, res) => {
    const h = await gatherHandover()
    if (req.query.format !== 'html') return res.json(h)
    const secs = (ms) => Math.floor(ms / 1000)
    const row = printableReportRow
    const tbl = printableReportTable
    const sinceTxt = h.since ? fmtTimeSAST(secs(h.since)) + (h.since_by ? ` (by ${esc(h.since_by)})` : '') : 'start of records'
    const body = `<h1>casey shift handover</h1>`
      + `<p>Generated ${esc(fmtTimeSAST(secs(h.generated_at)))} -- since ${esc(sinceTxt)}</p>`
      + `<h2>Needs attention (${h.attention.length})</h2>`
      + tbl(['ref', 'subject', 'channel', 'owner', 'why'], h.attention.map(a => row([a.ref, a.subject, a.channel, a.assignee || '-', a.reason])))
      + `<h2>Open handoffs not yet taken (${h.handoffs.length})</h2>`
      + tbl(['ref', 'subject', 'channel', 'owner'], h.handoffs.map(a => row([a.ref, a.subject, a.channel, a.assignee || '-'])))
      + `<h2>Unsent drafts (${h.drafts.length})</h2>`
      + tbl(['ref', 'subject', 'channel'], h.drafts.map(a => row([a.ref, a.subject, a.channel])))
      + `<h2>Touched this shift (${h.touched.length})</h2>`
      + tbl(['when', 'ref', 'subject', 'last action'], h.touched.map(a => row([fmtTimeSAST(secs(a.at)), a.ref, a.subject, `${a.last_kind}${a.last_actor ? ' by ' + a.last_actor : ''}`])))
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(printableReport('casey shift handover', body))
  }))

  // Stamp a new shift marker so the next handover digest scopes "since now".
  app.post('/api/handover/start-shift', wrap(async (req, res) => {
    const m = await store.startShift(actingOperator(req))
    res.json({ ok: true, ts: m.ts, by: m.by })
  }))

  // AI-offline queue: open cases whose last agent turn FAILED (model error/timeout,
  // store/host fault) so a human could not trust the auto-reply was adequate. The
  // gateway tags such a case 'ai-offline' (cleared by the next operator reply or a
  // later successful agent turn), so this is a cheap tag scan over the open pool --
  // no per-case event read on the hot path. Newest-first by last activity so the
  // freshest outage sits on top of the operator's queue.
  app.get('/api/unreplied', wrap(async (req, res) => {
    const open = (await store.listCases({}, { limit: 10000, offset: 0 }))
      .filter(c => isOpenCase(c)
        && String(c.tags || '').split(',').map(t => t.trim()).includes('ai-offline'))
    open.sort((a, b) => (b.last_event_at || b.updated_at || 0) - (a.last_event_at || a.updated_at || 0))
    const items = open.map(c => ({
      id: c.id, ref: c.ref, subject: c.subject || '', channel: c.channel,
      status: c.status, assignee: c.assignee || '',
      last_event_at: c.last_event_at || c.updated_at || c.created_at || 0,
    }))
    res.json({ total: items.length, items })
  }))
}
