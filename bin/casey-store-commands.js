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
import { parseReport, tsMs } from '../src/timestamp.js'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { bold, dim, green, red, cyan, bad, say, closeAndExit } from './casey-cli-ui.js'

// Every command here opens its own store first; this is that one line, named.
async function openStore() {
  const store = createCaseStore()
  await store.init()
  return store
}

// parseFlags yields the boolean `true` for a flag with nothing after it
// (`--status` at the end of the line, or followed by another --flag). That
// sentinel is an internal parser detail, and echoing it back as
// `invalid status: true` told the operator the name of a value they never
// typed. Both shapes -- no value, and a value this store does not know -- get
// the real vocabulary printed beside them.
async function requireOneOf(store, name, raw, allowed) {
  if (raw === true || raw === '') {
    say(bad(`--${name} needs a value.`))
    say(dim('  one of: ') + allowed.map(cyan).join(', '))
    await closeAndExit(store, 1)
  }
  if (!allowed.includes(raw)) {
    say(bad(`there is no ${name} "${raw}" here.`))
    say(dim('  one of: ') + allowed.map(cyan).join(', '))
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
    // The channel vocabulary is whatever this deployment has actually received
    // on, read from the store -- not a hardcoded discord/whatsapp pair. A store
    // holding cases from the public web form and the simulator refused
    // `--channel web` as invalid while listing web cases one line later.
    const seen = [...new Set((await store.listCases({}, { limit: 10000 })).map(c => c.channel).filter(Boolean))].sort()
    where.channel = await requireOneOf(store, 'channel', flags.channel, seen)
  }
  const cases = await store.listCases(where)
  if (!cases.length) {
    const desc = [where.status && `stage "${where.status}"`, where.channel && `channel "${where.channel}"`].filter(Boolean).join(', ')
    console.log(desc ? `no cases matching ${desc}.` : 'no cases yet.')
    console.log(dim(`  connect a channel in .env and run ${cyan('casey up')} to create one.`))
    await closeAndExit(store, 0)
  }
  for (const cr of cases) {
    const contact = cr.external_id ? dim(fmtPhone27(cr.external_id)) : ''
    const age = dim(fmtTimeSAST(cr.created_at) || '(no date)')
    console.log(`${bold(cr.ref)}\t[${cr.status}]\t${cr.priority}\t${cr.channel}\t${contact}\t${cr.subject || ''}\t${age}`)
  }
  // listCases pages at 50 by default. A queue truncated with nothing saying so
  // means case 51 is invisible and no line on screen admits it exists.
  const total = await store.countCases(where).catch(() => cases.length)
  if (total > cases.length) console.log(dim(`  showing ${cases.length} of ${total} -- narrow it with --status or --channel.`))
  await closeAndExit(store, 0)
}

export async function cmdShow({ rest }) {
  const store = await openStore()
  const id = rest.find(a => !a.startsWith('--'))
  if (!id) { say(`usage: casey show <ref|id>`); await closeAndExit(store, 1) }
  const caseRow = await store.getCase(id) || await store.getCaseByRef(id)
  if (!caseRow) { say(bad(`no case "${id}".`)); say(dim(`  list cases with ${cyan('casey cases')}.`)); await closeAndExit(store, 1) }
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
  // `--days N` restricts the population to cases OPENED in the last N days
  // (default 30). It is applied to `cases` below before any builder sees it:
  // until it was, --days was parsed, echoed into the header and the JSON, and
  // then ignored -- `--days 1` and `--days 3650` printed byte-identical bodies.
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
    console.log(bold('casey management report') + dim(`  window ${days}d`))
    console.log(`no cases opened in the last ${days} day${days === 1 ? '' : 's'}.`)
    console.log(dim('  widen it with ') + cyan(`casey report --days ${days * 4}`) + dim('.'))
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
  console.log(bold('casey management report') + dim(`  SLA target ${Math.round(slaTargetMs / 60000)}min  ${cases.length} case(s) opened in the last ${days}d`) + '\n')
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

// The guardrail tags are the enum case-health.js writes onto a case. On the
// terminal they were the whole answer -- a column of `abandoned_intake` and
// `incomplete_critical` with nothing saying what an operator is looking at.
// The tag stays (it is what `casey cases`/the dashboard filter on); the plain
// sentence sits beside it. An unmapped tag falls back to its own name rather
// than disappearing, so a new breach type is never silently unlabelled.
const BREACH_MEANING = {
  stale: 'no activity for days',
  stuck: 'sitting in the same stage too long',
  unanswered_handoff: 'someone asked for a person and nobody has replied',
  unanswered_handoff_escalated: 'that request for a person is now badly overdue',
  unsent_draft: 'a reply was drafted and never sent',
  abandoned_intake: 'the reporter stopped answering mid-report',
  incomplete_critical: 'facts a field visit needs are still missing',
  never_closed: 'open far longer than this kind of case should be',
  timestamp_corrupt: 'the stored dates on this case cannot be read',
  premature_complete: 'marked done with a visit-critical fact still blank',
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
  for (const [tag, n] of entries) console.log(`  ${n}\t${tag}\t${dim(BREACH_MEANING[tag] || tag)}`)
  if (entries.length) console.log(dim(`\n  a case can breach more than one guardrail, so these add up past ${breachedCases}.`))
  if (entries.length) console.log(dim('  record them on the cases with ') + cyan('casey sweep') + dim('.'))
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
  if (!ref || !stage) { say('usage: casey transition <ref|id> <stage> [--reason "..."]'); say(dim('  stages: ') + store.getValidStatuses().map(cyan).join(', ')); await closeAndExit(store, 1) }
  const caseRow = await store.getCase(ref) || await store.getCaseByRef(ref)
  if (!caseRow) { say(bad(`no case "${ref}".`)); say(dim(`  list cases with ${cyan('casey cases')}.`)); await closeAndExit(store, 1) }
  const OP = { id: 'cli-operator', role: 'operator' }
  // Moving a case to the stage it is already in wrote a real transition event
  // and reported `triaging -> triaging` as a change. Nothing moved, so nothing
  // is recorded and nothing is claimed.
  if (stage === caseRow.status) {
    console.log(`${caseRow.ref} is already ${bold(stage)}. Nothing changed.`)
    await closeAndExit(store, 0)
  }
  const legal = store.availableTransitions(caseRow, OP)
  if (!legal.includes(stage)) {
    say(bad(`cannot move ${caseRow.ref} from '${caseRow.status}' to '${stage}'.`))
    say(dim('  allowed from here: ') + (legal.length ? legal.map(cyan).join(', ') : '(none)'))
    await closeAndExit(store, 1)
  }
  // The recorded reason is what an auditor reads off the timeline months later.
  // Defaulting it to "cli operator override" stamped every ordinary, legal,
  // workflow-approved move as an override; the default now says only where the
  // move came from, and --reason still carries the operator's own words.
  const reason = typeof flags.reason === 'string' ? flags.reason : 'moved from the command line'
  await store.transition(caseRow.id, stage, { user: OP, reason })
  const after = await store.getCase(caseRow.id)
  console.log(green(`${after.ref}: ${caseRow.status} -> ${after.status}`) + dim(`  (${reason})`))
  await closeAndExit(store, 0)
}

// Data retention / right-to-erasure CLI trigger (retention-erasure-flow):
// the same store.eraseContact the dashboard's admin-gated Reporters panel
// "Erase PII" button calls -- a break-glass path for a deployment with no
// dashboard access yet, or a scripted compliance run. Irreversible.
// store.eraseContact takes the internal contact id -- an opaque string like
// `mta3r2es-mjgea3m7` that NO casey command prints. `casey cases` and
// `casey show` show the contact's channel identifier and the case ref, so the
// documented break-glass erasure path could not be driven from anything the
// CLI itself puts on screen. All three now resolve to the same contact.
async function resolveContact(store, needle) {
  const contacts = await store.t.list('contact', {}, { limit: 10000 })
  const exact = contacts.find(c => c.id === needle)
  if (exact) return exact
  // A phone number is written +27 82 111 0001 on screen, 27821110001 in the
  // row: compare on the digits and letters, not the spacing an operator copied.
  const norm = (s) => String(s || '').replace(/[^0-9a-z]/gi, '').toLowerCase()
  const key = norm(needle)
  const byExternal = key && contacts.find(c => norm(c.external_id) === key)
  if (byExternal) return byExternal
  const caseRow = await store.getCaseByRef(needle) || await store.getCase(needle)
  if (caseRow?.contact_id) return contacts.find(c => c.id === caseRow.contact_id) || null
  return null
}

// `casey erase-contact --check` with no contact: the standing detector for an
// erasure that started and did not finish. eraseContact is a multi-step,
// partly-filesystem, irreversible action with no transaction available to it
// (see case-store.js's erasure-journal comment), so what makes a mid-run crash
// survivable is the durable plan it writes before the first mutation. This is
// the only thing that reads those plans back to a human.
async function reportIncompleteErasures(store) {
  const open = await store.findIncompleteErasures()
  if (!open.length) {
    console.log(green('no interrupted erasures.'))
    console.log(dim('  every erasure that started has a matching completion in the journal.'))
    await closeAndExit(store, 0)
  }
  say(bad(`${open.length} erasure${open.length === 1 ? '' : 's'} started and never completed.`))
  for (const p of open) {
    console.log(`${bold(p.contactId)}\tstarted ${fmtTimeSAST(Math.floor((p.ts || 0) / 1000)) || '(no time)'}\tby ${p.by || 'system'}`)
    console.log(dim(`  ${(p.caseIds || []).length} case(s), ${(p.siblingIds || []).length} other contact row(s) for the same person`))
    console.log(dim('  re-run it (erasure is idempotent, and the plan above is what a re-run recovers the sibling rows from):'))
    console.log(dim('    ') + cyan(`casey erase-contact ${p.contactId} --yes --reason "completing an interrupted erasure"`))
  }
  await closeAndExit(store, 1)
}

export async function cmdEraseContact({ flags, rest }) {
  const store = await openStore()
  if (flags.check) return reportIncompleteErasures(store)
  const id = rest.find(a => !a.startsWith('--'))
  if (!id) {
    say('usage: casey erase-contact <contact-id|external-id|case-ref> --yes [--reason "..."]')
    say(dim(`  find the contact on a case with ${cyan('casey cases')} or ${cyan('casey show <ref>')}.`))
    await closeAndExit(store, 1)
  }
  const contact = await resolveContact(store, id)
  if (!contact) {
    say(bad(`no contact matches "${id}".`))
    say(dim('  give the contact id, the phone number or handle shown on a case, or the ref of any case they opened'))
    say(dim(`  -- list them with ${cyan('casey cases')}.`))
    await closeAndExit(store, 1)
  }
  // Irreversible, and it ran on a bare argument with no confirmation of any
  // kind: one mistyped ref scrubbed a live reporter's details with nothing to
  // undo it. --yes keeps the scripted compliance path working (there is no TTY
  // in a cron job) while making the destruction something the caller states.
  if (!flags.yes) {
    say(bad(`this would permanently erase the details of ${contact.display_name || contact.external_id || contact.id}.`))
    say(dim('  it cannot be undone. Re-run with --yes if that is what you want:'))
    say(dim('    ') + cyan(`casey erase-contact ${contact.id} --yes --reason "..."`))
    await closeAndExit(store, 1)
  }
  const reason = typeof flags.reason === 'string' ? flags.reason : ''
  try {
    const result = await store.eraseContact(contact.id, { reason, operator: { id: 'cli-operator' } })
    console.log(result.contactErased
      ? green(`erased ${contact.display_name || contact.external_id || contact.id}`)
      // Once scrubbed, display_name and external_id are both the literal
      // '[erased]' -- naming the contact id is the only thing left that
      // identifies which row this was.
      : `contact ${contact.id} was already erased. Nothing changed.`)
    // casesScrubbed carries internal case ids; an operator works in refs.
    const refs = []
    for (const cid of result.casesScrubbed) refs.push((await store.getCase(cid).catch(() => null))?.ref || cid)
    console.log(`cases scrubbed: ${refs.length}` + (refs.length ? '  ' + dim(refs.join(', ')) : ''))
    if (result.casesFailed?.length) say(bad(`${result.casesFailed.length} case(s) could not be scrubbed -- re-run this command, it is idempotent.`))
    if (result.sessionsFailed?.length) say(bad(`${result.sessionsFailed.length} stored conversation(s) could not be removed -- contact content remains on disk at: ${result.sessionsFailed.join(', ')}`))
    // The journal is what makes a crash mid-erasure recoverable. If it could not
    // be written, this run had no safety net and the operator has to know.
    if (result.journalled === false) say(bad('the erasure journal could not be written -- had this run been interrupted, the other contact rows for this person would not have been recoverable. Re-run it once the store is healthy.'))
    await closeAndExit(store, 0)
  } catch (e) { say(bad(e.message)); await closeAndExit(store, 1) }
}

// ---- retention -------------------------------------------------------------
//
// DRY RUN IS THE VERB. `casey retention` with no flags reports what a configured
// policy WOULD do and changes nothing; `--yes` is what executes. That split is
// not politeness -- this deployment's reports dispatch vehicles, so archiving a
// case an operator still needed costs a field visit that never happens, and the
// default has to be the harmless one.
//
// With no policy configured this command prints how to configure one and exits
// 0 without opening any write path. See src/retention.js for why "off" is the
// absence of a policy rather than a flag, and why nothing here is on a timer.
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
    // Deliberately BEFORE any store is opened: with no policy this command
    // touches nothing at all.
    if (flags.json) { console.log(JSON.stringify({ policy: null, configured: false, eligible: [], kept: [] }, null, 2)); return }
    console.log(bold('casey retention') + dim('  (no retention policy configured -- nothing expires, nothing was read)'))
    console.log('Retention is off. Cases are kept forever until a policy says otherwise.')
    console.log(dim('\n  to see what a policy WOULD do, without changing anything:'))
    console.log(dim('    ') + cyan('casey retention --days 365'))
    console.log(dim('  to make it the deployment default, set this in .env:'))
    console.log(dim('    ') + cyan('CASEY_RETENTION_DAYS=365') + dim('   how long a CLOSED case is kept after its last activity'))
    console.log(dim('    ') + cyan(`CASEY_RETENTION_ACTION=${RETENTION_ACTIONS[0]}`) + dim(`  one of: ${RETENTION_ACTIONS.join(', ')} (archive is the default and destroys nothing)`))
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
    console.log(bold('casey retention') + dim(`  DRY RUN -- nothing was changed`))
    console.log(`policy: cases with no activity for ${bold(policy.days + ' days')}, action ${bold(policy.action)}`)
    console.log(dim(`archive would be written to ${archiveRoot}`))
    console.log(`\nscanned ${plan.scanned} case(s): ${bold(String(plan.eligible.length))} would be ${policy.action}d, ${plan.kept.length} kept.\n`)
    if (plan.eligible.length) {
      console.log(bold(`would ${policy.action} (${plan.eligible.length})`))
      for (const c of plan.eligible) console.log(`  ${bold(c.ref)}\t[${c.status}]\t${c.channel}\t${dim(c.detail)}`)
    }
    // The kept list is grouped by reason rather than listed flat: an operator
    // reading a dry-run needs "why is nothing expiring" answered in one glance,
    // and 400 identical lines does not answer it.
    const byReason = new Map()
    for (const c of plan.kept) {
      if (!byReason.has(c.reason)) byReason.set(c.reason, [])
      byReason.get(c.reason).push(c.ref)
    }
    if (byReason.size) {
      console.log(bold(`\nkept (${plan.kept.length})`))
      for (const [reason, refs] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
        console.log(`  ${refs.length}\t${reason}\t${dim(KEEP_REASONS[reason] || reason)}`)
        console.log(dim(`    ${refs.slice(0, 8).join(', ')}${refs.length > 8 ? `, and ${refs.length - 8} more` : ''}`))
      }
    }
    console.log(dim(`\n  nothing above has happened. Run it for real with `) + cyan('casey retention --yes') + dim('.'))
    await closeAndExit(store, 0)
  }

  if (!plan.eligible.length) {
    console.log(green('nothing has aged past the retention window. Nothing was changed.'))
    await closeAndExit(store, 0)
  }
  const result = await executeRetention(store, plan, { operator: 'cli-operator', log: console })
  if (flags.json) {
    console.log(JSON.stringify({ dry_run: false, ...result.manifest }, null, 2))
    await closeAndExit(store, result.failed.length ? 1 : 0)
  }
  console.log(bold('casey retention') + dim(`  (action: ${policy.action})`))
  console.log(`archive written to ${cyan(result.archiveDir)}`)
  for (const a of result.archived) console.log(green(`  ${a.ref}`) + dim(`  ${a.events} event(s), ${a.bytes} bytes -> ${a.file.split('/').pop()}`))
  console.log(`\n${result.archived.length} ${policy.action}d, ${plan.kept.length} kept, ${result.failed.length} failed.`)
  if (policy.action === 'erase') console.log(dim(`stored conversations removed: ${result.sessionsRemoved}`) + (result.sessionsFailed.length ? red(`  could not remove: ${result.sessionsFailed.length}`) : ''))
  for (const f of result.failed) say(bad(`${f.ref}: ${f.error}`))
  console.log(dim('\n  thatcher soft-deletes any row carrying a status column, so these cases have left every'))
  console.log(dim('  read path but their bytes remain in data/db.sqlite until it is vacuumed. The archive'))
  console.log(dim('  directory above holds the only complete copy of each one -- back it up or move it off-host.'))
  await closeAndExit(store, result.failed.length ? 1 : 0)
}

// ---- backup / restore ------------------------------------------------------

export async function cmdBackup({ flags }) {
  const { runBackup } = await import('../src/backup.js')
  const store = await openStore()
  const dataDir = store.dataDir
  // Close the store before snapshotting. VACUUM INTO is safe against a live
  // writer, but the fallback file copy is not, and this command holds the only
  // handle it can do anything about.
  await store.close()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const out = typeof flags.out === 'string' ? flags.out : `backups/casey-${stamp}`
  let result
  try { result = await runBackup({ dataDir, outDir: out }) }
  catch (e) { say(bad(e.message)); process.exit(1) }
  if (flags.json) { console.log(JSON.stringify(result.manifest, null, 2)); process.exit(result.failed.length ? 1 : 0) }
  console.log(bold('casey backup') + dim(`  ${result.dir}`))
  for (const s of result.stores) {
    const mark = s.status === 'ok' ? green('[ok]') : s.status === 'missing' ? dim('[none]') : red('[x]')
    // A store that copied fine but held nothing prints "empty" rather than a
    // blank column: [ok] with nothing beside it reads as "size unknown", and an
    // operator checking a backup needs to be able to tell an empty store from an
    // unmeasured one.
    const size = s.bytes ? dim(`${s.bytes} bytes${s.files ? `, ${s.files} file(s)` : ''}`) : dim(s.status === 'ok' ? 'empty' : '')
    console.log(`  ${mark} ${bold(s.name)}\t${size}`)
    if (s.note) console.log(dim(`      ${s.note}`))
  }
  console.log(bold('\nnot included, on purpose:'))
  for (const n of result.manifest.not_included) console.log(dim(`  ${n.name} -- ${n.why}`))
  if (result.failed.length) {
    // A backup that quietly missed a store is worse than no backup, so a
    // failure is loud AND non-zero rather than a line in the middle of a
    // success report.
    say('')
    say(bad(`${result.failed.length} store(s) could NOT be copied -- this backup is INCOMPLETE and must not be relied on.`))
    for (const f of result.failed) say(bad(`  ${f.name}: ${f.note}`))
    process.exit(1)
  }
  console.log(green('\nbackup complete.') + dim(`  restore it with `) + cyan(`casey restore ${result.dir} --yes`))
  process.exit(0)
}

export async function cmdRestore({ flags, rest }) {
  const { runRestore } = await import('../src/backup.js')
  const dir = rest.find(a => !a.startsWith('--'))
  if (!dir) { say('usage: casey restore <backup-dir> --yes'); process.exit(1) }
  // Resolved without opening the store: restore replaces the very directory the
  // store would open, so it must not be holding a handle on it.
  const dataDir = path.resolve(process.cwd(), 'data')
  if (!flags.yes) {
    say(bad(`this would replace ${dataDir} with the contents of ${dir}.`))
    say(dim('  stop casey first -- restoring underneath a running worker leaves it holding a handle on a file that no longer exists.'))
    say(dim('  the current data directory is MOVED aside rather than deleted, so this is itself recoverable.'))
    say(dim('  re-run with --yes if that is what you want.'))
    process.exit(1)
  }
  let result
  try { result = await runRestore({ backupDir: dir, dataDir }) }
  catch (e) { say(bad(e.message)); process.exit(1) }
  console.log(bold('casey restore') + dim(`  from ${dir}`))
  console.log(green(`  data directory restored to ${result.dataDir}`))
  for (const aside of result.movedAside) console.log(dim(`  previous contents moved aside to ${aside}`))
  console.log(`  stored conversations: ${result.sessions.status === 'ok' ? green('restored') : dim(result.sessions.status)} ${dim(result.sessions.note)}`)
  if (result.manifest.complete === false) {
    say(bad('  the backup manifest records that this backup was INCOMPLETE when it was taken -- one or more stores are missing from it.'))
  }
  console.log(bold('\nnot restored (never backed up, on purpose):'))
  for (const n of result.manifest.not_included) console.log(dim(`  ${n.name} -- ${n.why}`))
  process.exit(0)
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
  // dashboard/auth.js's createAccount accepts admin, secretary and operator.
  // The CLI collapsed everything that was not 'admin' to 'operator', so
  // `--role secretary` reported "created account (role: operator)" and exited
  // 0 -- a flag accepted, silently changed, and confirmed as if it had been
  // honoured. The roles live here once, and an unknown one is refused.
  const ACCOUNT_ROLES = ['admin', 'operator', 'secretary']
  if (sub === 'add') {
    const username = positional[0]
    if (!username) { say('usage: casey operators add <username> [--password ...] [--name ...] [--role admin|operator|secretary]'); await closeAndExit(store, 1) }
    if (flags.role !== undefined) await requireOneOf(store, 'role', flags.role, ACCOUNT_ROLES)
    if (flags.password === true) { say(bad('--password needs a value (omit it entirely to have one generated).')); await closeAndExit(store, 1) }
    const password = typeof flags.password === 'string' ? flags.password : randomBytes(10).toString('hex')
    try {
      const acct = await createAccount(store, { username, password, displayName: typeof flags.name === 'string' ? flags.name : undefined, role: flags.role || 'operator' })
      console.log(green(`created account "${acct.username}" (role: ${acct.role})`))
      if (!flags.password) console.log(dim('  generated password: ') + bold(password) + dim('  -- record this now, it is not shown again'))
      await closeAndExit(store, 0)
    } catch (e) { say(bad(e.message)); await closeAndExit(store, 1) }
  }
  if (sub === 'list') {
    const accounts = await listAccounts(store)
    if (!accounts.length) { console.log('no operator accounts yet.'); console.log(dim('  run ' + cyan('casey operators add <username>') + ' to create one.')); await closeAndExit(store, 0) }
    for (const a of accounts) {
      const status = a.disabled === '1' ? red('[disabled]') : green('[active]')
      // last_login_at is stored as an ISO-8601 UTC string. Every other date this
      // CLI prints goes through fmtTimeSAST, so an operator reading two commands
      // side by side was comparing 2026-09-05T12:30:21.365Z against
      // "05 Sept 2026, 14:30 SAST" and doing the offset in their head.
      const seen = a.last_login_at ? fmtTimeSAST(Math.floor(Date.parse(a.last_login_at) / 1000)) : null
      console.log(`${bold(a.username)}\t${a.role}\t${status}\t${a.display_name || ''}\t${dim(seen || 'never logged in')}`)
    }
    await closeAndExit(store, 0)
  }
  if (sub === 'disable' || sub === 'enable') {
    const username = positional[0]
    if (!username) { say(`usage: casey operators ${sub} <username>`); await closeAndExit(store, 1) }
    const acct = await findAccountByUsername(store, username)
    if (!acct) { say(bad(`no account "${username}".`)); say(dim(`  list them with ${cyan('casey operators list')}.`)); await closeAndExit(store, 1) }
    const already = (acct.disabled === '1') === (sub === 'disable')
    await setAccountDisabled(store, acct.id, sub === 'disable')
    console.log(already
      ? `account "${acct.username}" was already ${sub === 'disable' ? 'disabled' : 'enabled'}.`
      : green(`account "${acct.username}" ${sub === 'disable' ? 'disabled' : 'enabled'}`))
    await closeAndExit(store, 0)
  }
  if (sub) say(bad(`casey operators has no "${sub}" subcommand.`))
  say('usage: casey operators <add|list|disable|enable> ...')
  await closeAndExit(store, 1)
}
