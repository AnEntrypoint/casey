import { tagList } from '../../timestamp.js'
import { fmtTimeSAST } from '../../format.js'
import { BRAND } from '../brand.js'

const brandSlug = () => (BRAND.name || 'casey').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'casey'
import { evData } from '../../safe.js'
import { mountRoutes } from './register.js'
import { assigneeNamer } from '../assignee-names.js'

const reportDays = (req) => Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 90)
const msToHrs = (ms) => ms == null ? '' : Math.round(ms / 3600000 * 10) / 10

const AUDIT_SAFE_ACTIONS = new Set(['transition', 'claim', 'status', 'assignee', 'case_type', 'autonomy', 'priority'])

const UNREPLIED_ROW_CAP = 100
const FLAGGED_ROW_CAP = 200

export async function gatherReport({ store, isOpenCase, getRoster }, days) {
  const { classifyCaseHealth } = await import('../../case-health.js')
  const thresholds = await store.resolveThresholds()
  const now = Date.now()
  const cases = await store.listCases({}, { limit: 10000, offset: 0 })
  const eventsByCaseId = await store.listEventsByCase(cases.map(c => c.id)).catch(() => new Map())
  const breachRows = cases
    .filter(isOpenCase)
    .flatMap(c => classifyCaseHealth(c, now, thresholds))
  const staleMs = Number.isFinite(thresholds?.staleMs) ? thresholds.staleMs : 24 * 3600 * 1000
  const { buildReport } = await import('../../report.js')
  const named = await assigneeNamer(store, cases.filter(isOpenCase))
  const report = buildReport(cases, eventsByCaseId, breachRows, now, days, [...await getRoster(), ...named.rosterEntries()], staleMs)
  return { report, cases, eventsByCaseId, thresholds, now }
}

export async function gatherHandover({ store, isOpenCase, rankAttention }) {
  const now = Date.now()
  const marker = await store.getShiftMarker()
  const since = marker?.ts || 0
  const open = (await store.listCases({}, { limit: 10000 })).filter(isOpenCase)
  const { items } = rankAttention(open, now, { limit: 50, offset: 0 })
  const named = await assigneeNamer(store, open)
  const attention = items.map(({ c, score, reason }) => ({
    id: c.id, ref: c.ref, subject: c.subject || '', channel: c.channel,
    status: c.status, assignee: named(c.assignee || ''), score, reason,
  }))
  const handoffs = open.filter(c => tagList(c).includes('needs-human'))
    .map(c => ({ id: c.id, ref: c.ref, subject: c.subject || '', channel: c.channel, assignee: named(c.assignee || '') }))
  const drafts = open.filter(c => tagList(c).includes('draft-pending'))
    .map(c => ({ id: c.id, ref: c.ref, subject: c.subject || '', channel: c.channel }))
  const dueSince = open.filter(c => since && (c.last_event_at || c.updated_at || c.created_at || 0) >= since)
  const touchedEvents = await store.listEventsByCase(dueSince.map(c => c.id)).catch(() => new Map())
  const touched = dueSince.map((c) => {
    const evs = touchedEvents.get(c.id) || []
    const last = evs.length ? evs[evs.length - 1] : null
    return {
      id: c.id, ref: c.ref, subject: c.subject || '', channel: c.channel,
      at: c.last_event_at || c.updated_at || c.created_at || 0,
      last_kind: last?.kind || '', last_actor: last?.actor || '',
    }
  }).sort((a, b) => b.at - a.at)
  return { generated_at: now, since, since_by: marker?.by || null, attention, handoffs, drafts, touched: touched.slice(0, 50) }
}

export function getStats({ store, authed, computeFillRate }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const cases = await store.listCases({}, { limit: 10000, offset: 0 })
    const byMode = { channel: [], manual: [], public_form: [], unknown: [] }
    for (const c of cases) {
      const tags = tagList(c)
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
  }
}

export function getFleetHealth({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const n = Math.min(Math.max(parseInt(req.query.n, 10) || 50, 1), 500)
    const fh = await store.getFleetHealth(n)
    res.json(fh)
  }
}

export function getOverview({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const { buildOverview } = await import('../../overview.js')
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 90)
    const cases = await store.listCases({}, { limit: 10000, offset: 0 })
    const eventsByCaseId = await store.listEventsByCase(cases.map(c => c.id)).catch(() => new Map())
    const overview = buildOverview(cases, eventsByCaseId, Date.now(), days * 24 * 3600 * 1000)
    res.json({ days, ...overview })
  }
}

export function getWorkload({ store, authed, getRoster, isOpenCase }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const { buildWorkload } = await import('../../workload.js')
    const cases = await store.listCases({}, { limit: 10000, offset: 0 })
    const eventsByCaseId = await store.listEventsByCase(cases.map(c => c.id)).catch(() => new Map())
    const th = (store.resolveThresholds ? await store.resolveThresholds() : null) || {}
    const staleMs = Number.isFinite(th.staleMs) ? th.staleMs : 24 * 3600 * 1000
    const named = await assigneeNamer(store, cases.filter(isOpenCase))
    const out = buildWorkload(cases, eventsByCaseId, [...await getRoster(), ...named.rosterEntries()], Date.now(), staleMs)
    res.json(out)
  }
}

export function getReportCsv(deps) {
  const { authed, csvCell } = deps
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const { report: r } = await gatherReport(deps, reportDays(req))
    const lines = []
    lines.push('# Generated ' + fmtTimeSAST(Date.now()))
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
    for (const o of r.by_operator) {
      const k = (m) => csvCell(o.name + ' ' + m)
      lines.push(['by_operator', k('open_assigned'), csvCell(o.open_assigned)].join(','))
      lines.push(['by_operator', k('stale_claims'), csvCell(o.stale_claims)].join(','))
      lines.push(['by_operator', k('replies_24h'), csvCell(o.replies_24h)].join(','))
      lines.push(['by_operator', k('first_reply_hours'), csvCell(msToHrs(o.first_reply_ms_median))].join(','))
      lines.push(['by_operator', k('oldest_waiting_hours'), csvCell(msToHrs(o.oldest_waiting_ms))].join(','))
    }
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="${brandSlug()}-management-report.csv"`)
    res.send(lines.join('\n'))
  }
}

export function getReportJson(deps) {
  const { authed } = deps
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const days = reportDays(req)
    const { report: r, cases, eventsByCaseId, thresholds, now } = await gatherReport(deps, days)
    const { buildSLAReport, buildReportComparison, buildChannelMetrics, buildSLAReportByType, buildCaseTypeMetrics, buildClosureCompleteness } = await import('../../report-analytics.js')
    const slaTargetMs = Number.isFinite(thresholds?.handoffMs) ? thresholds.handoffMs : 30 * 60 * 1000
    res.json({
      ...r,
      sla: buildSLAReport(cases, eventsByCaseId, slaTargetMs, now),
      sla_by_type: buildSLAReportByType(cases, eventsByCaseId, slaTargetMs, now),
      comparison: buildReportComparison(cases, eventsByCaseId, now, days * 24 * 3600 * 1000),
      by_channel: buildChannelMetrics(cases, eventsByCaseId),
      by_case_type: buildCaseTypeMetrics(cases, eventsByCaseId),
      closure_completeness: buildClosureCompleteness(cases, eventsByCaseId, now),
    })
  }
}

export function getAuditCsv({ store, authed, csvCell, fmtTimeSAST }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const days = reportDays(req)
    const sinceSec = Math.floor((Date.now() - days * 24 * 3600 * 1000) / 1000)
    const actorEnum = typeof store.getFieldEnum === 'function' && store.getFieldEnum('event.actor', []).length
      ? store.getFieldEnum('event.actor', [])
      : ['agent', 'operator', 'contact', 'system']
    const optActor = actorEnum.includes(req.query.actor) ? req.query.actor : null
    const cases = await store.listCases({}, { limit: 10000, offset: 0 })
    const refById = new Map(cases.map(c => [c.id, c.ref]))
    const extById = new Map(cases.map(c => [c.id, String(c.external_id || '')]))
    let { rows, truncated } = await store.listAllEvents(optActor ? { actor: optActor } : {}, { limit: 100000 })
    rows = rows.filter(e => Number(e.created_at) >= sinceSec)
    const held = []
    for (const e of rows) { const d = evData(e); held.push(d.claimed_by, d.was) }
    const named = await assigneeNamer(store, held, (v) => v)
    const lines = []
    lines.push('# Generated ' + fmtTimeSAST(Date.now()))
    lines.push(['case_ref', 'timestamp_sast', 'actor', 'action', 'field', 'old_value', 'new_value', 'reason'].join(','))
    for (const e of rows) {
      const d = evData(e)
      const ext = extById.get(e.case_id) || ''
      const scrub = (v) => (v != null && ext && String(v) === ext) ? '[contact]' : (v == null ? '' : String(v))
      const field = d.field || (d.from != null || d.to != null ? 'status' : (d.claimed_by != null ? 'assignee' : ''))
      const fieldSafe = field && AUDIT_SAFE_ACTIONS.has(field)
      const oldVal = fieldSafe ? (d.from != null ? d.from : (d.was != null ? named(d.was) : (d.old != null ? d.old : ''))) : ''
      const newVal = fieldSafe ? (d.to != null ? scrub(d.to) : (d.claimed_by != null ? named(d.claimed_by) : (d.new != null ? d.new : ''))) : ''
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
    if (truncated) {
      lines.push(`# TRUNCATED: more than 100000 events in this window; export a shorter --days range for a complete trail`)
      res.setHeader('X-Audit-Truncated', 'true')
    }
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="${brandSlug()}-audit-trail.csv"`)
    res.send(lines.join('\n'))
  }
}

export function getReportHtml(deps) {
  const { authed, esc, fmtTimeSAST, printableReportRow, printableReport } = deps
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const { report: r } = await gatherReport(deps, reportDays(req))
    const row = (k, v) => printableReportRow([k, v])
    const stageRows = Object.entries(r.by_stage).map(([s, n]) => row(s, n)).join('')
    const areaRows = r.by_area.slice(0, 20).map(a => row(a.place, a.count)).join('')
    const breachRows = Object.entries(r.breaches).map(([b, n]) => row(b, n)).join('') || row('none', 0)
    const opHead = printableReportRow(['operator', 'open', 'stale claims', 'replies 24h', 'first reply (hrs)', 'oldest waiting (hrs)'])
    const opRows = r.by_operator.map(o =>
      printableReportRow([o.name, o.open_assigned, o.stale_claims, o.replies_24h, msToHrs(o.first_reply_ms_median), msToHrs(o.oldest_waiting_ms)])).join('')
      || printableReportRow(['none', '0', '0', '0', '', ''])
    const title = `${BRAND.name} management report`
    const body = `<h1>${esc(title)}</h1>`
      + `<p class="meta">Generated ${esc(fmtTimeSAST(Math.floor(r.generated_at / 1000)))}. Covers the last ${esc(r.period_days)} days.</p>`
      + `<h2>Totals</h2><table>${row('all cases', r.totals.all)}${row('open', r.totals.open)}${row('closed', r.totals.closed)}${row('opened this period', r.opened_this_period)}${row('closed this period', r.closed_this_period)}</table>`
      + `<h2>Response time</h2><table>${row('median first reply (hours)', msToHrs(r.median_first_response_ms))}${row('p90 first reply (hours)', msToHrs(r.p90_first_response_ms))}</table>`
      + `<h2>By stage</h2><table>${stageRows}</table>`
      + `<h2>Hotspots by area</h2><table>${areaRows || row('none', 0)}</table>`
      + `<h2>Team workload</h2><table>${opHead}${opRows}</table>`
      + `<h2>Current health breaches</h2><table>${breachRows}</table>`
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(printableReport(title, body))
  }
}

export function getHandover(deps) {
  const { authed, esc, fmtTimeSAST, printableReportRow, printableReportTable, printableReport } = deps
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const h = await gatherHandover(deps)
    if (req.query.format !== 'html') return res.json(h)
    const secs = (ms) => Math.floor(ms / 1000)
    const row = printableReportRow
    const tbl = printableReportTable
    const sinceTxt = h.since ? fmtTimeSAST(secs(h.since)) + (h.since_by ? ` (by ${esc(h.since_by)})` : '') : 'start of records'
    const title = `${BRAND.name} shift handover`
    const body = `<h1>${esc(title)}</h1>`
      + `<p class="meta">Generated ${esc(fmtTimeSAST(secs(h.generated_at)))}. Covers everything since ${esc(sinceTxt)}.</p>`
      + `<h2>Needs attention (${h.attention.length})</h2>`
      + tbl(['ref', 'subject', 'channel', 'owner', 'why'], h.attention.map(a => row([a.ref, a.subject, a.channel, a.assignee || '-', a.reason])))
      + `<h2>Open handoffs not yet taken (${h.handoffs.length})</h2>`
      + tbl(['ref', 'subject', 'channel', 'owner'], h.handoffs.map(a => row([a.ref, a.subject, a.channel, a.assignee || '-'])))
      + `<h2>Unsent drafts (${h.drafts.length})</h2>`
      + tbl(['ref', 'subject', 'channel'], h.drafts.map(a => row([a.ref, a.subject, a.channel])))
      + `<h2>Touched this shift (${h.touched.length})</h2>`
      + tbl(['when', 'ref', 'subject', 'last action'], h.touched.map(a => row([fmtTimeSAST(secs(a.at)), a.ref, a.subject, `${a.last_kind}${a.last_actor ? ' by ' + a.last_actor : ''}`])))
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(printableReport(title, body))
  }
}

export function postStartShift({ store, authed, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const m = await store.startShift(actingOperator(req))
    res.json({ ok: true, ts: m.ts, by: m.by })
  }
}

export function getUnreplied({ store, authed, isOpenCase }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const open = (await store.listCases({}, { limit: 10000, offset: 0 }))
      .filter(c => isOpenCase(c) && tagList(c).includes('ai-offline'))
    open.sort((a, b) => (b.last_event_at || b.updated_at || 0) - (a.last_event_at || a.updated_at || 0))
    const shown = open.slice(0, UNREPLIED_ROW_CAP)
    const named = await assigneeNamer(store, shown)
    const items = shown.map(c => ({
      id: c.id, ref: c.ref, subject: c.subject || '', channel: c.channel,
      status: c.status, assignee: named(c.assignee || ''),
      last_event_at: c.last_event_at || c.updated_at || c.created_at || 0,
    }))
    res.json({ total: open.length, shown: items.length, items })
  }
}

export function getFlaggedReplies({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const flagged = (await store.listCases({}, { limit: 10000, offset: 0 }))
      .filter(c => tagList(c).includes('flagged-reply'))
    flagged.sort((a, b) => (b.last_event_at || b.updated_at || 0) - (a.last_event_at || a.updated_at || 0))
    const page = flagged.slice(0, FLAGGED_ROW_CAP)
    const items = []
    const pageEvents = await store.listEventsByCase(page.map(c => c.id), { perCaseLimit: 500 }).catch(() => new Map())
    for (const c of page) {
      const events = pageEvents.get(c.id) || []
      const flags = events.filter(e => e.kind === 'observation' && e.text?.startsWith('FLAGGED REPLY'))
      for (const f of flags) {
        const data = evData(f)
        items.push({
          case_id: c.id, ref: c.ref, channel: c.channel,
          flagged_text: data.flagged_text || '', reason: data.reason || '',
          flagged_at: f.created_at, by: data.by || '',
        })
      }
    }
    items.sort((a, b) => (b.flagged_at || 0) - (a.flagged_at || 0))
    res.json({ total: flagged.length, shown: items.length, items })
  }
}

const ROUTES = [
  ['get', '/api/stats', getStats],
  ['get', '/api/fleet-health', getFleetHealth],
  ['get', '/api/overview', getOverview],
  ['get', '/api/operators/workload', getWorkload],
  ['get', '/api/report.csv', getReportCsv],
  ['get', '/api/report.json', getReportJson],
  ['get', '/api/audit.csv', getAuditCsv],
  ['get', '/api/report.html', getReportHtml],
  ['get', '/api/handover', getHandover],
  ['post', '/api/handover/start-shift', postStartShift],
  ['get', '/api/unreplied', getUnreplied],
  ['get', '/api/flagged-replies', getFlaggedReplies],
]

export function registerReports(app, deps) {
  mountRoutes(app, deps, ROUTES)
}
