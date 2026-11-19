
import { createCaseStore } from '../src/case-store.js'
import { fmtTimeLocal, fmtPhone27, isOpenCase } from '../src/format.js'
import { rankAttention } from '../src/attn.js'
import { parseReport, tsMs } from '../src/timestamp.js'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { writeFileSync, mkdirSync, renameSync, openSync, writeSync, fsyncSync, closeSync, unlinkSync } from 'node:fs'
import { bold, dim, green, red, cyan, bad, say, closeAndExit } from './casey-cli-ui.js'
import { cliText } from './casey-cli-text.js'
import { caseyText } from '../src/deployment-text.js';

async function openStore() {
  const store = createCaseStore()
  await store.init()
  return store
}

async function requireOneOf(store, name, raw, allowed) {
  if (raw === true || raw === '') {
    say(bad(caseyText("bin/casey-store-commands.js#w0", [name])))
    say(dim(caseyText("bin/casey-store-commands.js#w1")) + allowed.map(cyan).join(', '))
    await closeAndExit(store, 1)
  }
  if (!allowed.includes(raw)) {
    say(bad(caseyText("bin/casey-store-commands.js#w2", [name, raw])))
    say(dim(caseyText("bin/casey-store-commands.js#w3")) + allowed.map(cyan).join(', '))
    await closeAndExit(store, 1)
  }
  return raw
}

export async function cmdCases({ flags }) {
  const store = await openStore()
  const where = {}
  if (flags.status !== undefined) {
    where.status = await requireOneOf(store, 'status', flags.status, store.getValidStatuses())
  }
  if (flags.channel !== undefined) {
    const seen = [...new Set((await store.listCases({}, { limit: 10000 })).map(c => c.channel).filter(Boolean))].sort()
    where.channel = await requireOneOf(store, 'channel', flags.channel, seen)
  }
  const cases = await store.listCases(where)
  if (!cases.length) {
    const desc = [where.status && `stage "${where.status}"`, where.channel && `channel "${where.channel}"`].filter(Boolean).join(', ')
    console.log(desc ? caseyText("bin/casey-store-commands.js#w4", [desc]) : caseyText("bin/casey-store-commands.js#w5"))
    console.log(dim(caseyText("bin/casey-store-commands.js#w6", [cyan(caseyText("bin/casey-store-commands.js#w7"))])))
    await closeAndExit(store, 0)
  }
  for (const cr of cases) {
    const contact = cr.external_id ? dim(fmtPhone27(cr.external_id)) : ''
    const age = dim(fmtTimeLocal(cr.created_at) || caseyText("bin/casey-store-commands.js#w8"))
    console.log(`${bold(cr.ref)}\t[${cr.status}]\t${cr.priority}\t${cr.channel}\t${contact}\t${cr.subject || ''}\t${age}`)
  }
  const total = await store.countCases(where).catch(() => cases.length)
  if (total > cases.length) console.log(dim(caseyText("bin/casey-store-commands.js#w9", [cases.length, total])))
  await closeAndExit(store, 0)
}

export async function cmdShow({ rest }) {
  const store = await openStore()
  const id = rest.find(a => !a.startsWith('--'))
  if (!id) { say(caseyText("bin/casey-store-commands.js#w10")); await closeAndExit(store, 1) }
  const caseRow = await store.getCase(id) || await store.getCaseByRef(id)
  if (!caseRow) { say(bad(caseyText("bin/casey-store-commands.js#w11", [id]))); say(dim(caseyText("bin/casey-store-commands.js#w12", [cyan(caseyText("bin/casey-store-commands.js#w13"))]))); await closeAndExit(store, 1) }
  console.log(`${bold(caseRow.ref)}  [${caseRow.status}]  ${caseRow.priority}  ${caseRow.channel}/${fmtPhone27(caseRow.external_id)}`)
  console.log(`opened: ${fmtTimeLocal(caseRow.created_at) || dim(caseyText("bin/casey-store-commands.js#w14"))}`)
  console.log(`subject: ${caseRow.subject}\nsummary: ${caseRow.summary}\ntags: ${caseRow.tags}`)
  const report = parseReport(caseRow)
  const { VISIT_CRITICAL: VC } = await import('../src/case-health.js')
  const filled = Object.keys(report).filter(k => report[k] != null && String(report[k]).trim())
  console.log(dim('--- report ---'))
  for (const k of VC) {
    if (report[k]) console.log(`  ${k}: ${report[k]} [visit-critical]`)
    else console.log(dim(caseyText("bin/casey-store-commands.js#w15", [k])))
  }
  const extra = filled.filter(k => !VC.includes(k))
  for (const k of extra) console.log(`  ${k}: ${report[k]}`)
  if (!filled.length) console.log(dim(caseyText("bin/casey-store-commands.js#w16")))
  console.log(dim('--- timeline ---'))
  for (const e of await store.listEvents(caseRow.id)) {
    const ts = fmtTimeLocal(e.created_at)
    console.log(`  ${dim('[' + (ts || caseyText("bin/casey-store-commands.js#w17")) + ']')} ${e.kind}/${e.actor}: ${e.text}`)
  }
  await closeAndExit(store, 0)
}

export async function cmdAttention({ flags }) {
  const store = await openStore()
  const open = (await store.listCases()).filter(isOpenCase)
  const limit = Number(flags.limit) > 0 ? Number(flags.limit) : 0
  const offset = Number(flags.offset) > 0 ? Number(flags.offset) : 0
  const { total, items } = rankAttention(open, Date.now(), { limit, offset })
  if (flags.json) {
    console.log(JSON.stringify({ total, items: items.map(x => ({ ref: x.c.ref, score: x.score, reason: x.reason, status: x.c.status, channel: x.c.channel, contact: x.c.external_id, last_activity: x.c.updated_at || x.c.created_at })) }, null, 2))
    await closeAndExit(store, 0)
  }
  if (!total) { console.log(green(caseyText("bin/casey-store-commands.js#w18"))); await closeAndExit(store, 0) }
  console.log(bold(caseyText("bin/casey-store-commands.js#w19", [total, total === 1 ? '' : 's'])) + (limit ? dim(`  (showing ${items.length})`) : '') + '\n')
  for (const x of items) {
    const contact = x.c.external_id ? dim(fmtPhone27(x.c.external_id)) : ''
    const when = dim(fmtTimeLocal(x.c.updated_at || x.c.created_at) || caseyText("bin/casey-store-commands.js#w20"))
    console.log(`${bold(x.c.ref)}\t${red('score ' + x.score)}\t[${x.c.status}]\t${x.c.channel}\t${contact}`)
    console.log(`  ${x.reason}\n  ${dim(caseyText("bin/casey-store-commands.js#w21") + when)}`)
  }
  await closeAndExit(store, 0)
}

export async function cmdHandover({ flags, rest }) {
  const store = await openStore()
  if (flags['start-shift'] || rest.includes('start')) {
    const m = await store.startShift('cli')
    console.log(green(caseyText("bin/casey-store-commands.js#w22", [fmtTimeLocal(Math.floor(m.ts / 1000))])))
    console.log(dim(caseyText("bin/casey-store-commands.js#w23")))
    await closeAndExit(store, 0)
  }
  const now = Date.now()
  const marker = await store.getShiftMarker()
  const since = marker?.ts || 0
  const open = (await store.listCases({}, { limit: 10000 })).filter(c => c.status !== 'closed')
  const tagsOf = (c) => String(c.tags || '').split(',').map(t => t.trim()).filter(Boolean)
  const { items } = rankAttention(open, now, { limit: 50, offset: 0 })
  const handoffs = open.filter(c => tagsOf(c).includes('needs-human'))
  const drafts = open.filter(c => tagsOf(c).includes('draft-pending'))
  const touched = open.filter(c => since && (c.last_event_at || c.updated_at || c.created_at || 0) >= since)
    .sort((a, b) => (b.last_event_at || b.updated_at || 0) - (a.last_event_at || a.updated_at || 0))
  if (flags.json) {
    console.log(JSON.stringify({
      generated_at: now, since, since_by: marker?.by || null,
      attention: items.map(x => ({ ref: x.c.ref, reason: x.reason, assignee: x.c.assignee || '' })),
      handoffs: handoffs.map(c => c.ref), drafts: drafts.map(c => c.ref), touched: touched.map(c => c.ref),
    }, null, 2))
    await closeAndExit(store, 0)
  }
  console.log(bold(caseyText("bin/casey-store-commands.js#w24")) + dim(`  since ${since ? fmtTimeLocal(Math.floor(since / 1000)) : caseyText("bin/casey-store-commands.js#w25")}`) + '\n')
  console.log(bold(caseyText("bin/casey-store-commands.js#w26", [items.length])))
  for (const x of items) console.log(`  ${bold(x.c.ref)}\t${x.c.assignee ? dim('@' + x.c.assignee) : red('unowned')}\t${x.reason}`)
  console.log(bold(caseyText("bin/casey-store-commands.js#w27", [handoffs.length])))
  for (const c of handoffs) console.log(`  ${bold(c.ref)}\t${c.subject || ''}`)
  console.log(bold(caseyText("bin/casey-store-commands.js#w28", [drafts.length])))
  for (const c of drafts) console.log(`  ${bold(c.ref)}\t${c.subject || ''}`)
  console.log(bold(caseyText("bin/casey-store-commands.js#w29", [touched.length])))
  for (const c of touched) console.log(`  ${dim(fmtTimeLocal(Math.floor((c.last_event_at || c.updated_at || c.created_at || 0) / 1000)) || caseyText("bin/casey-store-commands.js#w30"))}  ${bold(c.ref)}\t${c.subject || ''}`)
  console.log(dim(caseyText("bin/casey-store-commands.js#w31", [cyan(caseyText("bin/casey-store-commands.js#w32"))])))
  await closeAndExit(store, 0)
}

export async function cmdReport({ flags }) {
  const store = await openStore()
  const { buildSLAReportByType, buildCaseTypeMetrics, buildChannelMetrics } = await import('../src/report-analytics.js')
  const days = Number.isFinite(Number(flags.days)) && Number(flags.days) > 0 ? Number(flags.days) : 30
  const now = Date.now()
  const thresholds = await store.resolveThresholds()
  const slaTargetMs = Number.isFinite(thresholds?.handoffMs) ? thresholds.handoffMs : 30 * 60 * 1000
  const windowStart = now - days * 24 * 60 * 60 * 1000
  const cases = (await store.listCases({}, { limit: 10000 }))
    .filter(c => (tsMs(c.created_at) ?? 0) >= windowStart)
  if (!cases.length && !flags.json) {
    console.log(bold(caseyText("bin/casey-store-commands.js#w33")) + dim(caseyText("bin/casey-store-commands.js#w34", [days])))
    console.log(caseyText("bin/casey-store-commands.js#w35", [days, days === 1 ? '' : 's']))
    console.log(dim(caseyText("bin/casey-store-commands.js#w36")) + cyan(caseyText("bin/casey-store-commands.js#w37", [days * 4])) + dim('.'))
    await closeAndExit(store, 0)
  }
  const eventsByCaseId = new Map()
  for (const cs of cases) eventsByCaseId.set(cs.id, await store.listEvents(cs.id).catch(() => []))
  const slaByType = buildSLAReportByType(cases, eventsByCaseId, slaTargetMs, now)
  const byCaseType = buildCaseTypeMetrics(cases, eventsByCaseId)
  const byChannel = buildChannelMetrics(cases, eventsByCaseId)
  if (flags.json) {
    console.log(JSON.stringify({ generated_at: now, days, sla_target_ms: slaTargetMs, sla_by_type: slaByType, by_case_type: byCaseType, by_channel: byChannel }, null, 2))
    await closeAndExit(store, 0)
  }
  const ms = (n) => n == null ? dim('n/a') : `${Math.round(n / 1000)}s`
  console.log(bold(caseyText("bin/casey-store-commands.js#w38")) + dim(caseyText("bin/casey-store-commands.js#w39", [Math.round(slaTargetMs / 60000), cases.length, days])) + '\n')
  console.log(bold(caseyText("bin/casey-store-commands.js#w40", [slaByType.overall.met_count, slaByType.overall.considered, slaByType.overall.breach_pct])))
  for (const [t, r] of Object.entries(slaByType.by_type)) {
    console.log(`  ${bold(t)}\tmet ${r.met_count}/${r.considered}\t${r.breach_pct}% breach\t${dim(`late ${r.breached_by_reason.answered_late} / unanswered ${r.breached_by_reason.never_answered}`)}`)
  }
  console.log(bold(caseyText("bin/casey-store-commands.js#w41")))
  for (const [t, m] of Object.entries(byCaseType)) {
    console.log(caseyText("bin/casey-store-commands.js#w42", [bold(t), ms(m.first_response_ms_median), m.opened_count, m.closed_pct, dim(`reopened ${m.reopen_count}`)]))
  }
  console.log(bold(caseyText("bin/casey-store-commands.js#w43")))
  for (const [ch, m] of Object.entries(byChannel)) {
    console.log(caseyText("bin/casey-store-commands.js#w44", [bold(ch), ms(m.first_response_ms_median), m.opened_count, m.closed_pct, dim(`reopened ${m.reopen_count}`)]))
  }
  console.log(dim(caseyText("bin/casey-store-commands.js#w45", [cyan('/api/report.json')])))
  await closeAndExit(store, 0)
}

const BREACH_MEANING = {
  stale: caseyText("bin/casey-store-commands.js#w46"),
  stuck: caseyText("bin/casey-store-commands.js#w47"),
  unanswered_handoff: caseyText("bin/casey-store-commands.js#w48"),
  unanswered_handoff_escalated: caseyText("bin/casey-store-commands.js#w49"),
  unsent_draft: caseyText("bin/casey-store-commands.js#w50"),
  abandoned_intake: caseyText("bin/casey-store-commands.js#w51"),
  incomplete_critical: caseyText("bin/casey-store-commands.js#w52"),
  never_closed: caseyText("bin/casey-store-commands.js#w53"),
  timestamp_corrupt: caseyText("bin/casey-store-commands.js#w54"),
  premature_complete: caseyText("bin/casey-store-commands.js#w55"),
}

export async function cmdHealth({ flags }) {
  const store = await openStore()
  const { classifyCaseHealth } = await import('../src/case-health.js')
  const thresholds = await store.resolveThresholds()
  const open = (await store.listCases()).filter(isOpenCase)
  const now = Date.now()
  const breachCounts = {}
  let corrupt = 0, breachedCases = 0
  for (const c of open) {
    let breaches = []
    try { breaches = classifyCaseHealth(c, now, thresholds) || [] }
    catch { corrupt++; continue }
    if (breaches.length) breachedCases++
    for (const b of breaches) { const tag = b.breach || 'breach'; breachCounts[tag] = (breachCounts[tag] || 0) + 1 }
  }
  const { feedbackCounts } = await import('../src/feedback.js')
  const feedback = await feedbackCounts(store).catch(() => ({ total: 0, last_7_days: 0 }))
  const team = await teamMetricsSummary(store).catch(() => null)
  if (flags.json) { console.log(JSON.stringify({ open: open.length, breachedCases, corrupt, breaches: breachCounts, feedback, team }, null, 2)); await closeAndExit(store, 0) }
  console.log(bold(caseyText("bin/casey-store-commands.js#w56")) + dim(caseyText("bin/casey-store-commands.js#w57")))
  console.log(caseyText("bin/casey-store-commands.js#w58", [open.length, breachedCases]) + (corrupt ? red(caseyText("bin/casey-store-commands.js#w59", [corrupt])) : ''))
  const entries = Object.entries(breachCounts).sort((a, b) => b[1] - a[1])
  if (!entries.length) console.log(green(caseyText("bin/casey-store-commands.js#w60")))
  for (const [tag, n] of entries) console.log(`  ${n}\t${tag}\t${dim(BREACH_MEANING[tag] || tag)}`)
  if (entries.length) console.log(dim(caseyText("bin/casey-store-commands.js#w61", [breachedCases])))
  if (entries.length) console.log(dim(caseyText("bin/casey-store-commands.js#w62")) + cyan(caseyText("bin/casey-store-commands.js#w63")) + dim('.'))
  console.log(caseyText("bin/casey-store-commands.js#w64", [feedback.total, feedback.last_7_days]) + dim(caseyText("bin/casey-store-commands.js#w65")))
  if (team) console.log(teamMetricsLine(team) + dim(caseyText("bin/casey-store-commands.js#w66")))
  await closeAndExit(store, 0)
}

async function teamMetricsSummary(store) {
  const { buildTeamMetrics } = await import('../src/ranger-metrics.js')
  const { teamPeople } = await import('../src/dashboard/routes/team.js')
  const { listAccounts } = await import('../src/dashboard/auth.js')
  const { UNCLAIMED_ASSIGNEE } = await import('../src/case-store.js')
  const cases = (await store.listCases({}, { limit: 5000, offset: 0 })).filter(c => c.channel !== 'system')
  const m = buildTeamMetrics({ cases, eventsByCase: await store.listEventsByCase(cases.map(c => c.id)), people: await teamPeople(store, listAccounts), now: Date.now(), unclaimed: UNCLAIMED_ASSIGNEE })
  const o = m.overall
  return { stuck_hours: m.stuck_hours, assigned: o.assigned, first_action: o.first_action, signoff: o.signoff, nudges: o.nudges, nudge_share: o.nudge_share, stuck: o.stuck }
}
function teamMetricsLine(t) {
  const h = (ms) => (ms == null ? 'n/a' : ms < 3600e3 ? Math.round(ms / 60e3) + 'm' : Math.round(ms / 360e3) / 10 + 'h')
  const share = t.nudge_share == null ? 'n/a' : Math.round(t.nudge_share * 100) + '%'
  return caseyText("bin/casey-store-commands.js#w67", [t.assigned, h(t.first_action?.median_ms), h(t.first_action?.p90_ms), h(t.signoff?.median_ms), share, t.nudges, t.stuck_hours, t.stuck])
}

export async function cmdSweep({ flags }) {
  const store = await openStore()
  const { sweepCases } = await import('../src/case-sweep.js')
  const thresholds = await store.resolveThresholds()
  const summary = await sweepCases(store, Date.now(), thresholds)
  if (flags.json) { console.log(JSON.stringify(summary, null, 2)); await closeAndExit(store, 0) }
  const scanned = summary.scanned || 0
  const flagged = summary.flagged || 0
  const cleared = summary.cleared || 0
  const errors = Array.isArray(summary.errors) ? summary.errors.length : 0
  console.log(bold(caseyText("bin/casey-store-commands.js#w68")) + dim(caseyText("bin/casey-store-commands.js#w69")))
  console.log(caseyText("bin/casey-store-commands.js#w70", [scanned, flagged, cleared]) + (errors ? red(`   errors: ${errors}`) : ''))
  console.log(dim('  run ') + cyan(caseyText("bin/casey-store-commands.js#w71")) + dim(caseyText("bin/casey-store-commands.js#w72")))
  await closeAndExit(store, 0)
}

export async function cmdTransition({ flags, rest }) {
  const store = await openStore()
  const positional = rest.filter(a => !a.startsWith('--'))
  const [ref, stage] = positional
  if (!ref || !stage) { say(caseyText("bin/casey-store-commands.js#w73")); say(dim('  stages: ') + store.getValidStatuses().map(cyan).join(', ')); await closeAndExit(store, 1) }
  const caseRow = await store.getCase(ref) || await store.getCaseByRef(ref)
  if (!caseRow) { say(bad(caseyText("bin/casey-store-commands.js#w74", [ref]))); say(dim(caseyText("bin/casey-store-commands.js#w75", [cyan(caseyText("bin/casey-store-commands.js#w76"))]))); await closeAndExit(store, 1) }
  const OP = { id: 'cli-operator', role: 'operator' }
  if (stage === caseRow.status) {
    console.log(caseyText("bin/casey-store-commands.js#w77", [caseRow.ref, bold(stage)]))
    await closeAndExit(store, 0)
  }
  const legal = store.availableTransitions(caseRow, OP)
  if (!legal.includes(stage)) {
    say(bad(caseyText("bin/casey-store-commands.js#w78", [caseRow.ref, caseRow.status, stage])))
    say(dim(caseyText("bin/casey-store-commands.js#w79")) + (legal.length ? legal.map(cyan).join(', ') : '(none)'))
    await closeAndExit(store, 1)
  }
  const reason = typeof flags.reason === 'string' ? flags.reason : caseyText("bin/casey-store-commands.js#w80")
  await store.transition(caseRow.id, stage, { user: OP, reason })
  const after = await store.getCase(caseRow.id)
  console.log(green(`${after.ref}: ${caseRow.status} -> ${after.status}`) + dim(`  (${reason})`))
  await closeAndExit(store, 0)
}

async function resolveContact(store, needle) {
  const contacts = await store.t.list('contact', {}, { limit: 10000 })
  const exact = contacts.find(c => c.id === needle)
  if (exact) return exact
  const norm = (s) => String(s || '').replace(/[^0-9a-z]/gi, '').toLowerCase()
  const key = norm(needle)
  const byExternal = key && contacts.find(c => norm(c.external_id) === key)
  if (byExternal) return byExternal
  const caseRow = await store.getCaseByRef(needle) || await store.getCase(needle)
  if (caseRow?.contact_id) return contacts.find(c => c.id === caseRow.contact_id) || null
  return null
}

async function reportIncompleteErasures(store) {
  const open = await store.findIncompleteErasures()
  if (!open.length) {
    console.log(green(caseyText("bin/casey-store-commands.js#w81")))
    console.log(dim(caseyText("bin/casey-store-commands.js#w82")))
    await closeAndExit(store, 0)
  }
  say(bad(caseyText("bin/casey-store-commands.js#w83", [open.length, open.length === 1 ? '' : 's'])))
  for (const p of open) {
    console.log(caseyText("bin/casey-store-commands.js#w84", [bold(p.contactId), fmtTimeLocal(Math.floor((p.ts || 0) / 1000)) || caseyText("bin/casey-store-commands.js#w85"), p.by || 'system']))
    console.log(dim(caseyText("bin/casey-store-commands.js#w86", [(p.caseIds || []).length, (p.siblingIds || []).length])))
    console.log(dim(caseyText("bin/casey-store-commands.js#w87")))
    console.log(dim('    ') + cyan(caseyText("bin/casey-store-commands.js#w88", [p.contactId])))
  }
  await closeAndExit(store, 1)
}

export async function cmdEraseContact({ flags, rest }) {
  const store = await openStore()
  if (flags.check) return reportIncompleteErasures(store)
  const id = rest.find(a => !a.startsWith('--'))
  if (!id) {
    say(caseyText("bin/casey-store-commands.js#w89"))
    say(dim(caseyText("bin/casey-store-commands.js#w90", [cyan(caseyText("bin/casey-store-commands.js#w91")), cyan(caseyText("bin/casey-store-commands.js#w92"))])))
    await closeAndExit(store, 1)
  }
  const contact = await resolveContact(store, id)
  if (!contact) {
    say(bad(caseyText("bin/casey-store-commands.js#w93", [id])))
    say(dim(caseyText("bin/casey-store-commands.js#w94")))
    say(dim(caseyText("bin/casey-store-commands.js#w95", [cyan(caseyText("bin/casey-store-commands.js#w96"))])))
    await closeAndExit(store, 1)
  }
  if (flags.persons || flags.person) {
    const { listPersons, normName } = await import('../src/phone-persons.js')
    const people = await listPersons(store, contact.id)
    if (flags.persons || flags.person === true) {
      if (!people.length) say(dim(caseyText("bin/casey-store-commands.js#w97")))
      for (const p of people) console.log(`${bold(p.id)}\t${p.name}${p.relation ? ` (${p.relation})` : ''}\t${p.reports} report(s)`)
      await closeAndExit(store, 0)
    }
    const want = String(flags.person)
    const hit = people.find(p => p.id === want) || people.find(p => normName(p.name) === normName(want))
    if (!hit) {
      say(bad(caseyText("bin/casey-store-commands.js#w98", [want])))
      say(dim(caseyText("bin/casey-store-commands.js#w99")) + cyan(caseyText("bin/casey-store-commands.js#w100", [contact.id])))
      await closeAndExit(store, 1)
    }
    if (!flags.yes) {
      say(bad(caseyText("bin/casey-store-commands.js#w101", [hit.name, hit.reports])))
      say(dim(caseyText("bin/casey-store-commands.js#w102")))
      say(dim('    ') + cyan(caseyText("bin/casey-store-commands.js#w103", [contact.id, hit.id])))
      await closeAndExit(store, 1)
    }
    try {
      const result = await store.erasePerson(contact.id, hit.id, { reason: typeof flags.reason === 'string' ? flags.reason : '', operator: { id: 'cli-operator' } })
      if (!result.ok) { say(bad(caseyText("bin/casey-store-commands.js#w104", [result.reason]))); await closeAndExit(store, 1) }
      console.log(green(caseyText("bin/casey-store-commands.js#w105", [hit.name, Math.max(0, people.length - 1)])))
      const refs = []
      for (const cid of result.casesScrubbed) refs.push((await store.getCase(cid).catch(() => null))?.ref || cid)
      console.log(caseyText("bin/casey-store-commands.js#w106", [refs.length]) + (refs.length ? '  ' + dim(refs.join(', ')) : ''))
      if (result.casesFailed?.length) say(bad(caseyText("bin/casey-store-commands.js#w107", [result.casesFailed.length])))
      if (result.sessionsFailed?.length) say(bad(caseyText("bin/casey-store-commands.js#w108", [result.sessionsFailed.length, result.sessionsFailed.join(', ')])))
      await closeAndExit(store, 0)
    } catch (e) { say(bad(e.message)); await closeAndExit(store, 1) }
  }
  if (!flags.yes) {
    say(bad(caseyText("bin/casey-store-commands.js#w109", [contact.display_name || contact.external_id || contact.id])))
    say(dim(caseyText("bin/casey-store-commands.js#w110")))
    say(dim('    ') + cyan(caseyText("bin/casey-store-commands.js#w111", [contact.id])))
    await closeAndExit(store, 1)
  }
  const reason = typeof flags.reason === 'string' ? flags.reason : ''
  try {
    const result = await store.eraseContact(contact.id, { reason, operator: { id: 'cli-operator' } })
    console.log(result.contactErased
      ? green(`erased ${contact.display_name || contact.external_id || contact.id}`)
      : caseyText("bin/casey-store-commands.js#w112", [contact.id]))
    const refs = []
    for (const cid of result.casesScrubbed) refs.push((await store.getCase(cid).catch(() => null))?.ref || cid)
    console.log(caseyText("bin/casey-store-commands.js#w113", [refs.length]) + (refs.length ? '  ' + dim(refs.join(', ')) : ''))
    if (result.casesFailed?.length) say(bad(caseyText("bin/casey-store-commands.js#w114", [result.casesFailed.length])))
    if (result.sessionsFailed?.length) say(bad(caseyText("bin/casey-store-commands.js#w115", [result.sessionsFailed.length, result.sessionsFailed.join(', ')])))
    if (result.journalled === false) say(bad(caseyText("bin/casey-store-commands.js#w116")))
    await closeAndExit(store, 0)
  } catch (e) { say(bad(e.message)); await closeAndExit(store, 1) }
}

function retentionPolicyFromFlags(flags) {
  const overrides = {}
  if (flags.days !== undefined && flags.days !== true) overrides.days = flags.days
  if (flags.action !== undefined && flags.action !== true) overrides.action = flags.action
  if (flags.out !== undefined && flags.out !== true) overrides.archiveDir = flags.out
  return overrides
}

export async function cmdRetention({ flags }) {
  const { resolveRetentionPolicy, planRetention, executeRetention, resolveArchiveRoot, KEEP_REASONS, RETENTION_ACTIONS } = await import('../src/retention.js')
  let policy
  try { policy = resolveRetentionPolicy(process.env, retentionPolicyFromFlags(flags)) }
  catch (e) { say(bad(e.message)); process.exit(1) }

  if (!policy) {
    if (flags.json) { console.log(JSON.stringify({ policy: null, configured: false, eligible: [], kept: [] }, null, 2)); return }
    console.log(bold(caseyText("bin/casey-store-commands.js#w117")) + dim(caseyText("bin/casey-store-commands.js#w118")))
    console.log(caseyText("bin/casey-store-commands.js#w119"))
    console.log(dim(caseyText("bin/casey-store-commands.js#w120")))
    console.log(dim('    ') + cyan(caseyText("bin/casey-store-commands.js#w121")))
    console.log(dim(caseyText("bin/casey-store-commands.js#w122")))
    console.log(dim('    ') + cyan('CASEY_RETENTION_DAYS=365') + dim(caseyText("bin/casey-store-commands.js#w123")))
    console.log(dim('    ') + cyan(`CASEY_RETENTION_ACTION=${RETENTION_ACTIONS[0]}`) + dim(caseyText("bin/casey-store-commands.js#w124", [RETENTION_ACTIONS.join(', ')])))
    return
  }

  const store = await openStore()
  const now = Date.now()
  const plan = await planRetention(store, now, policy)
  const archiveRoot = resolveArchiveRoot(store, policy)

  if (!flags.yes) {
    if (flags.json) {
      console.log(JSON.stringify({ dry_run: true, policy, archive_root: archiveRoot, scanned: plan.scanned, eligible: plan.eligible, kept: plan.kept }, null, 2))
      await closeAndExit(store, 0)
    }
    console.log(bold(caseyText("bin/casey-store-commands.js#w125")) + dim(caseyText("bin/casey-store-commands.js#w126")))
    console.log(caseyText("bin/casey-store-commands.js#w127", [bold(policy.days + ' days'), bold(policy.action)]))
    console.log(dim(caseyText("bin/casey-store-commands.js#w128", [archiveRoot])))
    console.log(caseyText("bin/casey-store-commands.js#w129", [plan.scanned, bold(String(plan.eligible.length)), policy.action, plan.kept.length]))
    if (plan.eligible.length) {
      console.log(bold(`would ${policy.action} (${plan.eligible.length})`))
      for (const c of plan.eligible) console.log(`  ${bold(c.ref)}\t[${c.status}]\t${c.channel}\t${dim(c.detail)}`)
    }
    const byReason = new Map()
    for (const c of plan.kept) {
      if (!byReason.has(c.reason)) byReason.set(c.reason, [])
      byReason.get(c.reason).push(c.ref)
    }
    if (byReason.size) {
      console.log(bold(`\nkept (${plan.kept.length})`))
      for (const [reason, refs] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
        console.log(`  ${refs.length}\t${reason}\t${dim(KEEP_REASONS[reason] || reason)}`)
        console.log(dim(`    ${refs.slice(0, 8).join(', ')}${refs.length > 8 ? caseyText("bin/casey-store-commands.js#w130", [refs.length - 8]) : ''}`))
      }
    }
    console.log(dim(caseyText("bin/casey-store-commands.js#w131")) + cyan(caseyText("bin/casey-store-commands.js#w132")) + dim('.'))
    await closeAndExit(store, 0)
  }

  if (!plan.eligible.length) {
    console.log(green(caseyText("bin/casey-store-commands.js#w133")))
    await closeAndExit(store, 0)
  }
  const result = await executeRetention(store, plan, { operator: 'cli-operator', log: console })
  if (flags.json) {
    console.log(JSON.stringify({ dry_run: false, ...result.manifest }, null, 2))
    await closeAndExit(store, result.failed.length ? 1 : 0)
  }
  console.log(bold(caseyText("bin/casey-store-commands.js#w134")) + dim(`  (action: ${policy.action})`))
  console.log(caseyText("bin/casey-store-commands.js#w135", [cyan(result.archiveDir)]))
  for (const a of result.archived) console.log(green(`  ${a.ref}`) + dim(`  ${a.events} event(s), ${a.bytes} bytes -> ${a.file.split('/').pop()}`))
  console.log(`\n${result.archived.length} ${policy.action}d, ${plan.kept.length} kept, ${result.failed.length} failed.`)
  if (policy.action === 'erase') console.log(dim(caseyText("bin/casey-store-commands.js#w136", [result.sessionsRemoved])) + (result.sessionsFailed.length ? red(caseyText("bin/casey-store-commands.js#w137", [result.sessionsFailed.length])) : ''))
  for (const f of result.failed) say(bad(`${f.ref}: ${f.error}`))
  console.log(dim(caseyText("bin/casey-store-commands.js#w138")))
  console.log(dim(caseyText("bin/casey-store-commands.js#w139")))
  console.log(dim(caseyText("bin/casey-store-commands.js#w140")))
  await closeAndExit(store, result.failed.length ? 1 : 0)
}

export async function cmdBackup({ flags }) {
  const { runBackup } = await import('../src/backup.js')
  const store = await openStore()
  const dataDir = store.dataDir
  await store.close()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const out = typeof flags.out === 'string' ? flags.out : `backups/casey-${stamp}`
  let result
  try { result = await runBackup({ dataDir, outDir: out }) }
  catch (e) { say(bad(e.message)); process.exit(1) }
  if (flags.json) { console.log(JSON.stringify(result.manifest, null, 2)); process.exit(result.failed.length ? 1 : 0) }
  console.log(bold(caseyText("bin/casey-store-commands.js#w141")) + dim(`  ${result.dir}`))
  for (const s of result.stores) {
    const mark = s.status === 'ok' ? green('[ok]') : s.status === 'missing' ? dim('[none]') : red('[x]')
    const size = s.bytes ? dim(`${s.bytes} bytes${s.files ? `, ${s.files} file(s)` : ''}`) : dim(s.status === 'ok' ? 'empty' : '')
    console.log(`  ${mark} ${bold(s.name)}\t${size}`)
    if (s.note) console.log(dim(`      ${s.note}`))
  }
  console.log(bold(caseyText("bin/casey-store-commands.js#w142")))
  for (const n of result.manifest.not_included) console.log(dim(`  ${n.name} -- ${n.why}`))
  if (result.failed.length) {
    say('')
    say(bad(caseyText("bin/casey-store-commands.js#w143", [result.failed.length])))
    for (const f of result.failed) say(bad(`  ${f.name}: ${f.note}`))
    process.exit(1)
  }
  console.log(green(caseyText("bin/casey-store-commands.js#w144")) + dim(caseyText("bin/casey-store-commands.js#w145")) + cyan(caseyText("bin/casey-store-commands.js#w146", [result.dir])))
  process.exit(0)
}

export async function cmdRestore({ flags, rest }) {
  const { runRestore } = await import('../src/backup.js')
  const dir = rest.find(a => !a.startsWith('--'))
  if (!dir) { say(caseyText("bin/casey-store-commands.js#w147")); process.exit(1) }
  const dataDir = path.resolve(process.cwd(), 'data')
  if (!flags.yes) {
    say(bad(caseyText("bin/casey-store-commands.js#w148", [dataDir, dir])))
    say(dim(caseyText("bin/casey-store-commands.js#w149")))
    say(dim(caseyText("bin/casey-store-commands.js#w150")))
    say(dim(caseyText("bin/casey-store-commands.js#w151")))
    process.exit(1)
  }
  let result
  try { result = await runRestore({ backupDir: dir, dataDir }) }
  catch (e) { say(bad(e.message)); process.exit(1) }
  console.log(bold(caseyText("bin/casey-store-commands.js#w152")) + dim(`  from ${dir}`))
  console.log(green(caseyText("bin/casey-store-commands.js#w153", [result.dataDir])))
  for (const aside of result.movedAside) console.log(dim(caseyText("bin/casey-store-commands.js#w154", [aside])))
  console.log(caseyText("bin/casey-store-commands.js#w155", [result.sessions.status === 'ok' ? green('restored') : dim(result.sessions.status), dim(result.sessions.note)]))
  if (result.manifest.complete === false) {
    say(bad(caseyText("bin/casey-store-commands.js#w156")))
  }
  console.log(bold(caseyText("bin/casey-store-commands.js#w157")))
  for (const n of result.manifest.not_included) console.log(dim(`  ${n.name} -- ${n.why}`))
  process.exit(0)
}

export async function cmdOperators({ flags, rest }) {
  const { createAccount, listAccounts, findAccountByUsername, setAccountDisabled, resetAccountPassword } = await import('../src/dashboard/auth.js')
  const store = await openStore()
  const sub = rest[0]
  const positional = rest.slice(1).filter(a => !a.startsWith('--'))
  const { ACCOUNT_ROLES } = await import('../src/dashboard/roles.js')
  if (sub === 'add') {
    const username = positional[0]
    if (!username) { say(cliText('operators.add.usage') ?? caseyText("bin/casey-store-commands.js#w158")); await closeAndExit(store, 1) }
    if (flags.role !== undefined) await requireOneOf(store, 'role', flags.role, ACCOUNT_ROLES)
    if (flags.password === true || flags.email === true) { say(bad(caseyText("bin/casey-store-commands.js#w159"))); await closeAndExit(store, 1) }
    const password = typeof flags.password === 'string' ? flags.password : undefined
    try {
      const acct = await createAccount(store, { username, password, email: typeof flags.email === 'string' ? flags.email : undefined, contactPhone: typeof flags.phone === 'string' ? flags.phone : undefined, displayName: typeof flags.name === 'string' ? flags.name : undefined, role: flags.role || 'operator' })
      console.log(green(caseyText("bin/casey-store-commands.js#w160", [acct.username, acct.role])))
      if (!password && acct.setup_email_status === 'link_only') console.log(dim(caseyText("bin/casey-store-commands.js#w161", [acct.setup_link])))
      else if (!password) console.log(dim(acct.setup_email_status === 'sent' ? caseyText("bin/casey-store-commands.js#w162") : caseyText("bin/casey-store-commands.js#w163", [acct.setup_email_error || 'unknown'])))
      await closeAndExit(store, 0)
    } catch (e) { say(bad(e.message)); await closeAndExit(store, 1) }
  }
  if (sub === 'list') {
    const accounts = await listAccounts(store)
    if (!accounts.length) { console.log(caseyText("bin/casey-store-commands.js#w164")); console.log(dim('  run ' + cyan(caseyText("bin/casey-store-commands.js#w165")) + caseyText("bin/casey-store-commands.js#w166"))); await closeAndExit(store, 0) }
    for (const a of accounts) {
      const status = a.disabled === '1' ? red('[disabled]') : green('[active]')
      const seen = a.last_login_at ? fmtTimeLocal(Math.floor(Date.parse(a.last_login_at) / 1000)) : null
      console.log(`${bold(a.username)}\t${a.role === 'secretary' ? caseyText("bin/casey-store-commands.js#w167") : a.role}\t${status}\t${a.display_name || ''}\t${dim(seen || caseyText("bin/casey-store-commands.js#w168"))}`)
    }
    await closeAndExit(store, 0)
  }
  if (sub === 'reset') {
    const username = positional[0]
    if (!username) { say(caseyText("bin/casey-store-commands.js#w169")); await closeAndExit(store, 1) }
    const acct = await findAccountByUsername(store, username)
    if (!acct) { say(bad(caseyText("bin/casey-store-commands.js#w170", [username]))); await closeAndExit(store, 1) }
    const out = await resetAccountPassword(store, acct.id, process.env.CASEY_PUBLIC_URL || '')
    if (out.setup_email_status === 'link_only') console.log(green(caseyText("bin/casey-store-commands.js#w171", [acct.username])) + '\n  ' + out.setup_link)
    else if (out.setup_email_status === 'sent') console.log(green(caseyText("bin/casey-store-commands.js#w172", [acct.username])))
    else { say(bad(caseyText("bin/casey-store-commands.js#w173", [acct.username, out.setup_email_error || 'unknown']))); await closeAndExit(store, 1) }
    await closeAndExit(store, 0)
  }
  if (sub === 'disable' || sub === 'enable') {
    const username = positional[0]
    if (!username) { say(caseyText("bin/casey-store-commands.js#w174", [sub])); await closeAndExit(store, 1) }
    const acct = await findAccountByUsername(store, username)
    if (!acct) { say(bad(caseyText("bin/casey-store-commands.js#w175", [username]))); say(dim(caseyText("bin/casey-store-commands.js#w176", [cyan(caseyText("bin/casey-store-commands.js#w177"))]))); await closeAndExit(store, 1) }
    const already = (acct.disabled === '1') === (sub === 'disable')
    await setAccountDisabled(store, acct.id, sub === 'disable')
    console.log(already
      ? caseyText("bin/casey-store-commands.js#w178", [acct.username, sub === 'disable' ? 'disabled' : 'enabled'])
      : green(`account "${acct.username}" ${sub === 'disable' ? 'disabled' : 'enabled'}`))
    await closeAndExit(store, 0)
  }
  if (sub) say(bad(caseyText("bin/casey-store-commands.js#w179", [sub])))
  say(caseyText("bin/casey-store-commands.js#w180"))
  await closeAndExit(store, 1)
}


function writeFilesAtomic(pairs) {
  const temps = []
  try {
    for (const [target, content] of pairs) {
      const temp = `${target}.${process.pid}.tmp`
      temps.push(temp)
      const fd = openSync(temp, 'w')
      try { writeSync(fd, content); fsyncSync(fd) } finally { closeSync(fd) }
    }
  } catch (e) {
    for (const temp of temps) { try { unlinkSync(temp) } catch {} }
    throw e
  }
  pairs.forEach(([target], i) => renameSync(temps[i], target))
}

export async function cmdReportDigest({ flags }) {
  const { buildDigest, lastCompletedMonth, postDigest, recordDigestStatus } = await import('../src/report-digest.js')
  const month = flags.month === undefined ? lastCompletedMonth() : flags.month
  const webhook = process.env.CASEY_ALERT_WEBHOOK
  if (flags['out-dir'] !== undefined && flags.out !== undefined) { say(bad(caseyText("bin/casey-store-commands.js#w181"))); process.exit(1) }
  if (flags['out-dir'] !== undefined && typeof flags['out-dir'] !== 'string') { say(bad(caseyText("bin/casey-store-commands.js#w182"))); process.exit(1) }
  if (flags.post && !webhook) { say(bad(caseyText("bin/casey-store-commands.js#w183"))); process.exit(1) }
  const outDir = typeof flags['out-dir'] === 'string' ? flags['out-dir'] : null
  const store = await openStore()
  let digest
  try { digest = await buildDigest(store, month) } catch (e) {
    if (outDir) recordDigestStatus(outDir, month, { ok: false, incomplete: false, error: e.message })
    say(bad(e.message)); await closeAndExit(store, 1)
  }
  const csvPath = outDir ? path.join(outDir, `casey-digest-${digest.month}.csv`)
    : typeof flags.out === 'string' ? flags.out : `casey-digest-${digest.month}.csv`
  const textPath = csvPath.replace(/\.csv$/i, '') + '.txt'
  mkdirSync(path.dirname(csvPath), { recursive: true })
  try {
    writeFilesAtomic([[csvPath, digest.csv], [textPath, digest.text + '\n']])
  } catch (e) {
    if (outDir) recordDigestStatus(outDir, digest.month, { ok: false, incomplete: false, error: caseyText("bin/casey-store-commands.js#w184", [e.message]) })
    say(bad(caseyText("bin/casey-store-commands.js#w185", [e.message]))); await closeAndExit(store, 1)
  }
  const incomplete = Boolean(digest.rep.truncated)
  if (outDir) recordDigestStatus(outDir, digest.month, { ok: true, incomplete, error: null })
  console.log(digest.text)
  say(dim(caseyText("bin/casey-store-commands.js#w186", [csvPath, textPath])))
  if (flags.post) {
    try { await postDigest(webhook, digest.text); say(green(caseyText("bin/casey-store-commands.js#w187"))) }
    catch (e) { say(bad(caseyText("bin/casey-store-commands.js#w188", [e.message]))); await closeAndExit(store, 1) }
  }
  if (incomplete) { say(bad(caseyText("bin/casey-store-commands.js#w189", [digest.month]))); await closeAndExit(store, 1) }
  await closeAndExit(store, 0)
}
