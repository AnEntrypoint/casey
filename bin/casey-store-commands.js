// casey-store-commands.js  --  every one-shot subcommand that opens the case
// store, prints an answer, and exits: cases / show / attention / handover /
// report / health / sweep / transition / erase-contact / operators.
//
// Split out of bin/casey-cli.mjs's 698-line main(), where all ten of these
// shared one scope with each other, with `casey up`'s supervisor wiring, and
// with doctor's preflight -- so a variable named `store` or `positional` meant
// something different a hundred lines apart. Each is now its own named unit
// with its own store handle, and every one of them still ends through
// closeAndExit (see casey-cli-ui.js for why that matters). Same flags, same
// output, same exit codes.

import { createCaseStore } from '../src/case-store.js'
import { fmtTimeSAST, fmtPhone27, isOpenCase } from '../src/format.js'
import { rankAttention } from '../src/attn.js'
import { parseReport } from '../src/timestamp.js'
import { randomBytes } from 'node:crypto'
import { bold, dim, green, red, cyan, bad, closeAndExit } from './casey-cli-ui.js'

// Every command here opens its own store first; this is that one line, named.
async function openStore() {
  const store = createCaseStore()
  await store.init()
  return store
}

export async function cmdCases({ flags }) {
  const store = await openStore()
  const where = {}
  if (flags.status) {
    const valid = store.getValidStatuses()
    if (!valid.includes(flags.status)) { console.log(bad(`invalid status: ${flags.status}, allowed: ${valid.join(', ')}`)); await closeAndExit(store, 1) }
    where.status = flags.status
  }
  if (flags.channel) {
    const valid = ['discord', 'whatsapp']
    if (!valid.includes(flags.channel)) { console.log(bad(`invalid channel: ${flags.channel}, allowed: ${valid.join(', ')}`)); await closeAndExit(store, 1) }
    where.channel = flags.channel
  }
  const cases = await store.listCases(where)
  if (!cases.length) {
    const desc = [flags.status && `stage "${flags.status}"`, flags.channel && `channel "${flags.channel}"`].filter(Boolean).join(', ')
    console.log(desc ? `no cases matching ${desc}.` : 'no cases yet.')
    console.log(dim(`  connect a channel in .env and run ${cyan('casey up')} to create one.`))
    await closeAndExit(store, 0)
  }
  for (const cr of cases) {
    const contact = cr.external_id ? dim(fmtPhone27(cr.external_id)) : ''
    const age = dim(fmtTimeSAST(cr.created_at) || '(no date)')
    console.log(`${bold(cr.ref)}\t[${cr.status}]\t${cr.priority}\t${cr.channel}\t${contact}\t${cr.subject || ''}\t${age}`)
  }
  await closeAndExit(store, 0)
}

export async function cmdShow({ rest }) {
  const store = await openStore()
  const id = rest.find(a => !a.startsWith('--'))
  if (!id) { console.log(`usage: casey show <ref|id>`); await closeAndExit(store, 1) }
  const caseRow = await store.getCase(id) || await store.getCaseByRef(id)
  if (!caseRow) { console.log(red('case not found:'), id); console.log(dim(`  list cases with ${cyan('casey cases')}.`)); await closeAndExit(store, 1) }
  console.log(`${bold(caseRow.ref)}  [${caseRow.status}]  ${caseRow.priority}  ${caseRow.channel}/${fmtPhone27(caseRow.external_id)}`)
  console.log(`opened: ${fmtTimeSAST(caseRow.created_at) || dim('(no date)')}`)
  console.log(`subject: ${caseRow.subject}\nsummary: ${caseRow.summary}\ntags: ${caseRow.tags}`)
  const report = parseReport(caseRow)
  const { VISIT_CRITICAL: VC } = await import('../src/case-health.js')
  const filled = Object.keys(report).filter(k => report[k] != null && String(report[k]).trim())
  console.log(dim('--- report ---'))
  for (const k of VC) {
    if (report[k]) console.log(`  ${k}: ${report[k]} [visit-critical]`)
    else console.log(dim(`  ${k}: (not given) [visit-critical]`))
  }
  const extra = filled.filter(k => !VC.includes(k))
  for (const k of extra) console.log(`  ${k}: ${report[k]}`)
  if (!filled.length) console.log(dim('  (no additional fields filled)'))
  console.log(dim('--- timeline ---'))
  for (const e of await store.listEvents(caseRow.id)) {
    const ts = fmtTimeSAST(e.created_at)
    console.log(`  ${dim('[' + (ts || 'no time') + ']')} ${e.kind}/${e.actor}: ${e.text}`)
  }
  await closeAndExit(store, 0)
}

export async function cmdAttention({ flags }) {
  const store = await openStore()
  // Rank over the OPEN pool with the SAME scorer the dashboard inbox uses
  // (src/attn.js), so the terminal and the web view agree on what is urgent.
  const open = (await store.listCases()).filter(isOpenCase)
  const limit = Number(flags.limit) > 0 ? Number(flags.limit) : 0
  const offset = Number(flags.offset) > 0 ? Number(flags.offset) : 0
  const { total, items } = rankAttention(open, Date.now(), { limit, offset })
  if (flags.json) {
    console.log(JSON.stringify({ total, items: items.map(x => ({ ref: x.c.ref, score: x.score, reason: x.reason, status: x.c.status, channel: x.c.channel, contact: x.c.external_id, last_activity: x.c.updated_at || x.c.created_at })) }, null, 2))
    await closeAndExit(store, 0)
  }
  if (!total) { console.log(green('nothing needs a person right now.')); await closeAndExit(store, 0) }
  console.log(bold(`${total} case${total === 1 ? '' : 's'} need attention`) + (limit ? dim(`  (showing ${items.length})`) : '') + '\n')
  for (const x of items) {
    const contact = x.c.external_id ? dim(fmtPhone27(x.c.external_id)) : ''
    const when = dim(fmtTimeSAST(x.c.updated_at || x.c.created_at) || '(no date)')
    console.log(`${bold(x.c.ref)}\t${red('score ' + x.score)}\t[${x.c.status}]\t${x.c.channel}\t${contact}`)
    console.log(`  ${x.reason}\n  ${dim('last activity: ' + when)}`)
  }
  await closeAndExit(store, 0)
}

export async function cmdHandover({ flags, rest }) {
  const store = await openStore()
  if (flags['start-shift'] || rest.includes('start')) {
    const m = await store.startShift('cli')
    console.log(green(`shift started ${fmtTimeSAST(Math.floor(m.ts / 1000))}`))
    console.log(dim('  the next handover digest scopes "since now".'))
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
  console.log(bold('casey shift handover') + dim(`  since ${since ? fmtTimeSAST(Math.floor(since / 1000)) : 'start of records'}`) + '\n')
  console.log(bold(`needs attention (${items.length})`))
  for (const x of items) console.log(`  ${bold(x.c.ref)}\t${x.c.assignee ? dim('@' + x.c.assignee) : red('unowned')}\t${x.reason}`)
  console.log(bold(`\nopen handoffs not yet taken (${handoffs.length})`))
  for (const c of handoffs) console.log(`  ${bold(c.ref)}\t${c.subject || ''}`)
  console.log(bold(`\nunsent drafts (${drafts.length})`))
  for (const c of drafts) console.log(`  ${bold(c.ref)}\t${c.subject || ''}`)
  console.log(bold(`\ntouched this shift (${touched.length})`))
  for (const c of touched) console.log(`  ${dim(fmtTimeSAST(Math.floor((c.last_event_at || c.updated_at || c.created_at || 0) / 1000)) || '(no date)')}  ${bold(c.ref)}\t${c.subject || ''}`)
  console.log(dim(`\n  stamp a new shift with ${cyan('casey handover start')}.`))
  await closeAndExit(store, 0)
}

export async function cmdReport({ flags }) {
  // Management briefing on the command line: the same per-case-type SLA, per-type
  // and per-channel response metrics the dashboard serves at /api/report.json, for
  // an operator who lives in the terminal. Reuses the pure builders verbatim (no DB
  // change, aggregate-only, never an external_id). `--json` emits the machine shape;
  // `--days N` sets the comparison window (default 30).
  const store = await openStore()
  const { buildSLAReportByType, buildCaseTypeMetrics, buildChannelMetrics } = await import('../src/report-analytics.js')
  const days = Number.isFinite(Number(flags.days)) && Number(flags.days) > 0 ? Number(flags.days) : 30
  const now = Date.now()
  const thresholds = await store.resolveThresholds()
  const slaTargetMs = Number.isFinite(thresholds?.handoffMs) ? thresholds.handoffMs : 30 * 60 * 1000
  const cases = await store.listCases({}, { limit: 10000 })
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
  console.log(bold('casey management report') + dim(`  SLA target ${Math.round(slaTargetMs / 60000)}min  window ${days}d`) + '\n')
  console.log(bold(`SLA compliance by case type  (overall ${slaByType.overall.met_count}/${slaByType.overall.considered} met, ${slaByType.overall.breach_pct}% breached)`))
  for (const [t, r] of Object.entries(slaByType.by_type)) {
    console.log(`  ${bold(t)}\tmet ${r.met_count}/${r.considered}\t${r.breach_pct}% breach\t${dim(`late ${r.breached_by_reason.answered_late} / unanswered ${r.breached_by_reason.never_answered}`)}`)
  }
  console.log(bold('\nresponse + closure by case type'))
  for (const [t, m] of Object.entries(byCaseType)) {
    console.log(`  ${bold(t)}\tmedian ${ms(m.first_response_ms_median)}\topened ${m.opened_count}\tclosed ${m.closed_pct}%\t${dim(`reopened ${m.reopen_count}`)}`)
  }
  console.log(bold('\nresponse + closure by intake channel'))
  for (const [ch, m] of Object.entries(byChannel)) {
    console.log(`  ${bold(ch)}\tmedian ${ms(m.first_response_ms_median)}\topened ${m.opened_count}\tclosed ${m.closed_pct}%\t${dim(`reopened ${m.reopen_count}`)}`)
  }
  console.log(dim(`\n  the same figures are served at ${cyan('/api/report.json')} for dashboards.`))
  await closeAndExit(store, 0)
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
  if (flags.json) { console.log(JSON.stringify({ open: open.length, breachedCases, corrupt, breaches: breachCounts }, null, 2)); await closeAndExit(store, 0) }
  console.log(bold('casey health') + dim('  (read-only -- nothing written)'))
  console.log(`open cases: ${open.length}   with a guardrail breach: ${breachedCases}` + (corrupt ? red(`   corrupt rows skipped: ${corrupt}`) : ''))
  const entries = Object.entries(breachCounts).sort((a, b) => b[1] - a[1])
  if (!entries.length) console.log(green('  no guardrail breaches.'))
  for (const [tag, n] of entries) console.log(`  ${tag}\t${n}`)
  await closeAndExit(store, 0)
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
  console.log(bold('casey sweep') + dim('  (health-guardrail sweep ran once)'))
  console.log(`scanned: ${scanned}   newly flagged: ${flagged}   cleared: ${cleared}` + (errors ? red(`   errors: ${errors}`) : ''))
  console.log(dim('  run ') + cyan('casey attention') + dim(' to see what to act on.'))
  await closeAndExit(store, 0)
}

export async function cmdTransition({ flags, rest }) {
  const store = await openStore()
  const positional = rest.filter(a => !a.startsWith('--'))
  const [ref, stage] = positional
  if (!ref || !stage) { console.log('usage: casey transition <ref|id> <stage> [--reason "..."]'); console.log(dim('  stages: ') + store.getValidStatuses().map(cyan).join(', ')); await closeAndExit(store, 1) }
  const caseRow = await store.getCase(ref) || await store.getCaseByRef(ref)
  if (!caseRow) { console.log(red('case not found:'), ref); await closeAndExit(store, 1) }
  const OP = { id: 'cli-operator', role: 'operator' }
  const legal = store.availableTransitions(caseRow, OP)
  if (stage !== caseRow.status && !legal.includes(stage)) {
    console.log(red(`cannot move ${caseRow.ref} from '${caseRow.status}' to '${stage}'.`))
    console.log(dim('  allowed from here: ') + (legal.length ? legal.map(cyan).join(', ') : dim('(none)')))
    await closeAndExit(store, 1)
  }
  const reason = typeof flags.reason === 'string' ? flags.reason : 'cli operator override'
  await store.transition(caseRow.id, stage, { user: OP, reason })
  const after = await store.getCase(caseRow.id)
  console.log(green(`${after.ref}: ${caseRow.status} -> ${after.status}`) + dim(`  (${reason})`))
  await closeAndExit(store, 0)
}

// Data retention / right-to-erasure CLI trigger (retention-erasure-flow):
// the same store.eraseContact the dashboard's admin-gated Reporters panel
// "Erase PII" button calls -- a break-glass path for a deployment with no
// dashboard access yet, or a scripted compliance run. Irreversible.
export async function cmdEraseContact({ flags, rest }) {
  const store = await openStore()
  const id = rest.find(a => !a.startsWith('--'))
  if (!id) { console.log('usage: casey erase-contact <contact-id> [--reason "..."]'); await closeAndExit(store, 1) }
  const reason = typeof flags.reason === 'string' ? flags.reason : ''
  try {
    const result = await store.eraseContact(id, { reason, operator: { id: 'cli-operator' } })
    console.log(green(`erased contact ${id}`) + dim(result.contactErased ? '' : ' (already erased)'))
    console.log(`cases scrubbed: ${result.casesScrubbed.length}` + (result.casesScrubbed.length ? '  ' + dim(result.casesScrubbed.join(', ')) : ''))
    await closeAndExit(store, 0)
  } catch (e) { console.log(bad(e.message)); await closeAndExit(store, 1) }
}

// Break-glass account management: talks to the SAME dashboard/auth.js the
// dashboard's own login/user-management panel uses, so the CLI is a real
// recovery path (lost admin password, scripted provisioning) rather than a
// parallel mechanism that could drift from it.
export async function cmdOperators({ flags, rest }) {
  const { createAccount, listAccounts, findAccountByUsername, setAccountDisabled } = await import('../src/dashboard/auth.js')
  const store = await openStore()
  const sub = rest[0]
  const positional = rest.slice(1).filter(a => !a.startsWith('--'))
  if (sub === 'add') {
    const username = positional[0]
    if (!username) { console.log('usage: casey operators add <username> [--password ...] [--name ...] [--role admin|operator]'); await closeAndExit(store, 1) }
    // Math.random() is not cryptographically secure; every other secret-
    // generation path in this codebase (session tokens, media filenames,
    // case reference suffixes) uses node:crypto's randomBytes.
    const password = typeof flags.password === 'string' ? flags.password : randomBytes(10).toString('hex')
    try {
      const acct = await createAccount(store, { username, password, displayName: flags.name, role: flags.role === 'admin' ? 'admin' : 'operator' })
      console.log(green(`created account "${acct.username}" (role: ${acct.role})`))
      if (!flags.password) console.log(dim('  generated password: ') + bold(password) + dim('  -- record this now, it is not shown again'))
      await closeAndExit(store, 0)
    } catch (e) { console.log(bad(e.message)); await closeAndExit(store, 1) }
  }
  if (sub === 'list') {
    const accounts = await listAccounts(store)
    if (!accounts.length) { console.log('no operator accounts yet.'); console.log(dim('  run ' + cyan('casey operators add <username>') + ' to create one.')); await closeAndExit(store, 0) }
    for (const a of accounts) {
      const status = a.disabled === '1' ? red('disabled') : green('active')
      console.log(`${bold(a.username)}\t${a.role}\t${status}\t${a.display_name || ''}\t${dim(a.last_login_at || 'never logged in')}`)
    }
    await closeAndExit(store, 0)
  }
  if (sub === 'disable' || sub === 'enable') {
    const username = positional[0]
    if (!username) { console.log(`usage: casey operators ${sub} <username>`); await closeAndExit(store, 1) }
    const acct = await findAccountByUsername(store, username)
    if (!acct) { console.log(bad(`no account "${username}"`)); await closeAndExit(store, 1) }
    await setAccountDisabled(store, acct.id, sub === 'disable')
    console.log(green(`account "${acct.username}" ${sub === 'disable' ? 'disabled' : 'enabled'}`))
    await closeAndExit(store, 0)
  }
  console.log('usage: casey operators <add|list|disable|enable> ...')
  await closeAndExit(store, 1)
}
