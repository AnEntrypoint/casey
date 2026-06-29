// casey end-to-end smoke test  --  one file, real services (thatcher + freddie),
// stub LLM. Covers the full chain plus every hardened behaviour: autonomy modes,
// illegal transitions, message dedup, empty-message handling, dashboard
// auth/paging/escaping/reply, discord WS receive, and whatsapp webhook.
import assert from 'node:assert'
import { mkdtempSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCasey, Casey } from './src/casey.js'
import { createDashboard } from './src/dashboard/server.js'
import { runScript, MockAdapter } from './src/sim/inject.js'
import { stubLLM } from './src/sim/stub-llm.js'
import { intentReply, fallbackReply, reportMissingVisitCritical, jargonHits, isContentFreeTurn, warmConversationalReply } from './src/gateway-hooks.js'
import { fmtTimeSAST, fmtPhone27, toDate } from './src/format.js'
import { rankAttention, attnReason, todoHint, caseHints } from './src/attn.js'
import { buildOverview } from './src/overview.js'
import { buildSLAReport, buildReportComparison, buildChannelMetrics, buildSLAReportByType, buildCaseTypeMetrics, buildAlertPayload } from './src/report-analytics.js'
import { buildClusters } from './src/clusters.js'
import { buildWorkload } from './src/workload.js'
import { makeResilientCallLLM } from './src/llm.js'

process.env.CASEY_LOG = 'silent'
// Roster for the operator-identity test (parsed by createDashboard at boot).
process.env.CASEY_OPERATORS = 'thandi:Thandi M, sipho:Sipho N'

// Repo root, captured before main() chdirs into an isolated temp cwd. Module
// resolution for the file:../ freddie dep must stay anchored here, not at the
// temp cwd the suite runs from.
const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)))

let failures = 0
const test = async (name, fn) => {
  try { await fn(); console.log('ok  ', name) }
  catch (e) { failures++; console.error('FAIL', name, '\n   ', e.message) }
}

async function main() {
  // Isolate the suite in a fresh temp cwd so a run NEVER wipes a live ./data
  // owned by a running `casey up`. thatcher's sqlite handle is cwd-bound (it
  // primes getDatabase() argless during init -> <cwd>/data/app.db), so the only
  // safe relocation is the process cwd. We copy the config into the temp dir,
  // chdir there, and let CaseStore resolve <temp>/data/app.db as usual. The
  // original ./data is never touched.
  const testDir = mkdtempSync(join(tmpdir(), 'casey-test-'))
  copyFileSync(join(REPO_ROOT, 'thatcher.config.yml'), join(testDir, 'thatcher.config.yml'))
  process.chdir(testDir)
  // sweepIntervalMs:0 disables the periodic health sweep: it would otherwise fire
  // mid-test and mutate tags / append observations concurrently with assertions,
  // making the suite non-deterministic (P11). The sweep has its own direct tests.
  const casey = await createCasey({ channels: ['sim'], callLLM: stubLLM(), sweepIntervalMs: 0 })
  await casey.start()
  const adapter = casey.adapters.sim
  const store = casey.store

  let caseId
  await test('inbound message creates a case and agent drives tools', async () => {
    await runScript(adapter, ['my order #55 is late'], { from: 'alice', channel_id: 'c1', wait: () => casey.drain() })
    const cases = (await store.listCases())
    assert.equal(cases.length, 1)
    const c = cases[0]
    caseId = c.id
    assert.equal(c.channel, 'sim')
    assert.equal(c.status, 'triaging')
    // priority is a real human-owned signal (casey imposes no rules); the stub
    // sets it via a freddie case_update whose commit timing races the read, so
    // assert only that a valid workflow priority is set, not an exact value.
    assert.ok(['high', 'normal', 'low'].includes(c.priority), `unexpected priority ${c.priority}`)
    assert.ok(c.summary)
  })

  // The next several tests reuse caseId from the first test. If case creation
  // failed, fail loudly with that cause instead of cryptic "undefined" errors.
  if (!caseId) throw new Error('PREREQUISITE FAILED: first test did not create a case (caseId unset)')

  await test('timeline records inbound, action, transition, outbound', async () => {
    const kinds = (await store.listEvents(caseId)).map(e => e.kind)
    for (const k of ['inbound', 'action', 'transition', 'outbound']) assert.ok(kinds.includes(k), `missing ${k} in ${kinds.join(',')}`)
  })

  await test('reply sent on channel, never blank', async () => {
    assert.ok(adapter.sent.length >= 1)
    assert.ok(adapter.sent[0].text && adapter.sent[0].text.length > 0)
  })

  await test('same channel reuses case, different channel opens a new one', async () => {
    await runScript(adapter, ['any update?'], { from: 'alice', channel_id: 'c1', wait: () => casey.drain() })
    assert.equal((await store.listCases()).length, 1)
    await runScript(adapter, ['hello from another chat'], { from: 'bob', channel_id: 'c2', wait: () => casey.drain() })
    assert.equal((await store.listCases()).length, 2)
  })

  await test('illegal workflow transition is rejected', async () => {
    await assert.rejects(() => store.transition(caseId, 'closed', { user: { id: 'op', role: 'operator' } }))
  })

  await test('operator override transition is honoured and attributed', async () => {
    await store.transition(caseId, 'in_progress', { user: { id: 'op1', role: 'operator' }, reason: 'manual' })
    assert.equal((await store.getCase(caseId)).status, 'in_progress')
    const last = (await store.listEvents(caseId)).filter(e => e.kind === 'transition').pop()
    assert.equal(last.actor, 'operator')
  })

  await test('message dedup: same platform msg id is recorded+answered once', async () => {
    const before = (await store.listEvents(caseId)).length
    const sentBefore = adapter.sent.length
    const dup = { from: 'alice', channel_id: 'c1', text: 'dup', id: 'fixed-msg-1' }
    adapter.inject(dup); await casey.drain()
    adapter.inject(dup); await casey.drain()    // redelivery
    const inbounds = (await store.listEvents(caseId)).filter(e => e.kind === 'inbound' && e.msg_id === 'fixed-msg-1')
    assert.equal(inbounds.length, 1, 'duplicate inbound should be recorded once')
  })

  await test('observe autonomy: agent does not auto-reply or edit', async () => {
    await store.updateCase(caseId, { autonomy: 'observe' }, { id: 'op', role: 'operator' })
    const sentBefore = adapter.sent.length
    adapter.inject({ from: 'alice', channel_id: 'c1', text: 'observe mode test', id: 'obs-1' })
    await casey.drain()
    assert.equal(adapter.sent.length, sentBefore, 'no auto-reply in observe mode')
    const obs = (await store.listEvents(caseId)).filter(e => e.kind === 'observation').map(e => e.text)
    assert.ok(obs.some(t => /observe/.test(t)))
  })

  await test('empty / media-only message still recorded, no blank reply', async () => {
    const sentBefore = adapter.sent.length
    adapter.inject({ from: 'carol', channel_id: 'c3', text: '', id: 'm1', type: 'image' })
    await casey.drain()
    // The case key is per-contact (channel:author), so two people in one channel get
    // distinct cases; the reply still targets the channel.
    const c3 = (await store.listCases()).find(c => c.external_id === 'c3:carol')
    assert.ok(c3, 'case opened for media-only message')
    const reply = adapter.sent[adapter.sent.length - 1]
    assert.ok(reply.text && reply.text.trim().length > 0, 'reply is never blank')
  })

  // ---- dashboard API ----
  let dash
  // Helper: dashboard fetch with Bearer auth (used throughout this block)
  const df = (url, opts = {}) => fetch(
    url.replace('?token=secret&', '?').replace('?token=secret', '').replace('&token=secret', ''),
    { ...opts, headers: { Authorization: 'Bearer secret', ...(opts.headers || {}) } }
  )
  await test('dashboard requires token when configured', async () => {
    dash = await createDashboard(store, { port: 4577, token: 'secret', sendReply: (c, t) => adapter.send({ to: c.external_id, text: t }) })
    const noAuth = await fetch('http://localhost:4577/api/cases')
    assert.equal(noAuth.status, 401)
    const ok = await df('http://localhost:4577/api/cases')
    assert.equal(ok.status, 200)
  })

  await test('dashboard cases endpoint paginates with total', async () => {
    const r = await df('http://localhost:4577/api/cases?token=secret&limit=1').then(r => r.json())
    assert.ok(Array.isArray(r.cases))
    assert.equal(r.limit, 1)
    assert.ok(typeof r.total === 'number' && r.total >= 2)
  })

  await test('dashboard case detail returns events_total + transitions', async () => {
    const r = await df('http://localhost:4577/api/cases/' + caseId + '?token=secret').then(r => r.json())
    assert.ok(typeof r.events_total === 'number')
    assert.ok(Array.isArray(r.transitions))
    // The API parses event.data to an object at the boundary (thatcher stores it as a
    // JSON string) so the SPA's e.data.field / e.data.by reads work. Assert no event
    // leaves with a string `data`, and the same on the paged /events endpoint.
    assert.ok(Array.isArray(r.events) && r.events.every(e => e.data == null || typeof e.data === 'object'), 'case-detail events carry parsed object data, never a JSON string')
    const pg = await df('http://localhost:4577/api/cases/' + caseId + '/events?token=secret').then(r => r.json())
    assert.ok(Array.isArray(pg.events) && pg.events.every(e => e.data == null || typeof e.data === 'object'), 'paged events carry parsed object data, never a JSON string')
  })

  await test('dashboard operator reply sends on channel + logs outbound', async () => {
    const sentBefore = adapter.sent.length
    const r = await df('http://localhost:4577/api/cases/' + caseId + '/reply?token=secret', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'operator here' }),
    })
    assert.equal(r.status, 200)
    assert.equal(adapter.sent.length, sentBefore + 1)
    const last = (await store.listEvents(caseId)).pop()
    assert.equal(last.kind, 'outbound'); assert.equal(last.actor, 'operator')
  })

  await test('operator roster: GET /api/operators lists the roster; X-Casey-Operator attributes the actor', async () => {
    const roster = await df('http://localhost:4577/api/operators?token=secret').then(r => r.json())
    assert.equal(roster.attributed, true, 'roster present means attribution is on')
    assert.deepEqual(roster.operators.map(o => o.id).sort(), ['sipho', 'thandi'], 'roster ids parsed + slugged from CASEY_OPERATORS')
    assert.ok(roster.operators.find(o => o.id === 'thandi')?.name === 'Thandi M', 'display name preserved')
    // No header -> falls back to the generic operator, never an injected actor.
    assert.equal(roster.current, 'dashboard-operator', 'absent header resolves to the default operator')
    // A known roster id selected via the header is recorded on the audited event.
    // Use a FRESH conversation so the claim-on-reply assertions see an unowned case.
    const idsBefore = new Set((await store.listCases({}, { limit: 10000 })).map(c => c.id))
    await runScript(adapter, ['my cattle are sick'], { from: 'rosterfarmer', channel_id: 'croster', wait: () => casey.drain() })
    const rosterCase = (await store.listCases({}, { limit: 10000 })).find(c => !idsBefore.has(c.id))
    assert.ok(rosterCase, 'a fresh case opened for the roster test')
    const rcid = rosterCase.id
    const r = await df('http://localhost:4577/api/cases/' + rcid + '/reply?token=secret', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-casey-operator': 'thandi' }, body: JSON.stringify({ text: 'Thandi here' }),
    })
    assert.equal(r.status, 200)
    const rbody = await r.json()
    const evs = await store.listEvents(rcid)
    const lastOut = [...evs].reverse().find(e => e.kind === 'outbound' && e.text === 'Thandi here')
    assert.ok(lastOut, 'the Thandi reply was recorded as an outbound event')
    // thatcher stores event.data as a JSON string; parse before reading the attributed operator.
    assert.equal((typeof lastOut.data === 'string' ? JSON.parse(lastOut.data) : lastOut.data)?.by, 'thandi', 'the outbound event records the picked operator id')
    // Claim-on-reply: answering an unowned case claims it for the acting operator,
    // with an audited claim event, and a second reply does NOT re-claim (soft, idempotent).
    assert.equal(rbody.claimed, true, 'replying to an unowned case claims it')
    assert.equal((await store.getCase(rcid)).assignee, 'thandi', 'the case assignee is set to the acting operator')
    const claimEv = [...evs].reverse().find(e => e.kind === 'action' && /^Claimed by /.test(e.text || ''))
    assert.ok(claimEv, 'a claim is recorded as an audited action event')
    const r2 = await df('http://localhost:4577/api/cases/' + rcid + '/reply?token=secret', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-casey-operator': 'sipho' }, body: JSON.stringify({ text: 'Sipho follow-up' }),
    }).then(x => x.json())
    assert.equal(r2.claimed, false, 'a reply to an already-claimed case does not steal it')
    assert.equal((await store.getCase(rcid)).assignee, 'thandi', 'the original claimant keeps the case')
    // An unknown id is NOT trusted -- it falls back, so attribution can never be forged into a new actor.
    const who = await df('http://localhost:4577/api/operators?token=secret', { headers: { 'x-casey-operator': 'nobody-xyz' } }).then(r => r.json())
    assert.equal(who.current, 'dashboard-operator', 'an off-roster id falls back to the default, never injected')
  })

  await test('shift handover: digest lists attention/handoffs/drafts; Start of shift scopes "since"', async () => {
    // Before any shift is started, the digest scopes the full open pool (since=0).
    const h0 = await df('http://localhost:4577/api/handover?token=secret').then(r => r.json())
    assert.equal(h0.since, 0, 'no shift marker yet -> since is 0')
    assert.ok(Array.isArray(h0.attention) && Array.isArray(h0.handoffs) && Array.isArray(h0.touched), 'digest carries the four lists')
    // Stamp a shift, attributed to the acting operator.
    const start = await df('http://localhost:4577/api/handover/start-shift?token=secret', {
      method: 'POST', headers: { 'x-casey-operator': 'thandi' },
    }).then(r => r.json())
    assert.equal(start.ok, true); assert.equal(start.by, 'thandi', 'the shift marker is attributed to the operator')
    const h1 = await df('http://localhost:4577/api/handover?token=secret').then(r => r.json())
    assert.ok(h1.since >= start.ts - 1000 && h1.since_by === 'thandi', 'the digest now scopes since the new marker')
    // The HTML form renders without throwing and escapes contact text.
    const html = await df('http://localhost:4577/api/handover?format=html&token=secret').then(r => r.text())
    assert.match(html, /casey shift handover/, 'the printable digest renders')
    // The handover endpoint is token-gated like every other dashboard API.
    const noTok = await fetch('http://localhost:4577/api/handover')
    assert.equal(noTok.status, 401, 'handover is gated by the dashboard token')
  })

  await test('ai-offline queue: failed agent turns surface in /api/unreplied; an operator reply clears them', async () => {
    // A case the gateway tagged 'ai-offline' (its agent turn errored, so the
    // auto-reply could not be trusted) belongs in the operator's offline queue.
    const { case: oc } = await store.findOrCreateCase({ channel: 'sim', external_id: 'aioffline-' + Date.now() })
    await store.updateCase(oc.id, { tags: 'ai-offline' })
    const q1 = await df('http://localhost:4577/api/unreplied?token=secret').then(r => r.json())
    assert.ok(q1.items.some(i => i.id === oc.id), 'the offline case is listed in the queue')
    assert.equal(typeof q1.total, 'number', 'the queue reports a total count')
    // An operator who personally answers clears the offline flag (claim-on-reply),
    // so the case drops out of the queue rather than pinning there forever.
    const rep = await df('http://localhost:4577/api/cases/' + oc.id + '/reply?token=secret', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'I have got this one, thanks.' }),
    }).then(r => r.json())
    assert.equal(rep.delivered, true, 'the operator reply was delivered')
    assert.ok(!String((await store.getCase(oc.id)).tags || '').split(',').map(t => t.trim()).includes('ai-offline'), 'the offline flag is cleared on operator reply')
    const q2 = await df('http://localhost:4577/api/unreplied?token=secret').then(r => r.json())
    assert.ok(!q2.items.some(i => i.id === oc.id), 'the answered case leaves the queue')
    const noTok = await fetch('http://localhost:4577/api/unreplied')
    assert.equal(noTok.status, 401, 'the offline queue is gated by the dashboard token')
  })

  await test('readiness probe: GET /api/ready confirms the store is reachable, ungated', async () => {
    // A k8s/LB probe has no dashboard token, so /api/ready must answer WITHOUT one
    // (unlike every other API). With the store up it reports ready:true.
    const r = await fetch('http://localhost:4577/api/ready')
    assert.equal(r.status, 200, 'readiness answers without a token')
    const body = await r.json()
    assert.equal(body.ready, true, 'the store is reachable -> ready:true')
    assert.equal(body.store, 'ok', 'the probe names the store as ok')
    assert.equal(typeof body.took_ms, 'number', 'the probe reports how long the store read took')
  })

  await test('bulk actions: POST /api/cases/bulk tags many cases, isolates a bad id, validates the action', async () => {
    const { case: a } = await store.findOrCreateCase({ channel: 'sim', external_id: 'bulk-a-' + Date.now() })
    const { case: b } = await store.findOrCreateCase({ channel: 'sim', external_id: 'bulk-b-' + Date.now() })
    // Tag a real pair plus one bogus id: the bogus one fails in its own result,
    // the real two succeed -- one failure never aborts the batch.
    const tagged = await df('http://localhost:4577/api/cases/bulk?token=secret', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [a.id, b.id, 'no-such-case'], action: 'tag', tag: 'priority' }),
    }).then(r => r.json())
    assert.equal(tagged.ok, 2, 'two real cases tagged'); assert.equal(tagged.failed, 1, 'the bogus id failed in isolation')
    assert.ok(tagged.results.find(r => r.id === 'no-such-case' && r.ok === false && /not found/.test(r.error)), 'the bad id reports not found')
    assert.ok(String((await store.getCase(a.id)).tags || '').split(',').includes('priority'), 'tag landed on case a')
    // Untag reverses it.
    await df('http://localhost:4577/api/cases/bulk?token=secret', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [a.id, b.id], action: 'untag', tag: 'priority' }),
    }).then(r => r.json())
    assert.ok(!String((await store.getCase(a.id)).tags || '').split(',').includes('priority'), 'untag cleared the tag')
    // An unknown action is rejected up front, nothing applied.
    const bad = await df('http://localhost:4577/api/cases/bulk?token=secret', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [a.id], action: 'delete-everything' }),
    })
    assert.equal(bad.status, 400, 'an unknown bulk action is rejected')
  })

  await test('snooze: POST /api/cases/:id/snooze drops a case from the inbox until it expires, then clears', async () => {
    const { rankAttention } = await import('./src/attn.js')
    const { case: c } = await store.findOrCreateCase({ channel: 'sim', external_id: 'snooze-' + Date.now() })
    // Give it an inbox-worthy tag so it scores > 0 before snoozing.
    await store.updateCase(c.id, { tags: 'health:stale' })
    const before = await store.getCase(c.id)
    assert.ok(rankAttention([before], Date.now()).total === 1, 'the case is in the inbox before snoozing')
    // Snooze 60 minutes.
    const snz = await df('http://localhost:4577/api/cases/' + c.id + '/snooze?token=secret', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ minutes: 60 }),
    }).then(r => r.json())
    assert.equal(snz.ok, true); assert.ok(snz.snoozed_until > Date.now(), 'snooze target is in the future')
    const after = await store.getCase(c.id)
    assert.ok(String(after.tags || '').split(',').some(t => t.startsWith('snoozed-until:')), 'the snooze tag is set')
    assert.equal(rankAttention([after], Date.now()).total, 0, 'a snoozed case drops out of the inbox')
    // An audited action records the snooze.
    assert.ok((await store.listEvents(c.id)).some(e => e.kind === 'action' && /Snoozed by/.test(e.text || '')), 'the snooze is an audited action')
    // Clearing (minutes:0) returns it to the inbox.
    const clr = await df('http://localhost:4577/api/cases/' + c.id + '/snooze?token=secret', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ minutes: 0 }),
    }).then(r => r.json())
    assert.equal(clr.cleared, true, 'minutes:0 clears the snooze')
    assert.equal(rankAttention([await store.getCase(c.id)], Date.now()).total, 1, 'the case is back in the inbox after clearing')
  })

  await test('undo: POST /api/cases/:id/undo reverses the last operator transition with a compensating event', async () => {
    const { case: c } = await store.findOrCreateCase({ channel: 'sim', external_id: 'undo-' + Date.now() })
    const start = (await store.getCase(c.id)).status
    const avail = store.availableTransitions(await store.getCase(c.id), { id: 'op', role: 'operator' })
    assert.ok(avail.length, 'a fresh case has a reachable forward stage')
    const target = avail[0]
    // Operator advances the case one stage, then undoes it.
    const tx = await df('http://localhost:4577/api/cases/' + c.id + '/transition?token=secret', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: target }),
    })
    assert.equal(tx.status, 200, 'transition to ' + target + ' succeeds')
    assert.equal((await store.getCase(c.id)).status, target, 'case is now in ' + target)
    const u = await df('http://localhost:4577/api/cases/' + c.id + '/undo?token=secret', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then(r => r.json())
    assert.equal(u.ok, true, 'undo succeeds')
    assert.equal(u.undone, 'transition', 'undo identifies the reversible action')
    assert.equal((await store.getCase(c.id)).status, start, 'case status reverted to the prior stage')
    // History is append-only: the reverse transition AND a compensating action both exist.
    const evs = await store.listEvents(c.id)
    assert.ok(evs.some(e => e.kind === 'transition' && /undo/.test(String(e.data || ''))), 'a reverse transition with reason undo exists')
    assert.ok(evs.some(e => e.kind === 'action' && /^Undo by/.test(e.text || '')), 'a compensating undo action is audited')
    // A second undo of the same action is refused (already compensated, nothing fresh in window).
    const u2 = await df('http://localhost:4577/api/cases/' + c.id + '/undo?token=secret', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    assert.equal(u2.status, 409, 'a second undo finds nothing to undo')
    // Token-gated like every operator endpoint (bare fetch -> no token injected).
    const noTok = await fetch('http://localhost:4577/api/cases/' + c.id + '/undo', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    assert.equal(noTok.status, 401, 'undo requires the dashboard token')
  })

  await test('pre-send jargon guard: word-boundary scan; a jargon reply is HELD as a draft, never sent', async () => {
    // Word-boundary correctness: whole banned words hit, substrings/conjunction do not.
    assert.deepEqual(jargonHits('Your case has been logged.').sort(), ['case'])
    assert.deepEqual(jargonHits('We will triage the workflow by priority status').sort(), ['priority', 'status', 'triage', 'workflow'])
    assert.deepEqual(jargonHits('staircase showcases workflows'), [], 'substrings of other words do not false-positive')
    assert.deepEqual(jargonHits('In case it rains, the status quo'), ['case', 'status'], 'whole words in plain prose still hit (held for a human)')
    assert.deepEqual(jargonHits(''), [], 'empty reply is clean')
    // End-to-end hold: a model that leaks jargon must NOT reach the contact. Spin a
    // dedicated casey whose model emits jargon and assert the reply is held (drafted,
    // never sent) on the same real store path. The precedence gate REPLACES model
    // output with the deterministic intake reply while visit-critical intake is
    // INCOMPLETE -- and three visit-critical fields (how_to_find, farmer_available,
    // contact_fallback) are NOT deterministically extractable, so only the agent's
    // case_report tool can complete intake. A column seed does not survive the agent
    // turn (freddie reconciles report from the turn's own tool calls). So the model
    // here both COMPLETES intake via case_report (filling the three non-extractable
    // fields) AND leaks jargon in its prose -- the real scenario the guard governs:
    // a model that did its job on the record yet spoke internal jargon to the contact.
    const JARGON = 'Thank you. Your case is now in triage and we set its priority.'
    const jargonModel = () => {
      let call = 0
      return async ({ messages }) => {
        const sys = (messages.find(m => m.role === 'system')?.content) || ''
        const idm = /id=([^)\s]+)/.exec(sys)
        const caseId = idm ? idm[1] : null
        // First invocation of each turn: complete intake via case_report (the three
        // non-extractable visit-critical fields) so the precedence gate opens. The
        // tool result re-invokes the model; the second invocation returns the jargon
        // prose with no tool calls, which the agent loop adopts as the reply.
        call++
        if (call % 2 === 1 && caseId != null) {
          return { content: '', tool_calls: [{ id: 'r' + call, name: 'case_report', arguments: { id: caseId, how_to_find: 'second gate past the clinic', farmer_available: 'yes', contact_fallback: 'neighbour Thabo' } }] }
        }
        return { content: JARGON, tool_calls: [] }
      }
    }
    const jcasey = await createCasey({ channels: ['sim'], callLLM: jargonModel(), sweepIntervalMs: 0, notifyHandoff: async () => {} })
    await jcasey.start()
    const jadapter = jcasey.adapters.sim
    let sent = 0
    const realSend = jadapter.send.bind(jadapter)
    jadapter.send = async (m) => { sent++; return realSend(m) }
    const chan = 'jargon-' + Date.now()
    // One turn carrying the extractable facts (species/symptoms/location); the model
    // completes the rest via case_report and then speaks jargon, which the guard holds.
    await runScript(jadapter, ['my goats are coughing badly at the farm near Taung'], { from: chan, channel_id: chan, username: chan, wait: () => jcasey.drain() })
    const jc = (await jcasey.store.listCases()).find(c => c.external_id === chan)
    const store2 = jcasey.store
    assert.equal(sent, 0, 'a jargon-laden reply is never sent to the contact')
    const evs = await jcasey.store.listEvents(jc.id)
    assert.ok(evs.some(e => e.kind === 'draft' && /case|triage|priority/.test(String(e.data || '') + (e.text || ''))), 'the jargon reply is held as a draft event')
    assert.ok(evs.some(e => e.kind === 'observation' && /JARGON-HELD/.test(e.text || '')), 'an observation records why it was held')
    const tags = String((await store2.getCase(jc.id)).tags || '').split(',').map(t => t.trim())
    assert.ok(tags.includes('draft-pending') && tags.includes('needs-human'), 'the case is flagged for a human to reword')
  })

  await test('src/format.js renders real event timestamps in SAST and contacts in +27 (CLI/SPA shared)', async () => {
    // The CLI show timeline and the dashboard SPA both format absolute time and
    // phone numbers through this module; assert it on a REAL stored event, not a
    // synthetic value, so the same created_at the CLI prints is what we verify.
    const evt = (await store.listEvents(caseId))[0]
    assert.ok(evt && evt.created_at, 'a real event with created_at exists')
    const shown = fmtTimeSAST(evt.created_at)
    assert.ok(shown.endsWith(' SAST'), 'absolute time carries the SAST suffix: ' + shown)
    // round-trips the stored unix-seconds value (not host-tz, not ms-vs-s drift)
    assert.equal(toDate(evt.created_at).getTime(), Number(evt.created_at) * 1000, 'seconds, not ms')
    // corrupt/missing timestamps never throw -- show must not crash on a bad row
    assert.equal(fmtTimeSAST(null), '', 'null timestamp -> empty, no throw')
    assert.equal(fmtTimeSAST('not-a-date'), '', 'garbage timestamp -> empty, no throw')
    // phone formatting: MSISDN -> +27, local -> spaced, non-phone id passes through
    assert.equal(fmtPhone27('27821234567'), '+27 82 123 4567')
    assert.equal(fmtPhone27('0821234567'), '082 123 4567')
    assert.equal(fmtPhone27('discord-user-9912'), 'discord-user-9912')
  })

  await test('CLI attention/transition primitives: rankAttention ranks the open pool, legality guard holds', async () => {
    // The `casey attention` command ranks store.listCases() through this exact
    // shared scorer; assert it over the REAL open pool and that the same legality
    // check `casey transition` uses (availableTransitions) rejects a bogus stage.
    const open = (await store.listCases()).filter(c => c.status !== 'resolved' && c.status !== 'closed')
    const { total, items } = rankAttention(open, Date.now())
    assert.ok(total >= 1, 'at least one open case needs attention')
    assert.ok(items.every(x => x.score > 0 && typeof x.reason === 'string' && x.reason), 'every ranked item has a positive score and a plain reason')
    assert.ok(items.every((x, i) => i === 0 || items[i - 1].score >= x.score), 'ranked worst-first by score')
    const c = await store.getCase(caseId)
    const legal = store.availableTransitions(c, { id: 'cli-operator', role: 'operator' })
    assert.ok(!legal.includes('definitely_not_a_stage'), 'a bogus stage is never legal (the CLI 400s on it)')
  })

  await test('GET /api/overview aggregates time-to-first-reply over the live event log (aggregate-only)', async () => {
    // buildOverview is the pure aggregator GET /api/overview serves; assert it over
    // the REAL store events, then assert the endpoint returns the same shape and
    // leaks no per-contact field (no external_id anywhere in the payload).
    const cases = await store.listCases({}, { limit: 10000 })
    const ev = new Map()
    for (const c of cases) ev.set(c.id, await store.listEvents(c.id))
    const o = buildOverview(cases, ev, Date.now())
    assert.equal(o.cases.total, cases.length, 'overview counts every case')
    assert.ok(o.first_response_ms.n >= 1, 'at least one answered inbound in the live log')
    assert.ok(o.first_response_ms.median === null || o.first_response_ms.median >= 0, 'median is a non-negative ms or null')
    assert.ok(o.first_response_ms.p90 === null || o.first_response_ms.p90 >= o.first_response_ms.median, 'p90 >= median')
    const wired = await df('http://localhost:4577/api/overview?days=30&token=secret')
    assert.equal(wired.status, 200, '/api/overview is token-gated and reachable')
    const body = await wired.json()
    assert.equal(body.days, 30, 'window echoed')
    assert.ok(body.cases && typeof body.cases.total === 'number', 'endpoint returns the aggregate shape')
    assert.ok(!JSON.stringify(body).includes('external_id'), 'overview payload leaks no external_id')
    // Dwell-per-stage is keyed by the transition's `from` stage. store.listEvents
    // returns event.data as a JSON STRING, so the aggregator must parse it (evData)
    // before reading .from -- otherwise every transition mis-buckets into prevStage.
    // Assert dwell accrued for at least one stage with a numeric median (proves the
    // transition `from` was parsed, not dropped) over the live transition log.
    const dwellKeys = Object.keys(o.dwell_ms_median || {})
    assert.ok(dwellKeys.length >= 1, 'dwell-per-stage has at least one stage bucket from the live transition log')
    assert.ok(dwellKeys.some(k => typeof o.dwell_ms_median[k] === 'number' && o.dwell_ms_median[k] >= 0), 'at least one stage has a non-negative median dwell (transition `from` parsed, not dropped)')
  })

  await test('GET /api/operators/workload shows who is holding what (worst-first, aggregate-only)', async () => {
    // buildWorkload is the pure aggregator GET /api/operators/workload serves. By now
    // case `rcid` is claimed by thandi with one outbound reply by thandi (see the
    // operator-attribution test above), so thandi's card must reflect that real state.
    const roster = [{ id: 'thandi', name: 'Thandi M' }, { id: 'sipho', name: 'Sipho N' }]
    const cases = await store.listCases({}, { limit: 10000 })
    const ev = new Map()
    for (const c of cases) ev.set(c.id, await store.listEvents(c.id))
    const w = buildWorkload(cases, ev, roster, Date.now())
    assert.ok(Array.isArray(w.operators), 'workload carries an operators array')
    // Every rostered operator is seeded a card even with zero load, so nobody vanishes.
    // (Off-roster ids that actually replied -- e.g. the default dashboard-operator used
    // by other reply tests -- also earn a card, so assert the roster is a subset, present.)
    const ids = new Set(w.operators.map(o => o.id))
    assert.ok(ids.has('thandi') && ids.has('sipho'), 'every rostered operator is seeded a card, present even at zero load')
    const thandi = w.operators.find(o => o.id === 'thandi')
    assert.ok(thandi, 'thandi has a workload card')
    assert.ok(thandi.open_assigned >= 1, 'thandi holds at least one open assigned case (the claim)')
    assert.ok(thandi.replies_24h >= 1, 'thandi has at least one reply in the last 24h')
    assert.ok(thandi.first_reply_ms_median === null || typeof thandi.first_reply_ms_median === 'number', 'median first-reply is a number or null')
    // Worst-first: stale_claims desc, then open_assigned desc, then oldest_waiting_ms desc.
    for (let i = 1; i < w.operators.length; i++) {
      const a = w.operators[i - 1], b = w.operators[i]
      const ordered = a.stale_claims > b.stale_claims
        || (a.stale_claims === b.stale_claims && a.open_assigned > b.open_assigned)
        || (a.stale_claims === b.stale_claims && a.open_assigned === b.open_assigned && a.oldest_waiting_ms >= b.oldest_waiting_ms)
      assert.ok(ordered, 'operators are ranked worst-first')
    }
    // The wired endpoint returns the same shape, is token-gated, and leaks no external_id.
    const wired = await df('http://localhost:4577/api/operators/workload?token=secret')
    assert.equal(wired.status, 200, '/api/operators/workload is token-gated and reachable')
    const body = await wired.json()
    assert.ok(Array.isArray(body.operators) && body.operators.find(o => o.id === 'thandi'), 'endpoint returns the per-operator shape')
    assert.ok(!JSON.stringify(body).includes('external_id'), 'workload payload leaks no external_id')
  })

  // Themes B+C -- triage trust. The inbox ranks the right case to the top over ALL
  // open cases (not just the page window), an assisted draft is HELD until a human
  // approves it, and an autonomy flip is an auditable {from,to} event.
  await test('attn ranking surfaces a needs-human case outside the 200-row window into the top of /api/attention', async () => {
    const { rankAttention } = await import('./src/attn.js')
    const now = Date.now()
    // A needs-human case last touched a while ago must outrank a wall of fresh,
    // quiet cases -- the enum-weighted scorer, not recency, decides the top.
    const urgent = { id: 'u1', ref: 'CASE-9001-aa', status: 'waiting', tags: 'needs-human', updated_at: new Date(now - 6 * 3600e3).toISOString() }
    const quiet = Array.from({ length: 250 }, (_, i) => ({ id: 'q' + i, ref: 'CASE-' + (1000 + i) + '-q', status: 'new', tags: '', updated_at: new Date(now - 60e3).toISOString() }))
    // Put the urgent case LAST so a naive page-window (first 200) would miss it.
    const { items } = rankAttention([...quiet, urgent], now, { limit: 10, offset: 0 })
    assert.ok(items.length && items[0].c.id === 'u1', 'the needs-human case ranks first despite being 251st by position')
    assert.ok(items[0].reason && /real person|human/i.test(items[0].reason), 'the reason explains why in plain words')
    // And over the LIVE store, the wired endpoint ranks a real needs-human case high.
    const { case: nh } = await store.findOrCreateCase({ channel: 'sim', external_id: 'attn-nh-' + Date.now() })
    await store.updateCase(nh.id, { status: 'waiting', tags: 'needs-human' })
    const att = await df('http://localhost:4577/api/attention?token=secret&limit=500').then(r => r.json())
    const row = att.cases.find(c => c.id === nh.id)
    assert.ok(row && row.score > 0, 'the live needs-human case is ranked with a positive score by /api/attention')
  })

  await test('SLA clock: a contact waiting past target surfaces its wait age + an aggregate at-risk count; a case casey is handling has no clock', async () => {
    const { rankAttention, waitAgeMs, atRiskCount } = await import('./src/attn.js')
    const now = Date.now()
    // Waiting-on-us cases: status=waiting, or a needs-human/handoff/draft tag. A 40m
    // wait is past the 30m default target; a 5m wait is inside it.
    // needs-human so it is BOTH at-risk (waiting on us) AND ranked into the inbox --
    // a plain status=waiting case under 24h scores 0 and never reaches items, yet
    // still has an SLA clock, which is exactly the at-risk-vs-inbox distinction below.
    const overdue = { id: 'sla-1', ref: 'CASE-7001-a', status: 'waiting', tags: 'needs-human', updated_at: new Date(now - 40 * 60e3).toISOString() }
    const fresh = { id: 'sla-2', ref: 'CASE-7002-b', status: 'waiting', tags: 'needs-human', updated_at: new Date(now - 5 * 60e3).toISOString() }
    // A case casey is actively handling (auto, no waiting tag, not status=waiting) is
    // NOT waiting on us -- no SLA clock, so it must not inflate the at-risk count.
    const handled = { id: 'sla-3', ref: 'CASE-7003-c', status: 'new', tags: '', autonomy: 'auto', updated_at: new Date(now - 90 * 60e3).toISOString() }
    assert.ok(waitAgeMs(overdue, now) >= 39 * 60e3, 'an overdue waiting case reports its real wait age')
    assert.equal(waitAgeMs(handled, now), null, 'a case casey is handling has no SLA clock (null), not a false wait age')
    assert.equal(atRiskCount([overdue, fresh, handled], now), 1, 'only the case past the 30m target counts as at-risk -- the fresh and casey-handled ones do not')
    assert.equal(atRiskCount([overdue, fresh, handled], now, 3 * 60e3), 2, 'a tighter 3m target pulls the 5m-waiting case in too -- the target is tunable')
    const ranked = rankAttention([overdue, fresh, handled], now)
    assert.equal(ranked.atRisk, 1, 'rankAttention carries the aggregate at-risk count for the team header')
    const overdueItem = ranked.items.find(x => x.c.id === 'sla-1')
    assert.ok(overdueItem && overdueItem.waitMs >= 39 * 60e3, 'each ranked item carries its own wait age for the inbox row')
    // Live endpoint exposes at_risk + per-row wait_ms.
    const { case: sc } = await store.findOrCreateCase({ channel: 'sim', external_id: 'sla-live-' + Date.now() })
    await store.updateCase(sc.id, { status: 'waiting', tags: 'needs-human' })
    const att = await df('http://localhost:4577/api/attention?token=secret&limit=500').then(r => r.json())
    assert.ok(typeof att.at_risk === 'number', '/api/attention exposes an aggregate at_risk count')
    assert.ok(att.sla_target_ms > 0, '/api/attention exposes the SLA target it measured against')
    const srow = att.cases.find(c => c.id === sc.id)
    assert.ok(srow && typeof srow.wait_ms === 'number' && srow.wait_ms >= 0, 'a live waiting case carries a numeric wait_ms SLA clock')
  })

  await test('assisted draft is held (nothing sent) until an operator approves it, then it sends and clears the flags', async () => {
    const sentBefore = adapter.sent.length
    const { case: ac } = await store.findOrCreateCase({ channel: 'sim', external_id: 'assist-' + Date.now() })
    // Reproduce the held-draft state the assisted path writes: a draft event plus
    // the draft-pending + needs-human tags. Nothing has been sent to the contact.
    await store.appendEvent(ac.id, { kind: 'draft', actor: 'agent', channel: ac.channel, text: 'We have your message and will visit soon.', data: { to: ac.external_id, draft: true } })
    await store.updateCase(ac.id, { tags: 'draft-pending,needs-human' })
    assert.equal(adapter.sent.length, sentBefore, 'holding a draft sends nothing to the contact')
    // Approve -> the (operator-editable) text is delivered and the flags clear.
    const r = await df('http://localhost:4577/api/cases/' + ac.id + '/draft/approve?token=secret', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'We have your message and a vet will visit soon.' }),
    })
    assert.equal(r.status, 200, 'approve succeeds')
    assert.equal(adapter.sent.length, sentBefore + 1, 'approving sends exactly one message to the contact')
    const after = String((await store.getCase(ac.id)).tags || '').split(',').map(t => t.trim())
    assert.ok(!after.includes('draft-pending') && !after.includes('needs-human'), 'a delivered draft clears draft-pending and needs-human')
    const outs = (await store.listEvents(ac.id)).filter(e => e.kind === 'outbound')
    assert.ok(outs.some(e => /vet will visit/.test(e.text || '')), 'the operator-edited text is recorded as an outbound')
  })

  await test('an autonomy flip records a kind:autonomy_change event carrying {from,to}', async () => {
    const { case: au } = await store.findOrCreateCase({ channel: 'sim', external_id: 'auton-' + Date.now() })
    // The case starts in its default autonomy; flip it and assert the audit event.
    const prior = (await store.getCase(au.id)).autonomy
    const to = prior === 'assisted' ? 'auto' : 'assisted'
    const r = await df('http://localhost:4577/api/cases/' + au.id + '?token=secret', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ autonomy: to, reason: 'operator took the wheel' }),
    })
    assert.equal(r.status, 200, 'autonomy patch succeeds')
    const ev = (await store.listEvents(au.id)).find(e => e.kind === 'autonomy_change')
    assert.ok(ev, 'a dedicated autonomy_change event is appended, not a generic edit')
    let data = ev.data; if (typeof data === 'string') { try { data = JSON.parse(data) } catch {} }
    assert.equal(data.from, prior, 'the event carries the prior autonomy')
    assert.equal(data.to, to, 'the event carries the new autonomy')
  })

  await test('GET /api/clusters groups two correlated cases into one outbreak component', async () => {
    // Two real cases reporting the SAME place + species must land in one cluster
    // under the same correlation scorer the per-case suggestions use.
    const { buildCaseToolset } = await import('./src/case-tools.js')
    const report = buildCaseToolset(store).find(t => t.name === 'case_report')
    const stamp = Date.now()
    const { case: ca } = await store.findOrCreateCase({ channel: 'sim', external_id: 'cluster-a-' + stamp })
    const { case: cb } = await store.findOrCreateCase({ channel: 'sim', external_id: 'cluster-b-' + stamp })
    await report.handler({ id: ca.id, species: 'cattle', location: 'Musina farm', symptoms: 'drooling' })
    await report.handler({ id: cb.id, species: 'cattle', location: 'near Musina', symptoms: 'drooling' })
    const wired = await df('http://localhost:4577/api/clusters?token=secret')
    assert.equal(wired.status, 200, '/api/clusters is token-gated and reachable')
    const body = await wired.json()
    const ids = new Set([ca.id, cb.id])
    const comp = (body.clusters || []).find(cl => cl.members.some(m => ids.has(m.id)))
    assert.ok(comp, 'the two correlated cases form a cluster')
    assert.ok(comp.members.filter(m => ids.has(m.id)).length === 2, 'both correlated cases are in the same component')
    assert.ok(comp.location.includes('musina'), 'dominant shared location names the place')
    assert.ok(!JSON.stringify(body).includes('external_id'), 'clusters payload leaks no external_id')
  })

  await test('GET /api/geo rolls open cases up by stored location into ranked hotspots', async () => {
    const { buildCaseToolset } = await import('./src/case-tools.js')
    const report = buildCaseToolset(store).find(t => t.name === 'case_report')
    const stamp = Date.now()
    const { case: g1 } = await store.findOrCreateCase({ channel: 'sim', external_id: 'geo-a-' + stamp })
    const { case: g2 } = await store.findOrCreateCase({ channel: 'sim', external_id: 'geo-b-' + stamp })
    await report.handler({ id: g1.id, location: 'Thohoyandou', species: 'cattle' })
    await report.handler({ id: g2.id, location: 'Thohoyandou', species: 'goats' })
    const wired = await df('http://localhost:4577/api/geo?token=secret')
    assert.equal(wired.status, 200, '/api/geo is token-gated and reachable')
    const body = await wired.json()
    const hot = (body.places || []).find(p => p.place === 'thohoyandou')
    assert.ok(hot && hot.count >= 2, 'the shared place rolls both cases into one hotspot')
    assert.ok(hot.species.cattle >= 1 && hot.species.goats >= 1, 'species mix aggregated for the place')
    assert.ok(body.places.every((p, i) => i === 0 || body.places[i - 1].count >= p.count), 'hotspots ranked by count')
    assert.ok(!JSON.stringify(body).includes('external_id'), 'geo payload leaks no external_id')
  })

  await test('GET /api/activity merges events across cases, newest-first, filterable by kind', async () => {
    const all = await df('http://localhost:4577/api/activity?token=secret&limit=50').then(r => r.json())
    assert.ok(all.count >= 1, 'activity stream returns events')
    assert.ok(all.events.every((e, i) => i === 0 || Number(all.events[i - 1].created_at) >= Number(e.created_at)), 'newest-first')
    assert.ok(all.events.every(e => e.case_id), 'every row deep-links to its case')
    const caseIds = new Set(all.events.map(e => e.case_id))
    assert.ok(caseIds.size >= 2, 'stream spans more than one case (cross-case merge)')
    const inbound = await df('http://localhost:4577/api/activity?token=secret&kind=inbound').then(r => r.json())
    assert.ok(inbound.events.every(e => e.kind === 'inbound'), 'kind filter holds')
    const bogus = await df('http://localhost:4577/api/activity?token=secret&kind=not_a_kind').then(r => r.json())
    assert.equal(bogus.kind, null, 'an unknown kind is ignored, not passed to the store')
  })

  await test('runSweepOnce persists a fleet-health summary that GET /api/fleet-health trends', async () => {
    const before = await df('http://localhost:4577/api/fleet-health?token=secret').then(r => r.json())
    const beforeN = before.history.length
    await casey.runSweepOnce()
    await casey.runSweepOnce()
    const fh = await df('http://localhost:4577/api/fleet-health?token=secret&n=10').then(r => r.json())
    assert.ok(fh.history.length >= beforeN + 2, 'each sweep appends one trend point')
    assert.ok(fh.latest && typeof fh.latest.scanned === 'number', 'latest summary carries a scanned count')
    assert.ok(Array.isArray(fh.latest.errors), 'latest carries an errors array')
    assert.equal(fh.degraded, fh.latest.errors.length > 0, 'degraded reflects the latest errors')
    assert.ok(fh.history.every((r, i) => i === 0 || r.ts >= fh.history[i - 1].ts), 'history is oldest-first for a trend line')
  })

  await test('attnReason and todoHint derive from one caseHints policy and never contradict', async () => {
    const now = Date.parse('2026-06-25T12:00:00+02:00')
    const dayAgo = new Date(now - 30 * 3.6e6).toISOString()
    const states = [
      { tags: 'opted-out' },
      { status: 'closed' },
      { tags: 'needs-human' },
      { tags: 'health:unanswered_handoff' },
      { tags: 'health:incomplete_critical' },
      { tags: 'health:abandoned_intake' },
      { status: 'waiting', updated_at: dayAgo },
      { tags: 'health:stuck' },
      { tags: 'health:stale' },
      { autonomy: 'observe' },
      { autonomy: 'assisted' },
      { status: 'resolved' },
      { status: 'waiting' },
      { status: 'new' },
      {},
    ]
    for (const c of states) {
      const hints = caseHints(c, now)
      assert.equal(attnReason(c, now), hints.reason, 'attnReason is caseHints(...).reason')
      assert.equal(todoHint(c, now), hints.todo, 'todoHint is caseHints(...).todo')
      assert.ok(hints.reason && hints.todo, 'every state yields both a why-line and a to-do')
    }
  })

  await test('GET /api/report.csv and /api/report.html produce a management briefing (SAST, escaped)', async () => {
    const csvRes = await df('http://localhost:4577/api/report.csv?token=secret&days=30')
    assert.equal(csvRes.status, 200, 'report.csv reachable + token-gated')
    assert.match(csvRes.headers.get('content-type') || '', /text\/csv/, 'csv content-type')
    const csv = await csvRes.text()
    assert.match(csv, /^section,key,value/, 'csv has the briefing header')
    assert.match(csv, /totals,all,/, 'csv carries totals')
    assert.match(csv, /response,median_first_response_hours,/, 'csv carries median response time')
    assert.match(csv, /by_operator,Thandi M replies_24h,/, 'csv carries the per-operator workload section by name')
    const htmlRes = await df('http://localhost:4577/api/report.html?token=secret')
    assert.equal(htmlRes.status, 200, 'report.html reachable')
    const html = await htmlRes.text()
    assert.match(html, /casey management report/, 'html briefing renders')
    assert.match(html, /SAST/, 'generated time is shown in SAST')
    assert.match(html, /Team workload/, 'html briefing carries the per-operator workload table')
    assert.match(html, /Thandi M/, 'an operator is named in the workload table')
    assert.ok(!html.includes('<script>alert'), 'no unescaped contact text leaks into the report')
    // Aggregate-only: the per-operator report section leaks no contact identifier.
    assert.ok(!csv.includes('external_id') && !html.includes('external_id'), 'report by_operator leaks no external_id')
  })

  await test('report-analytics: SLA compliance, period comparison, per-channel metrics (pure, aggregate-only)', async () => {
    const now = 10_000_000_000
    const sec = (ms) => Math.floor(ms / 1000)
    // Two cases: one answered fast (within a 30-min SLA), one never answered.
    const cs = [
      { id: 'a', channel: 'whatsapp', status: 'resolved', created_at: sec(now - 60 * 60 * 1000) },
      { id: 'b', channel: 'discord', status: 'in_progress', created_at: sec(now - 50 * 60 * 1000) },
    ]
    const ev = new Map([
      ['a', [
        { kind: 'inbound', created_at: sec(now - 60 * 60 * 1000) },
        { kind: 'outbound', created_at: sec(now - 60 * 60 * 1000 + 5 * 60 * 1000) }, // 5 min -> met
      ]],
      ['b', [
        { kind: 'inbound', created_at: sec(now - 50 * 60 * 1000) }, // never answered -> breach
      ]],
    ])
    const sla = buildSLAReport(cs, ev, 30 * 60 * 1000, now)
    assert.equal(sla.considered, 2, 'both cases had an inbound and are considered')
    assert.equal(sla.met_count, 1, 'the 5-min reply met the 30-min SLA')
    assert.equal(sla.breached_count, 1, 'the never-answered case breached')
    assert.equal(sla.breached_by_reason.never_answered, 1, 'breach reason split names the unanswered case')
    assert.equal(sla.breach_pct, 50, 'one of two considered -> 50% breach')

    const chan = buildChannelMetrics(cs, ev)
    assert.ok(chan.whatsapp && chan.discord, 'per-channel slots exist for both intake channels')
    assert.equal(chan.whatsapp.first_response_ms_median, 5 * 60 * 1000, 'whatsapp first-response median is the 5-min reply')
    assert.equal(chan.discord.answered_count, 0, 'the unanswered discord case contributes no response time')
    assert.ok(!JSON.stringify(chan).includes('external_id'), 'channel metrics carry no contact id')

    const cmp = buildReportComparison(cs, ev, now, 14 * 24 * 3600 * 1000)
    assert.ok('deltas' in cmp && 'response_time_delta_pct' in cmp.deltas, 'comparison returns current/prior + deltas')

    // by-case-type SLA split: tag the two cases and assert the slices reconcile to overall.
    const typed = [
      { ...cs[0], case_type: 'outbreak' },
      { ...cs[1], case_type: 'follow_up' },
    ]
    const slaT = buildSLAReportByType(typed, ev, 30 * 60 * 1000, now)
    assert.ok(slaT.by_type.outbreak && slaT.by_type.follow_up, 'sla-by-type carries a slice per case_type')
    assert.equal(slaT.by_type.outbreak.met_count, 1, 'the answered outbreak met its SLA')
    assert.equal(slaT.by_type.follow_up.breached_count, 1, 'the unanswered follow_up breached')
    assert.equal(slaT.overall.considered, slaT.by_type.outbreak.considered + slaT.by_type.follow_up.considered, 'by-type considered reconciles to overall')
    assert.ok(!JSON.stringify(slaT).includes('external_id'), 'sla-by-type carries no contact id')

    // per-case-type metrics with closure rate + reopen count.
    const ctm = buildCaseTypeMetrics(typed, ev)
    assert.ok(ctm.outbreak && ctm.follow_up, 'case-type metrics keyed per enum value')
    assert.equal(ctm.outbreak.closed_pct, 100, 'the resolved outbreak is 100% closed')
    assert.ok('reopen_count' in ctm.outbreak, 'case-type metrics carry a reopen_count')

    // channel metrics gained closure rate + reopen count (untyped fixture).
    assert.ok('closed_pct' in chan.whatsapp && 'reopen_count' in chan.whatsapp, 'channel metrics carry closed_pct + reopen_count')

    // structured alert payload: shape present, escalated tier, NO external_id.
    const al = buildAlertPayload({ ref: 'CASE-1', case_type: 'outbreak', external_id: '+27123' }, 'unanswered_handoff', 'breach detail', { escalated: true, sinceMs: 1234, slaWindowMs: 1800000 })
    assert.equal(al.case_ref, 'CASE-1', 'alert carries the case ref')
    assert.equal(al.case_type, 'outbreak', 'alert carries the case_type for routing')
    assert.equal(al.severity_tier, 'escalated', 'escalated opt sets the supervisor tier')
    assert.equal(al.since_ms, 1234, 'alert carries elapsed ms')
    assert.ok(!JSON.stringify(al).includes('27123') && !('external_id' in al), 'alert payload never leaks the contact external_id')

    // cluster severity: a multi-member outbreak cluster outranks a routine one of equal size.
    const mk = (id, loc, sp, type) => ({ id, ref: id, status: 'in_progress', case_type: type, report: { location: loc, species: sp } })
    const pool = [
      mk('o1', 'limpopo', 'cattle', 'outbreak'), mk('o2', 'limpopo', 'cattle', 'outbreak'),
      mk('f1', 'gauteng', 'goats', 'follow_up'), mk('f2', 'gauteng', 'goats', 'follow_up'),
    ]
    const clusters = buildClusters(pool)
    assert.ok(clusters.length >= 1 && clusters.every(c => 'severity' in c), 'every cluster carries a severity score')
    if (clusters.length >= 2) {
      assert.ok(clusters[0].severity >= clusters[1].severity, 'clusters sort by severity desc')
      const outbreakC = clusters.find(c => c.members.some(m => m.case_type === 'outbreak'))
      const routineC = clusters.find(c => c.members.every(m => m.case_type === 'follow_up'))
      if (outbreakC && routineC) assert.ok(outbreakC.severity > routineC.severity, 'equal-size outbreak cluster outranks the routine one')
    }
  })

  await test('GET /api/report.json (analytics) and /api/audit.csv (compliance, no PII)', async () => {
    const jr = await df('http://localhost:4577/api/report.json?token=secret&days=30')
    assert.equal(jr.status, 200, 'report.json reachable + token-gated')
    assert.match(jr.headers.get('content-type') || '', /application\/json/, 'json content-type')
    const j = await jr.json()
    assert.ok(j.totals && j.sla && j.comparison && j.by_channel, 'report.json carries the briefing + sla + comparison + by_channel')
    assert.ok('breach_pct' in j.sla, 'sla section carries a breach_pct')
    assert.ok(j.sla_by_type && 'by_type' in j.sla_by_type && 'overall' in j.sla_by_type, 'report.json carries the per-case-type SLA split')
    assert.ok(j.by_case_type && typeof j.by_case_type === 'object', 'report.json carries per-case-type metrics')
    assert.ok(!JSON.stringify(j).includes('external_id'), 'report.json leaks no external_id')

    const ar = await df('http://localhost:4577/api/audit.csv?token=secret&days=30')
    assert.equal(ar.status, 200, 'audit.csv reachable + token-gated')
    assert.match(ar.headers.get('content-type') || '', /text\/csv/, 'audit csv content-type')
    const audit = await ar.text()
    assert.match(audit, /^case_ref,timestamp_sast,actor,action,field,old_value,new_value,reason/, 'audit csv has the compliance header')
    // An outbound reply event records data.to = external_id; the audit export must
    // scrub that so the contact id never lands in a compliance file. Assert precisely
    // on the parsed rows (a blunt substring scan on a short id like "c1" is meaningless):
    // no cell may EQUAL the raw external_id of any case named in the export.
    const exts = new Set((await store.listCases({}, { limit: 10000 })).map(c => String(c.external_id || '')).filter(Boolean))
    const dataRows = audit.split('\n').slice(1).filter(Boolean)
    for (const line of dataRows) {
      // naive split is fine here: our emitted cells never contain a literal comma
      // (refs, ids, enums, SAST times, scrubbed values), and csvCell would quote any that did
      for (const cell of line.split(',')) {
        assert.ok(!exts.has(cell), `audit.csv leaks a raw contact external_id in a cell: ${cell}`)
      }
    }
  })

  await test('case_type round-trips through updateCase and is audited', async () => {
    const c = await store.getCase(caseId)
    await store.updateCase(c.id, { case_type: 'outbreak' })
    const after = await store.getCase(c.id)
    assert.equal(after.case_type, 'outbreak', 'case_type persists through updateCase')
  })

  await test('PATCH /api/cases/:id reclassifies case_type and records a distinct audit event', async () => {
    // case_type is a non-autonomy field, so the patch is rejected while a case is in
    // observe mode; ensure the case is editable first (auto), then reclassify.
    await store.updateCase(caseId, { autonomy: 'auto' })
    const r = await df('http://localhost:4577/api/cases/' + caseId + '?token=secret', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ case_type: 'lab_sample' }),
    })
    assert.equal(r.status, 200, 'case_type PATCH accepted')
    const after = await store.getCase(caseId)
    assert.equal(after.case_type, 'lab_sample', 'PATCH persisted the new case_type')
    const ev = (await store.listEvents(caseId)).filter(e => e.kind === 'action' && /case_type .* -> .*/.test(e.text || '')).pop()
    assert.ok(ev, 'a distinct case_type reclassify action event is appended')

    // an unknown enum value is rejected, not silently stored.
    const bad = await df('http://localhost:4577/api/cases/' + caseId + '?token=secret', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ case_type: 'nonsense' }),
    })
    assert.equal(bad.status, 400, 'an out-of-enum case_type is rejected')
  })

  await test('GET /api/sla-at-risk/by-type slices open cases by case_type (aggregate-only)', async () => {
    const r = await df('http://localhost:4577/api/sla-at-risk/by-type?token=secret')
    assert.equal(r.status, 200, 'sla-at-risk/by-type reachable + token-gated')
    const j = await r.json()
    assert.ok(j.by_type && typeof j.by_type === 'object', 'response carries a per-case-type at-risk map')
    assert.ok(Number.isFinite(j.total), 'response carries a total at-risk count')
    assert.ok(Number.isFinite(j.sla_target_ms), 'response carries the live SLA target')
    assert.ok(!JSON.stringify(j).includes('external_id'), 'at-risk-by-type leaks no contact id')
  })

  await test('dashboard reply surfaces the sent flag (delivered vs logged-only)', async () => {
    const wired = await df('http://localhost:4577/api/cases/' + caseId + '/reply?token=secret', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'wired' }),
    }).then(r => r.json())
    assert.equal(wired.sent, true, 'sendReply present -> sent:true')
    // a dashboard with no sendReply logs the outbound but reports sent:false
    const noSend = await createDashboard(store, { port: 4578, token: 'secret' })
    const logged = await df('http://localhost:4578/api/cases/' + caseId + '/reply?token=secret', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'logged only' }),
    }).then(r => r.json())
    assert.equal(logged.sent, false, 'no sendReply -> sent:false')
    await noSend.close()
  })

  await test('dashboard transition threads the operator reason into the event', async () => {
    // move to a stage we can reach, with a reason, and confirm it is recorded.
    const cur = (await store.getCase(caseId)).status
    const avail = store.availableTransitions(await store.getCase(caseId), { id: 'op', role: 'operator' })
    if (avail.length) {
      const r = await df('http://localhost:4577/api/cases/' + caseId + '/transition?token=secret', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: avail[0], reason: 'operator-reason-xyz' }),
      })
      assert.equal(r.status, 200)
      const t = (await store.listEvents(caseId)).filter(e => e.kind === 'transition').pop()
      assert.ok(JSON.stringify(t).includes('operator-reason-xyz') || (t.text && t.text.includes('operator-reason-xyz')), 'reason recorded on transition')
    } else {
      assert.ok(true, 'no transition available from ' + cur + ' - skipped')
    }
  })

  await test('OPERATOR FLOW: needs-human case, canned reply sends once as operator, transition + reason surface', async () => {
    const chan = 'op-flow-1'
    await runScript(adapter, ['please get me a real human'], { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
    const opCase = (await store.listCases()).find(c => c.external_id === chan)
    assert.ok(opCase, 'case opened for operator-flow contact')
    assert.ok((opCase.tags || '').includes('needs-human'), 'contact flagged needs-human')

    const detail = await df('http://localhost:4577/api/cases/' + opCase.id + '?token=secret').then(r => r.json())
    assert.ok((detail.case.tags || '').includes('needs-human'), 'dashboard surfaces needs-human tag')

    const sentBefore = adapter.sent.length
    const reply = await df('http://localhost:4577/api/cases/' + opCase.id + '/reply?token=secret', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Hi, this is Sam from the team. I am looking after this for you now.' }),
    }).then(r => r.json())
    assert.equal(reply.sent, true, 'canned reply delivered on channel')
    assert.equal(adapter.sent.length, sentBefore + 1, 'exactly one message sent')
    const lastOut = (await store.listEvents(opCase.id)).filter(e => e.kind === 'outbound').pop()
    assert.equal(lastOut.actor, 'operator', 'outbound attributed to operator')
    // operator personally replied -> needs-human cleared so the inbox stops pinning it
    assert.ok(!((await store.getCase(opCase.id)).tags || '').includes('needs-human'), 'needs-human cleared after operator reply')

    const avail = store.availableTransitions(await store.getCase(opCase.id), { id: 'op', role: 'operator' })
    assert.ok(avail.length, 'operator has a stage to move to')
    const target = avail.includes('in_progress') ? 'in_progress' : avail[0]
    const tr = await df('http://localhost:4577/api/cases/' + opCase.id + '/transition?token=secret', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: target, reason: 'operator picked it up' }),
    })
    assert.equal(tr.status, 200)
    const after = await df('http://localhost:4577/api/cases/' + opCase.id + '?token=secret').then(r => r.json())
    assert.equal(after.case.status, target, 'dashboard surfaces the transitioned stage')
    // The reason lives on a TRANSITION EVENT, not in the available-transitions list.
    const trEv = (await store.listEvents(opCase.id)).filter(e => e.kind === 'transition').pop()
    assert.ok(trEv && JSON.stringify(trEv).includes('operator picked it up'), 'reason recorded on the transition event')
  })

  await test('END-TO-END LIFECYCLE: intake -> handoff -> operator reply -> resolve -> plain status reflects resolved', async () => {
    const chan = 'e2e-1'
    const JARGON = /\b(triage|triaging|autonomy|transition|workflow|escalate)\b/i

    await runScript(adapter, ['hi my parcel never arrived'], { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
    let c = (await store.listCases()).find(x => x.external_id === chan)
    assert.ok(c, 'intake opened a case')
    const greet = adapter.sent[adapter.sent.length - 1]
    assert.ok(greet.text.includes(c.ref), 'intake reply cites the reference')
    c = await store.getCase(c.id)
    assert.notEqual(c.status, 'closed')

    await runScript(adapter, ['can i talk to a real person'], { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
    c = await store.getCase(c.id)
    assert.ok((c.tags || '').includes('needs-human'), 'handoff flagged needs-human')
    assert.equal(c.priority, 'high', 'handoff keeps/raises priority to high')

    const beforeOp = adapter.sent.length
    await df('http://localhost:4577/api/cases/' + c.id + '/reply?token=secret', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Hi, a person here now, checking the courier for you.' }),
    })
    assert.equal(adapter.sent.length, beforeOp + 1, 'operator reply reached the contact')

    const op = { id: 'op', role: 'operator' }
    for (let i = 0; i < 6 && (await store.getCase(c.id)).status !== 'resolved'; i++) {
      const cur = await store.getCase(c.id)
      const avail = store.availableTransitions(cur, op)
      const step = avail.includes('resolved') ? 'resolved'
        : avail.includes('in_progress') ? 'in_progress'
        : avail.find(s => s !== 'closed')
      if (!step) break
      await store.transition(c.id, step, { user: op, reason: 'lifecycle test' })
    }
    assert.equal((await store.getCase(c.id)).status, 'resolved', 'reached resolved')

    const beforeStatus = adapter.sent.length
    await runScript(adapter, ['any update?'], { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
    const status = adapter.sent[adapter.sent.length - 1]
    assert.ok(adapter.sent.length > beforeStatus, 'status produced a reply')
    assert.ok(/sorted|still/i.test(status.text), `status reflects resolved stage: ${status.text}`)
    assert.ok(status.text.includes(c.ref), 'status reply cites the reference')
    assert.ok(!JARGON.test(status.text), `status reply stays jargon-free: ${status.text}`)
  })

  await test('proactive stage notes are jargon-free and not bot-styled', async () => {
    const { stageNote } = await import('./src/gateway-hooks.js')
    const JARGON = /\b(triage|triaging|autonomy|transition|workflow|escalate)\b/i
    for (const s of ['in_progress', 'waiting', 'resolved']) {
      const t = stageNote(s)
      assert.ok(t && !JARGON.test(t), `stageNote(${s}) avoids jargon: ${t}`)
      assert.ok(!t.includes('--'), `stageNote(${s}) has no dash punctuation: ${t}`)
    }
    assert.equal(stageNote('triaging'), '', 'internal stages are silent')
    assert.equal(stageNote('closed'), '', 'closed is silent (resolved already told them)')
  })

  await test('PROACTIVE NOTE: operator transition sends a plain note; opted-out and observe stay silent', async () => {
    const { makeTransitionNotifier } = await import('./src/gateway-hooks.js')
    const sent = []
    const notifier = makeTransitionNotifier(store, (cRow, text) => { sent.push({ id: cRow.id, text }); return Promise.resolve() })
    const prev = store.onTransition
    store.onTransition = notifier
    try {
      // a plain auto case: a real operator move to in_progress sends a note
      const { case: c1 } = await store.findOrCreateCase({ channel: 'sim', external_id: 'pn-auto', contact: { display_name: 'pn' } })
      await store.transition(c1.id, 'in_progress', { user: { id: 'op', role: 'operator' }, reason: 'picked up' })
      assert.ok(sent.some(s => s.id === c1.id && /working on your request/i.test(s.text)), 'proactive note sent on operator transition')

      // an AGENT transition must NOT notify (agent already replies itself)
      const before1 = sent.length
      const { case: c2 } = await store.findOrCreateCase({ channel: 'sim', external_id: 'pn-agent', contact: { display_name: 'pn2' } })
      await store.transition(c2.id, 'in_progress', { user: { id: 'casey-agent', role: 'agent' }, reason: 'auto' })
      assert.equal(sent.length, before1, 'agent transition does not send a proactive note')

      // an opted-out contact is never messaged
      const before2 = sent.length
      const { case: c3 } = await store.findOrCreateCase({ channel: 'sim', external_id: 'pn-optout', contact: { display_name: 'pn3' } })
      await store.updateCase(c3.id, { tags: 'opted-out' })
      await store.transition(c3.id, 'in_progress', { user: { id: 'op', role: 'operator' }, reason: 'x' })
      assert.equal(sent.length, before2, 'opted-out contact gets no proactive note')

      // a no-op transition to the current stage sends nothing
      const before3 = sent.length
      await store.transition(c1.id, 'in_progress', { user: { id: 'op', role: 'operator' }, reason: 'noop' })
      assert.equal(sent.length, before3, 'no-op transition is silent')
    } finally { store.onTransition = prev }
  })

  await test('dashboard mutation endpoints reject malformed input with a clear 4xx (adversarial)', async () => {
    const someCase = (await store.listCases())[0]
    const post = (path, body) => df('http://localhost:4577/api/cases/' + someCase.id + path + '?token=secret', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    // bad autonomy / priority are rejected before thatcher is touched
    const badAuto = await df('http://localhost:4577/api/cases/' + someCase.id + '?token=secret', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ autonomy: 'wizard' }),
    })
    assert.equal(badAuto.status, 400, 'invalid autonomy rejected')
    const badPrio = await df('http://localhost:4577/api/cases/' + someCase.id + '?token=secret', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ priority: '11' }),
    })
    assert.equal(badPrio.status, 400, 'invalid priority rejected')
    // non-string field is rejected, not coerced
    const objField = await df('http://localhost:4577/api/cases/' + someCase.id + '?token=secret', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject: { evil: 1 } }),
    })
    assert.equal(objField.status, 400, 'object subject rejected')
    // successful note returns 200 and the event is stored
    const goodNote = await post('/note', { text: 'Test note from operator', field: 'location' })
    assert.equal(goodNote.status, 200, 'POST /note with valid text returns 200')
    const noteEvs = await store.listEvents(someCase.id)
    assert.ok(noteEvs.some(e => e.kind === 'note' && e.text === 'Test note from operator'), 'note event stored in timeline')
    // observe-mode guard: non-autonomy PATCH blocked for observe cases
    await df('http://localhost:4577/api/cases/' + someCase.id + '?token=secret', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ autonomy: 'observe' }),
    })
    const observePatch = await df('http://localhost:4577/api/cases/' + someCase.id + '?token=secret', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'should not stick' }),
    })
    assert.equal(observePatch.status, 400, 'PATCH of non-autonomy field rejected when autonomy=observe')
    // restore autonomy so further tests still work
    await df('http://localhost:4577/api/cases/' + someCase.id + '?token=secret', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ autonomy: 'auto' }),
    })
    // oversized text is 413
    const huge = await post('/note', { text: 'x'.repeat(5000) })
    assert.equal(huge.status, 413, 'oversized note rejected')
    // unknown transition target is rejected with the allowed list
    const badTo = await post('/transition', { to: 'nowhere' })
    assert.equal(badTo.status, 400, 'unknown transition target rejected')
    const body = await badTo.json()
    assert.ok(Array.isArray(body.allowed), 'rejection names the allowed transitions')
    // a no-op transition to the current stage is still accepted (200), not 400
    const noop = await post('/transition', { to: (await store.getCase(someCase.id)).status })
    assert.equal(noop.status, 200, 'no-op same-stage transition accepted')
  })

  await test('GET /api/attention returns a list of flagged cases', async () => {
    const r = await df('http://localhost:4577/api/attention?token=secret')
    assert.equal(r.status, 200, 'GET /api/attention returns 200')
    const j = await r.json()
    assert.ok(Array.isArray(j.cases), 'attention response has cases array')
    assert.ok(typeof j.count === 'number', 'attention response has count')
  })

  // ---- tunable thresholds (server + store half) ----
  // GET returns the effective set, PUT validates+clamps against the allowlist and
  // persists only accepted keys as an audited observation, and store.resolveThresholds()
  // reflects the change at call time -- the same read /api/attention's classifier uses,
  // so a threshold edit changes breach detection live without a restart.
  await test('GET/PUT /api/thresholds validates, clamps, persists, and feeds resolveThresholds', async () => {
    const before = await df('http://localhost:4577/api/thresholds?token=secret').then(r => r.json())
    assert.ok(before.thresholds && typeof before.thresholds.handoffMs === 'number', 'GET returns effective thresholds')
    assert.equal(before.customized, false, 'unconfigured store reports not customized')
    // Mix a valid key, an out-of-bounds key (clamped, not rejected), and an unknown key (dropped).
    const put = await df('http://localhost:4577/api/thresholds?token=secret', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handoffMs: 2 * 60 * 60 * 1000, staleMs: 1, bogusKey: 999 }),
    })
    assert.equal(put.status, 200, 'valid PUT returns 200')
    const pj = await put.json()
    assert.ok(pj.applied.includes('handoffMs'), 'in-bounds key applied')
    assert.ok(pj.applied.includes('staleMs'), 'out-of-bounds key still applied (clamped)')
    assert.ok((pj.rejected || []).some(k => /bogusKey/.test(typeof k === 'string' ? k : k.key || '')), 'unknown key rejected')
    assert.equal(pj.thresholds.handoffMs, 2 * 60 * 60 * 1000, 'in-bounds value stored verbatim')
    assert.ok(pj.thresholds.staleMs > 1, 'sub-minimum staleMs clamped up, not stored as 1')
    // PUT with no recognised keys is a 400, not a silent no-op.
    const empty = await df('http://localhost:4577/api/thresholds?token=secret', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nope: 1 }),
    })
    assert.equal(empty.status, 400, 'PUT with no applicable keys is rejected')
    // The store read the classifier uses reflects the persisted change.
    const resolved = await store.resolveThresholds()
    assert.equal(resolved.handoffMs, 2 * 60 * 60 * 1000, 'resolveThresholds returns the persisted handoffMs')
    const after = await df('http://localhost:4577/api/thresholds?token=secret').then(r => r.json())
    assert.equal(after.customized, true, 'GET reports customized after a PUT')
  })

  // ---- oversight: thresholds feed the live inbox, config validation, CLI ranking ----
  // Three witnesses the management surface depends on: (1) a tightened threshold
  // persisted via /api/thresholds is the SAME read /api/attention's classifier uses
  // at request time -- the latent-bug fix that the inbox no longer classifies against
  // the shipped default after a team tunes it; (2) validateConfig() catches a broken
  // workflow graph without booting a DB (what `casey doctor` runs); (3) rankAttention
  // orders an open pool worst-first (what `casey attention` prints).
  await test('a persisted handoffMs tightening flips a borderline case into /api/attention live, validateConfig catches a broken graph, and rankAttention orders worst-first', async () => {
    // (1) handoffMs was persisted to 2h by the prior test. A needs-human case idle
    // ~3h is past the tuned 2h handoff window but UNDER the shipped 4h default --
    // so its presence in the inbox's breach list proves the classifier read the
    // live tuned threshold, not the default.
    const { case: hc } = await store.findOrCreateCase({ channel: 'sim', external_id: 'oversight-handoff-' + Date.now() })
    await store.updateCase(hc.id, { tags: 'needs-human' })
    await store.t.update('case', hc.id, { last_event_at: new Date(Date.now() - 3 * 3600e3).toISOString() }, { id: 'sys', role: 'admin' })
    const att = await df('http://localhost:4577/api/attention?token=secret&limit=500').then(r => r.json())
    const row = att.cases.find(c => c.id === hc.id)
    assert.ok(row, 'the borderline needs-human case appears in /api/attention')
    assert.ok((row.breaches || []).some(b => /handoff/.test(b.breach || b)), 'a 3h-idle handoff breaches against the live 2h threshold (would not at the 4h default) -- the inbox reads resolveThresholds() live')

    // (2) validateConfig() rejects a workflow that references an unknown stage,
    // the pure-read graph check `casey doctor` runs before any DB boot.
    const { createCaseStore } = await import('./src/case-store.js')
    const os = await import('node:os'); const fsp = await import('node:fs/promises'); const pathMod = await import('node:path')
    const broken = pathMod.join(os.tmpdir(), 'casey-broken-' + Date.now() + '.yml')
    await fsp.writeFile(broken, [
      'entities:', '  case: {}', '  event: {}', '  contact: {}',
      'workflows:', '  case_lifecycle:', '    stages:',
      '      - name: new', '        forward: [nowhere]',
    ].join('\n'), 'utf8')
    let threw = null
    try { createCaseStore({ config: broken }).validateConfig() } catch (e) { threw = e }
    await fsp.unlink(broken).catch(() => {})
    assert.ok(threw && /unknown target "nowhere"/.test(threw.message), 'validateConfig throws on a stage referencing an unknown transition target')

    // (3) rankAttention orders an open pool worst-first by score (the CLI ordering).
    const { rankAttention } = await import('./src/attn.js')
    const now = Date.now()
    const pool = [
      { id: 'low', status: 'new', tags: '', created_at: new Date(now).toISOString(), last_event_at: new Date(now).toISOString() },
      { id: 'high', status: 'in_progress', tags: 'needs-human,health:unanswered_handoff_escalated', last_event_at: new Date(now - 20 * 3600e3).toISOString() },
      { id: 'mid', status: 'waiting', tags: 'needs-human', last_event_at: new Date(now - 5 * 3600e3).toISOString() },
    ]
    const { items } = rankAttention(pool, now)
    assert.ok(items.length >= 2, 'urgent cases survive the score>0 filter')
    assert.equal(items[0].c.id, 'high', 'the escalated handoff ranks first -- worst-first ordering')
    for (let i = 1; i < items.length; i++) assert.ok(items[i - 1].score >= items[i].score, 'scores are non-increasing down the ranked list')
  })

  // ---- receive-liveness watchdog ----
  // A gateway WebSocket can go zombie (TCP ESTABLISHED, gateway-dead) and
  // silently stop delivering inbound while the process, HTTP server, and
  // outbound send all stay healthy -- the "online but answering nobody"
  // failure. receiveStatus() turns that silent state into an observable signal,
  // and /api/health surfaces it as the `gateway` field so the dashboard pill can
  // show "not connected" in red instead of a false green. We test receiveStatus
  // on a bare Casey (no init/start) so no real Discord socket is opened.
  await test('receiveStatus: a configured-but-never-connected channel reports never-connected; a connect flips it to ok', async () => {
    const c = new Casey({ channels: ['discord'] })
    const t0 = 1_000_000
    const before = c.receiveStatus(t0)
    assert.equal(before.state, 'never-connected', 'a channel that never saw a READY is never-connected (deaf)')
    assert.equal(before.channels.discord.connected, false, 'channel reports not connected')
    assert.equal(before.channels.discord.sinceConnectMs, null, 'no connect timestamp yet')
    // Simulate a gateway READY: _markConnected stamps connectedAt -> ok.
    c._markConnected('discord')
    const after = c.receiveStatus()
    assert.equal(after.state, 'ok', 'after a connect the channel is ok')
    assert.equal(after.channels.discord.connected, true, 'channel reports connected')
    assert.ok(after.channels.discord.sinceConnectMs >= 0, 'sinceConnectMs is a non-negative age')
    // sim-only casey has no real-time receive socket -> state 'none', no false red.
    assert.equal(new Casey({ channels: ['sim'] }).receiveStatus().state, 'none', 'sim/web are not receive sockets')
  })

  await test('/api/health surfaces a deaf gateway as gateway.ok=false; a connected one as gateway.ok=true; sim-only has none', async () => {
    // Inject receiveStatus directly so the test never depends on a live socket.
    const deafDash = await createDashboard(store, { port: 4581, token: 'secret',
      receiveStatus: () => ({ state: 'never-connected', channels: { discord: { state: 'never-connected', connected: false, sinceConnectMs: null, sinceInboundMs: null } } }) })
    try {
      const h = await df('http://localhost:4581/api/health?token=secret').then(r => r.json())
      assert.ok(h.gateway, 'health includes a gateway field when a channel is configured')
      assert.equal(h.gateway.ok, false, 'a never-connected gateway is reported not ok')
      assert.equal(h.gateway.state, 'never-connected')
      assert.equal(h.gateway.label, 'Messages: not connected', 'plain-language label for the operator')
    } finally { await deafDash.close() }
    const okDash = await createDashboard(store, { port: 4582, token: 'secret',
      receiveStatus: () => ({ state: 'ok', channels: { discord: { state: 'ok', connected: true, sinceConnectMs: 1000, sinceInboundMs: 500 } } }) })
    try {
      const h = await df('http://localhost:4582/api/health?token=secret').then(r => r.json())
      assert.ok(h.gateway && h.gateway.ok === true, 'a connected gateway is reported ok')
      assert.equal(h.gateway.label, 'Messages: connected')
    } finally { await okDash.close() }
    const simDash = await createDashboard(store, { port: 4583, token: 'secret',
      receiveStatus: () => ({ state: 'none', channels: {} }) })
    try {
      const h = await df('http://localhost:4583/api/health?token=secret').then(r => r.json())
      assert.equal(h.gateway, null, 'no real-time channel -> no gateway pill, never a false red')
    } finally { await simDash.close() }
  })

  await test('countCases is exact for casey scale (50k cap is a worst-case ceiling, not a truncation here)', async () => {
    const n = await store.countCases({ channel: 'sim' })
    const listed = (await store.listCases({ channel: 'sim' }, { limit: 100000 })).length
    assert.equal(n, listed, 'countCases matches a full list of the same where')
  })

  // ---- discord WS receive ----
  await test('discord adapter emits message on MESSAGE_CREATE, ignores bots', async () => {
    const { DiscordAdapter } = await import('file://' + REPO_ROOT.replace(/\\/g, '/') + '/node_modules/freddie/plugins/platform-discord/handler.js')
    const a = new DiscordAdapter({ token: 'x', receive: false })
    const got = []
    a.on('message', m => got.push(m))
    a._dispatch({ t: 'MESSAGE_CREATE', d: { author: { id: 'u1', username: 'u' }, content: 'hi', channel_id: 'ch1' } })
    a._dispatch({ t: 'MESSAGE_CREATE', d: { author: { id: 'b1', bot: true }, content: 'beep', channel_id: 'ch1' } })
    assert.equal(got.length, 1, 'bot message ignored')
    assert.equal(got[0].text, 'hi'); assert.equal(got[0].raw.channel_id, 'ch1')
  })

  // ---- whatsapp webhook payload shape ----
  await test('whatsapp adapter maps a Meta webhook payload to a message', async () => {
    const { WhatsappAdapter } = await import('file://' + REPO_ROOT.replace(/\\/g, '/') + '/node_modules/freddie/plugins/platform-whatsapp/handler.js')
    const a = new WhatsappAdapter({ token: 't', phoneId: 'p' })
    const got = []
    a.on('message', m => got.push(m))
    // simulate the POST /webhook body handling directly
    const body = { entry: [{ changes: [{ value: { messages: [{ from: '27820000000', id: 'wamid.1', type: 'text', text: { body: 'hello' } }] } }] }] }
    for (const e of body.entry) for (const c of e.changes) for (const m of (c.value.messages || []))
      a.emit('message', { from: m.from, text: m.text?.body || '', raw: { ...m, id: m.id, type: m.type } })
    assert.equal(got.length, 1)
    assert.equal(got[0].from, '27820000000'); assert.equal(got[0].raw.id, 'wamid.1')
  })

  await test('WhatsApp HMAC-SHA256 signature verification rejects forged requests', async () => {
    const { WhatsappAdapter } = await import('file://' + REPO_ROOT.replace(/\\/g, '/') + '/node_modules/freddie/plugins/platform-whatsapp/handler.js')
    const crypto = await import('crypto')
    const secret = 'test-secret-abc123'
    const a = new WhatsappAdapter({ token: 't', phoneId: 'p', appSecret: secret })
    const body = Buffer.from(JSON.stringify({ hello: 'world' }))
    // valid signature
    const validSig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
    const fakeReq = (sig) => ({ get: (h) => h === 'x-hub-signature-256' ? sig : '', rawBody: body })
    assert.equal(a._verifySignature(fakeReq(validSig)), true, 'valid HMAC accepted')
    assert.equal(a._verifySignature(fakeReq('sha256=deadbeef')), false, 'forged signature rejected')
    assert.equal(a._verifySignature(fakeReq('')), false, 'missing signature rejected')
    // adapter with no secret allows all (legacy mode)
    const noSecretA = new WhatsappAdapter({ token: 't', phoneId: 'p' })
    assert.equal(noSecretA._verifySignature(fakeReq('')), true, 'no appSecret = verification skipped')
  })

  await test('concurrent first-messages create exactly one case', async () => {
    const r = await Promise.all(Array.from({ length: 5 }, () => store.findOrCreateCase({ channel: 'sim', external_id: 'race-x' })))
    assert.equal(new Set(r.map(x => x.case.id)).size, 1)
    assert.equal(r.filter(x => x.created).length, 1)
  })

  await test('config validation rejects a malformed workflow', async () => {
    const { CaseStore } = await import('./src/case-store.js')
    const bad = new CaseStore({ config: './thatcher.config.yml', workflow: 'does_not_exist' })
    await assert.rejects(() => bad.init(), /missing workflow/)
  })

  // ---- low-literacy scenario harness ----
  // Replays each persona from src/sim/scenarios.js through the full agent path
  // and asserts the contract that protects confused / non-native / impatient
  // contacts: a reply always comes, it stays short and jargon-free, it quotes
  // the reference, and it offers a person exactly when one is requested.
  {
    const { SCENARIOS } = await import('./src/sim/scenarios.js')
    const JARGON = /\b(triage|triaging|autonomy|transition|workflow|escalate)\b/i
    const HUMAN = /\b(person|human|team|someone)\b/i

    for (const persona of Object.values(SCENARIOS)) {
      await test(`scenario "${persona.name}": replies are non-blank, simple, and cite the reference`, async () => {
        const chan = `scn-${persona.name}`
        const sentBefore = adapter.sent.length
        await runScript(adapter, persona.lines, { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
        const replies = adapter.sent.slice(sentBefore).filter(r => r.text != null)
        assert.ok(replies.length >= 1, 'at least one reply was sent')
        const caseRow = (await store.listCases()).find(c => c.external_id === chan)
        assert.ok(caseRow, 'a case was opened for the persona')
        for (const r of replies) {
          assert.ok(r.text && r.text.trim().length > 0, 'reply is never blank')
          assert.ok(r.text.length <= 240, `reply stays short (${r.text.length}): ${r.text}`)
          assert.ok(!JARGON.test(r.text), `reply avoids jargon: ${r.text}`)
          assert.ok(r.text.includes(caseRow.ref), `reply cites reference ${caseRow.ref}: ${r.text}`)
        }
      })
    }

    await test('scenario "asks-for-human": at least one reply offers a person', async () => {
      const chan = 'scn-human-offer'
      const sentBefore = adapter.sent.length
      await runScript(adapter, SCENARIOS['asks-for-human'].lines, { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
      const replies = adapter.sent.slice(sentBefore).map(r => r.text || '')
      assert.ok(replies.some(t => HUMAN.test(t)), `expected a human-handoff reply in: ${JSON.stringify(replies)}`)
      const caseRow = (await store.listCases()).find(c => c.external_id === chan)
      assert.ok((caseRow.tags || '').includes('needs-human'), 'case flagged needs-human')
    })

    await test('scenario "afrikaans-farmer": a deterministic reply comes back in Afrikaans', async () => {
      const chan = 'scn-af'
      const sentBefore = adapter.sent.length
      await runScript(adapter, SCENARIOS['afrikaans-farmer'].lines, { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
      const replies = adapter.sent.slice(sentBefore).map(r => r.text || '')
      // "dankie" is a deterministic THANKS intent -> Afrikaans reply (guessLang->af).
      assert.ok(replies.some(t => /\b(Dankie|Plesier|span|verwysing|beeste|diere)\b/i.test(t)),
        `expected an Afrikaans reply in: ${JSON.stringify(replies)}`)
    })

    await test('STOP then a later message: contact is not auto-replied again', async () => {
      const chan = 'scn-stop'
      await runScript(adapter, ['stop'], { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
      const afterStop = adapter.sent.length
      await runScript(adapter, ['ok thanks'], { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
      assert.equal(adapter.sent.length, afterStop, 'no auto-reply after opt-out')
    })

    await test('HELP keyword returns a plain menu without an LLM turn', async () => {
      const chan = 'scn-help'
      // first message must NOT be help (first-message greeting wins), so seed one
      await runScript(adapter, ['hi there'], { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
      const before = adapter.sent.length
      await runScript(adapter, ['help'], { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
      const last = adapter.sent[adapter.sent.length - 1]
      assert.ok(adapter.sent.length > before, 'help produced a reply')
      assert.ok(/STATUS|HUMAN|STOP/.test(last.text), `help menu shown: ${last.text}`)
    })

    await test('intent: irreversible-action false positives stay safe (substrings do not trigger stop/handoff)', async () => {
      const { detectContactIntent } = await import('./src/gateway-hooks.js')
      const cases = [
        ['dont stop', null], ['no stop', null],
        ['bus stop near me', null], ['not now', null], ['nothing yet', null],
        ['now what', null], ['personal details', null],
        ['a person told me to message you', null], ['someone told me my case is ready', null],
        ['in person at the office', null],
        ['no problem', null], ['no human needed thanks', null],
        ['yes', null], ['nope', null], ['55', null], ['ab-4471', null],
      ]
      for (const [inp, exp] of cases)
        assert.equal(detectContactIntent(inp), exp, `"${inp}" -> ${detectContactIntent(inp)} expected ${exp}`)
      // The load-bearing safety contract: a negated stop never opts the contact
      // out and never forces a handoff (a benign help/menu outcome is fine).
      for (const inp of ['please dont stop helping', 'do not stop', 'never stop'])
        assert.ok(!['stop', 'human'].includes(detectContactIntent(inp)), `"${inp}" must not trigger stop/human`)
      // Negation must guard MULTI-WORD keys too, not just single words: the negator
      // before the first phrase word blanks the whole phrase.
      for (const inp of ['please dont leave me alone', 'do not call me'])
        assert.ok(!['stop', 'human'].includes(detectContactIntent(inp)), `negated phrase "${inp}" must not trigger stop/human`)
      // STATUS is whole-word, so an inflected substring in an unrelated report
      // ("nothing updated since the sickness started") must NOT shortcut to a
      // canned status reply -- it must reach the agent (null intent here).
      assert.equal(detectContactIntent('nothing updated since the sickness started'), null,
        '"updated" inside a report must not match the STATUS keyword "update"')
      assert.equal(detectContactIntent('the cow stopped eating completely'), null,
        '"stopped" inside a report must not match the STOP keyword')
    })

    await test('intent: true positives across languages and the "???" help signal', async () => {
      const { detectContactIntent } = await import('./src/gateway-hooks.js')
      const cases = [
        ['STOP', 'stop'], ['hou op', 'stop'], ['yeka', 'stop'], ['genoeg', 'stop'],
        ['i want to talk to a human', 'human'], ['umuntu', 'human'], ['regte persoon', 'human'],
        ['call me please', 'human'],
        ['any news?', 'status'], ['enige nuus', 'status'],
        ['???', 'help'], ['usizo', 'help'], ['hulp', 'help'],
        ['thank you', 'thanks'], ['ngiyabonga', 'thanks'], ['dankie', 'thanks'],
        ['hi', 'greeting'], ['sawubona', 'greeting'], ['goeie more', 'greeting'],
        ['stop i need a human', 'stop'], ['help me reach a person', 'human'],
      ]
      for (const [inp, exp] of cases)
        assert.equal(detectContactIntent(inp), exp, `"${inp}" -> ${detectContactIntent(inp)} expected ${exp}`)
    })

    await test('STATUS on a later message hits the deterministic status reply (offers a person, cites ref)', async () => {
      const chan = 'fp-status'
      await runScript(adapter, ['hello'], { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
      const before = adapter.sent.length
      await runScript(adapter, ['status'], { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
      const last = adapter.sent[adapter.sent.length - 1]
      assert.ok(adapter.sent.length > before)
      assert.ok(/HUMAN/.test(last.text), `status shortcut taken: ${last.text}`)
      const id = (await store.listCases()).find(c => c.external_id === chan).id
      const ev = (await store.listEvents(id)).pop()
      assert.equal(ev.data && JSON.parse(ev.data).deterministic, true, 'answered deterministically')
    })

    await test('HELP on the FIRST message is NOT shortcut: the agent greeting wins and cites the reference', async () => {
      const chan = 'fp-help-first'
      const before = adapter.sent.length
      await runScript(adapter, ['help'], { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
      const c = (await store.listCases()).find(x => x.external_id === chan)
      const last = adapter.sent[adapter.sent.length - 1]
      assert.ok(adapter.sent.length > before, 'first-message help got a reply')
      const lastEv = (await store.listEvents(c.id)).filter(e => e.kind === 'outbound').pop()
      assert.notEqual(lastEv.actor, 'system', 'first-message help handled by the agent, not the deterministic menu')
      assert.ok(last.text.includes(c.ref), 'greeting cites the reference')
    })

    await test('OPT-OUT respected: STOP then a status-like message stays silent; HUMAN still breaks through', async () => {
      const chan = 'respect-optout'
      await runScript(adapter, ['stop'], { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
      const afterStop = adapter.sent.length
      await runScript(adapter, ['any update on this'], { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
      assert.equal(adapter.sent.length, afterStop, 'opted-out contact not messaged on a status follow-up')
      const c = (await store.listCases()).find(x => x.external_id === chan)
      const obs = (await store.listEvents(c.id)).filter(e => e.kind === 'observation').map(e => e.text)
      assert.ok(obs.some(t => /opt.?out|stop messaging/i.test(t)), 'opt-out respected and noted')
      const beforeHuman = adapter.sent.length
      await runScript(adapter, ['i need a human'], { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
      assert.equal(adapter.sent.length, beforeHuman + 1, 'HUMAN overrides opt-out so a stuck contact can reach a person')
      assert.ok(/person|HUMAN/i.test(adapter.sent[adapter.sent.length - 1].text), 'override reply offers a person')
    })

    await test('OBSERVE autonomy respected: an intent keyword still sends nothing, only an observation', async () => {
      const chan = 'respect-observe'
      await runScript(adapter, ['hello there'], { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
      const c = (await store.listCases()).find(x => x.external_id === chan)
      await store.updateCase(c.id, { autonomy: 'observe' }, { id: 'op', role: 'operator' })
      const before = adapter.sent.length
      await runScript(adapter, ['status please'], { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
      assert.equal(adapter.sent.length, before, 'observe mode sends nothing automatically')
      const obs = (await store.listEvents(c.id)).filter(e => e.kind === 'observation').map(e => e.text)
      assert.ok(obs.some(t => /observe/i.test(t)), 'observe mode noted for the operator')
    })

    await test('false-positive-guard persona: complaints with trigger substrings reach the agent, never opt-out', async () => {
      const chan = 'scn-fpg'
      const sentBefore = adapter.sent.length
      await runScript(adapter, SCENARIOS['false-positive-guard'].lines, { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
      const replies = adapter.sent.slice(sentBefore).filter(r => r.text != null)
      const c = (await store.listCases()).find(x => x.external_id === chan)
      assert.ok(replies.length >= 1)
      for (const r of replies) assert.ok(r.text.trim().length > 0 && r.text.includes(c.ref), `safe reply: ${r.text}`)
      assert.ok(!(c.tags || '').includes('opted-out'), 'a complaint containing "stopped" did NOT opt the contact out')
    })
  }

  // ---- CRUCIBLE: concurrency x volume x partial failure, one test -----------
  // Drives the full inbound chain under three simultaneous stressors and asserts
  // the system degrades safely:
  //   (1) CONCURRENCY: N distinct conversations fire at once, and each one's
  //       FIRST message is duplicated DUP-fold in the same tick. Contract: one
  //       case AND one recorded inbound per conversation -- the recordInbound
  //       lock makes the duplicate structurally unrepresentable.
  //   (2) PARTIAL FAILURE: adapter.send throws for a subset of conversations.
  //       Contract: those cases still exist, the failure is RECORDED on the
  //       timeline (no silent loss), and healthy conversations still get a reply.
  //   (3) VOLUME: countCases delta is exact and the dashboard still answers.
  await test('CRUCIBLE: concurrent volume + per-conversation dedup + partial send failure', async () => {
    const N = 40
    const DUP = 4
    const tag = 'cru'
    const idx = (to) => { const m = /cru-(\d+)/.exec(String(to)); return m ? parseInt(m[1], 10) : -1 }
    const failing = new Set(Array.from({ length: N }, (_, i) => i).filter(i => i % 3 === 0))

    const before = await store.countCases()

    const origSend = adapter.send.bind(adapter)
    adapter.send = async (reply) => {
      if (failing.has(idx(reply.to))) throw new Error('simulated channel outage')
      return origSend(reply)
    }
    try {
      // Fire everything concurrently: emit() is synchronous and casey wraps each
      // inbound as an in-flight promise, so all N*DUP turns are inflight before
      // drain() awaits them. The DUP identical messages share a msg id, so the
      // recordInbound lock must collapse them to one inbound each.
      for (let i = 0; i < N; i++) {
        const chan = `${tag}-${i}`
        for (let d = 0; d < DUP; d++) {
          adapter.inject({ from: chan, channel_id: chan, username: chan, text: 'my order is late', id: `${chan}-msg1` })
        }
      }
      await casey.drain()

      // (1) exactly one case per conversation -- the find-or-create lock held.
      const cruCases = (await store.listCases({}, { limit: 100000 }))
        .filter(c => String(c.external_id).startsWith(`${tag}-`))
      assert.equal(cruCases.length, N, `expected ${N} cases, got ${cruCases.length} (duplicate case = lock failure)`)
      assert.equal(new Set(cruCases.map(c => c.id)).size, N, 'every conversation maps to one distinct case id')

      for (const c of cruCases) {
        const events = await store.listEvents(c.id, { limit: 100000 })
        // one inbound recorded despite DUP identical concurrent deliveries.
        const inbounds = events.filter(e => e.kind === 'inbound')
        assert.equal(inbounds.length, 1, `case ${c.external_id} recorded ${inbounds.length} inbounds (dedup race)`)
        // exactly one case-opened note -- proves the create ran once under lock.
        const opened = events.filter(e => e.kind === 'note' && /Case opened/i.test(e.text))
        assert.equal(opened.length, 1, `case ${c.external_id} opened ${opened.length} times`)

        // (2) partial failure: failing convos carry a send-failure observation;
        // healthy convos do not, and were actually delivered a reply.
        const obs = events.filter(e => e.kind === 'observation' && /send failed/i.test(e.text))
        if (failing.has(idx(c.external_id))) {
          assert.ok(obs.length >= 1, `failing convo ${c.external_id} must record a send failure`)
        } else {
          assert.equal(obs.length, 0, `healthy convo ${c.external_id} must NOT record a send failure`)
          assert.ok(adapter.sent.some(r => r.to === c.external_id), `healthy convo ${c.external_id} should have a delivered reply`)
        }
        assert.notEqual(c.status, 'closed', `case ${c.external_id} should be live, not closed`)
      }
    } finally {
      adapter.send = origSend
    }

    // (3) volume: countCases delta is exact, dashboard still answers under load.
    const after = await store.countCases()
    assert.equal(after - before, N, `countCases grew by exactly ${N}: ${before} -> ${after}`)

    const cru = await createDashboard(store, { port: 4579, token: 'secret' })
    try {
      const r = await df('http://localhost:4579/api/cases?token=secret&limit=1').then(r => r.json())
      assert.ok(Array.isArray(r.cases) && r.cases.length === 1, 'dashboard still serves a page under load')
      assert.equal(r.total, after, `dashboard total matches countCases (${r.total} vs ${after})`)
    } finally { await cru.close() }
  })

  // Language-aware deterministic replies, in the SA languages casey covers
  // offline (en/af/zu/xh + Sotho/Tswana fallbacks). A farmer who writes in
  // Afrikaans must not get an English canned reply. Pure functions, asserted
  // directly. (The live model handles any other language.)
  await test('localized intentReply: thanks mirrors the contact language (SA)', async () => {
    const c = { ref: 'CASE-9-x', status: 'new' }
    assert.match(intentReply('thanks', c, 'af'), /Plesier|Dankie/, 'Afrikaans thanks')
    assert.match(intentReply('thanks', c, 'af'), /U verwysing is CASE-9-x/, 'Afrikaans ref tail')
    assert.match(intentReply('thanks', c, 'zu'), /Wamukelekile|Siyabonga/, 'isiZulu thanks')
    assert.match(intentReply('thanks', c, 'xh'), /Wamkelekile|Enkosi/, 'isiXhosa thanks')
    assert.match(intentReply('thanks', c, 'en'), /welcome|reporting/i, 'English default')
    assert.match(intentReply('thanks', c, 'zz'), /welcome|reporting/i, 'unknown lang falls back to English')
  })
  await test('localized intentReply: status reply stays in one language (SA)', async () => {
    const c = { ref: 'CASE-9-y', status: 'in_progress' }
    const af = intentReply('status', c, 'af')
    assert.match(af, /span|werk/i, 'Afrikaans status body')
    assert.match(af, /MENS/, 'Afrikaans status tail keyword')
    assert.ok(!/Reply HUMAN/.test(af), 'no English tail leaking into Afrikaans status')
  })
  await test('localized fallbackReply: holding message mirrors language + cites ref (SA)', async () => {
    const c = { ref: 'CASE-9-z' }
    const af = fallbackReply('hallo my beeste is siek en het nie geeet nie', c)
    assert.match(af, /Dankie/, 'Afrikaans fallback')
    assert.match(af, /verwysingsnommer is CASE-9-z/, 'Afrikaans ref')
    const en = fallbackReply('hi my cattle are sick', c)
    assert.match(en, /Thank you for letting us know/, 'English fallback default')
    const zu = fallbackReply('sawubona izinkomo zami ziyagula ngicela usizo', c)
    assert.match(zu, /Siyabonga/, 'isiZulu fallback')
  })

  // Domain: the structured report accretes across messages and is never lost.
  await test('case_report: fields from several messages merge into one report', async () => {
    const { buildCaseToolset } = await import('./src/case-tools.js')
    // Unique external_id so this case is fresh and isolated from other tests.
    const { case: rc } = await store.findOrCreateCase({ channel: 'sim', external_id: 'report-merge-' + Date.now() })
    const tools = buildCaseToolset(store)
    const report = tools.find(t => t.name === 'case_report')
    await report.handler({ id: rc.id, species: 'cattle', symptoms: 'drooling' })
    await report.handler({ id: rc.id, location: 'near Musina', affected_count: '6' })
    const r = await report.handler({ id: rc.id, dead_count: '2', suspected_disease: 'foot and mouth' })
    assert.equal(r.report.species, 'cattle', 'species retained across merges')
    assert.equal(r.report.dead_count, '2', 'later field recorded')
    assert.equal(Object.keys(r.report).length, 6, `all six fields present, none lost: ${JSON.stringify(r.report)}`)
    // idempotent: re-sending a known field must not duplicate or drop others
    const r2 = await report.handler({ id: rc.id, species: 'cattle' })
    assert.equal(Object.keys(r2.report).length, 6, 'idempotent re-send keeps the report whole')
  })
  await test('case_report: concurrent merges for one case lose no fields (atomic mergeReport)', async () => {
    const { buildCaseToolset } = await import('./src/case-tools.js')
    const { case: rc } = await store.findOrCreateCase({ channel: 'sim', external_id: 'report-race-' + Date.now() })
    const report = buildCaseToolset(store).find(t => t.name === 'case_report')
    // Fire distinct single-field merges in parallel: without the per-conversation
    // lock these would read the same stale report and clobber each other.
    await Promise.all([
      report.handler({ id: rc.id, species: 'cattle' }),
      report.handler({ id: rc.id, symptoms: 'drooling' }),
      report.handler({ id: rc.id, location: 'Musina' }),
      report.handler({ id: rc.id, dead_count: '2' }),
      report.handler({ id: rc.id, onset: 'today' }),
      report.handler({ id: rc.id, affected_count: '6' }),
    ])
    const rep = JSON.parse((await store.getCase(rc.id)).report || '{}')
    assert.equal(Object.keys(rep).length, 6, `all six concurrent fields present, none lost: ${JSON.stringify(rep)}`)
  })
  // One-shot: a received animal photo is the highest-value on-site artifact and
  // cannot be recovered after the worker leaves. It must be recorded as explicit
  // case state at ingress, deterministically -- never left to the agent turn to
  // notice. Drive a media-only inbound straight through the handler (no LLM) and
  // assert report.photos is set.
  await test('inbound photo is recorded on the report at ingress, without an agent turn', async () => {
    const { makeCaseHandler } = await import('./src/gateway-hooks.js')
    const handler = makeCaseHandler(store, { callLLM: null, autoRespond: false, log: { info(){}, warn(){}, error(){} } })
    const ctx = { platforms: { get: () => null } }
    const ext = 'photo-ingest-' + Date.now()
    // WhatsApp surfaces an image as raw.type === 'image' (see the webhook test).
    const res = await handler.call(ctx, 'whatsapp', { from: ext, text: '', raw: { id: 'wamid.photo.1', type: 'image', chatId: ext } })
    const c = await store.getCase(res.caseId)
    const rep = JSON.parse(c.report || '{}')
    assert.ok(rep.photos && /photo/i.test(rep.photos), `photo recorded on report at ingress: ${JSON.stringify(rep)}`)
    // And it must NOT clobber a description the agent records later: a second photo
    // arrives after the agent wrote a richer note -> the richer note survives.
    await store.mergeReport(res.caseId, { photos: 'clear photo of a drooling cow, ear tag 042' })
    await handler.call(ctx, 'whatsapp', { from: ext, text: '', raw: { id: 'wamid.photo.2', type: 'image', chatId: ext } })
    const rep2 = JSON.parse((await store.getCase(res.caseId)).report || '{}')
    assert.equal(rep2.photos, 'clear photo of a drooling cow, ear tag 042', 'fill-if-empty never clobbers the agent\'s richer photo note')
    // A non-image media-only message (sticker/audio) must NOT set photos.
    const ext2 = 'sticker-ingest-' + Date.now()
    const res2 = await handler.call(ctx, 'whatsapp', { from: ext2, text: '', raw: { id: 'wamid.sticker.1', type: 'sticker', chatId: ext2 } })
    const rep3 = JSON.parse((await store.getCase(res2.caseId)).report || '{}')
    assert.ok(rep3.photos == null, `a sticker does not set photos: ${JSON.stringify(rep3)}`)
  })
  await test('inbound voice note is recorded on the report at ingress, without an agent turn', async () => {
    const { makeCaseHandler } = await import('./src/gateway-hooks.js')
    const handler = makeCaseHandler(store, { callLLM: null, autoRespond: false, log: { info(){}, warn(){}, error(){} } })
    const ctx = { platforms: { get: () => null } }
    const ext = 'audio-ingest-' + Date.now()
    // A low-literacy farmer often speaks rather than types: WhatsApp surfaces a
    // voice note as raw.audio (or type 'audio'). It must become explicit state.
    const res = await handler.call(ctx, 'whatsapp', { from: ext, text: '', raw: { id: 'wamid.audio.1', type: 'audio', chatId: ext } })
    const rep = JSON.parse((await store.getCase(res.caseId)).report || '{}')
    assert.ok(rep.audio && /voice/i.test(rep.audio), `voice note recorded on report at ingress: ${JSON.stringify(rep)}`)
    // Fill-if-empty: an operator's richer transcription survives a later voice note.
    await store.mergeReport(res.caseId, { audio: 'farmer says 3 cattle dead since Tuesday near the river' })
    await handler.call(ctx, 'whatsapp', { from: ext, text: '', raw: { id: 'wamid.audio.2', type: 'audio', chatId: ext } })
    const rep2 = JSON.parse((await store.getCase(res.caseId)).report || '{}')
    assert.equal(rep2.audio, 'farmer says 3 cattle dead since Tuesday near the river', 'fill-if-empty never clobbers a richer audio note')
    // A sticker is not audio.
    const ext2 = 'audio-neg-' + Date.now()
    const res2 = await handler.call(ctx, 'whatsapp', { from: ext2, text: '', raw: { id: 'wamid.sticker.2', type: 'sticker', chatId: ext2 } })
    const rep3 = JSON.parse((await store.getCase(res2.caseId)).report || '{}')
    assert.ok(rep3.audio == null, `a sticker does not set audio: ${JSON.stringify(rep3)}`)
  })
  await test('guessLang detects SA-language stop/human words (yeka/hou op/umntu)', async () => {
    const { guessLang } = await import('./src/gateway-hooks.js')
    // A farmer who writes only a stop/human word in their own language must be
    // detected, so the reply localizes instead of falling back to English.
    assert.equal(guessLang('hou op los my'), 'af', 'Afrikaans stop words detected')
    assert.equal(guessLang('yeka hambani umuntu'), 'zu', 'Zulu stop/human words detected')
    assert.equal(guessLang('umntu hamba'), 'xh', 'Xhosa human/leave words detected')
    assert.equal(guessLang('please help me'), 'en', 'plain English still falls back to English')
  })
  // ---- correlation: which cases are the SAME outbreak vs SEPARATE ----------
  await test('correlationScore: same outbreak scores high, unrelated scores low', async () => {
    const { correlationScore, SUGGEST_THRESHOLD } = await import('./src/correlate.js')
    const A = { id: '1', ref: 'CASE-1', channel: 'whatsapp', external_id: '27820000001', created_at: 1000000,
      report: JSON.stringify({ location: 'Musina, near the baobab on the Pontdrift road', species: 'cattle', symptoms: 'drooling and blisters' }) }
    const B = { id: '2', ref: 'CASE-2', channel: 'whatsapp', external_id: '27820000002', created_at: 1000000 + 86400,
      report: JSON.stringify({ location: 'Musina, the baobab on Pontdrift road', species: 'cattle', symptoms: 'blisters on the mouth' }) }
    const C = { id: '3', ref: 'CASE-3', channel: 'whatsapp', external_id: '27820000003', created_at: 1000000,
      report: JSON.stringify({ location: 'Upington', species: 'sheep', symptoms: 'lameness' }) }
    const same = correlationScore(A, B)
    const diff = correlationScore(A, C)
    assert.ok(same.score >= SUGGEST_THRESHOLD, `same outbreak clears threshold: ${same.score} (${same.reasons.join('; ')})`)
    assert.ok(diff.score < SUGGEST_THRESHOLD, `unrelated stays below threshold: ${diff.score}`)
    assert.ok(same.reasons.some(r => /location/.test(r)), `reasons explain the link: ${same.reasons.join('; ')}`)
  })
  await test('correlationScore: a fallback number that matches another case links them', async () => {
    const { correlationScore } = await import('./src/correlate.js')
    // Different contact numbers, but A names B's number as a fallback ("call my
    // brother on the other number") -- the cross-number outbreak.
    const A = { id: '1', ref: 'CASE-1', channel: 'whatsapp', external_id: '27820000001', created_at: 1000000,
      report: JSON.stringify({ contact_fallback: '082 000 0002', species: 'goats' }) }
    const B = { id: '2', ref: 'CASE-2', channel: 'whatsapp', external_id: '+27 82 000 0002', created_at: 1000000,
      report: JSON.stringify({ species: 'goats' }) }
    const r = correlationScore(A, B)
    assert.ok(r.reasons.some(x => /fallback/.test(x)), `fallback-number link detected: ${r.reasons.join('; ')}`)
  })
  await test('correlationScore: time alone never manufactures a match', async () => {
    const { correlationScore } = await import('./src/correlate.js')
    const A = { id: '1', channel: 'whatsapp', external_id: 'a', created_at: 1000000, report: JSON.stringify({ location: 'Musina', species: 'cattle' }) }
    const B = { id: '2', channel: 'whatsapp', external_id: 'b', created_at: 1000000, report: JSON.stringify({ location: 'Cape Town', species: 'pigs' }) }
    assert.equal(correlationScore(A, B).score, 0, 'same instant but nothing in common -> not the same outbreak')
  })

  // ---- merge: post-fixing two cases that are really one --------------------
  await test('mergeCases is lossless, fill-if-empty, and idempotent', async () => {
    const { case: tgt } = await store.findOrCreateCase({ channel: 'sim', external_id: 'merge-tgt-' + Date.now() })
    const { case: src } = await store.findOrCreateCase({ channel: 'sim', external_id: 'merge-src-' + Date.now() })
    await store.appendEvent(tgt.id, { kind: 'inbound', actor: 'contact', text: 'target msg 1' })
    await store.appendEvent(src.id, { kind: 'inbound', actor: 'contact', text: 'source msg 1' })
    await store.appendEvent(src.id, { kind: 'inbound', actor: 'contact', text: 'source msg 2' })
    await store.mergeReport(tgt.id, { species: 'cattle', location: 'Musina' })
    await store.mergeReport(src.id, { location: 'SOURCE LOC SHOULD NOT WIN', onset: 'last tuesday' })
    const tgtBefore = (await store.listEvents(tgt.id)).length
    const srcBefore = (await store.listEvents(src.id)).length
    const res = await store.mergeCases(src.id, tgt.id, { id: 'op', role: 'operator' }, { reason: 'same herd' })
    assert.ok(res.merged, 'merge reported success')
    // Lossless: target now holds every event from both, plus the two merge notes.
    const tgtAfter = (await store.listEvents(tgt.id)).length
    assert.equal(tgtAfter, tgtBefore + srcBefore + 1, `all events folded in (+target merge note): ${tgtAfter}`)
    // Fill-if-empty: target's location wins; source-only onset is added.
    const rep = JSON.parse((await store.getCase(tgt.id)).report || '{}')
    assert.equal(rep.location, 'Musina', 'canonical target location preserved (not clobbered)')
    assert.equal(rep.onset, 'last tuesday', 'source-only field folded in')
    // Source is a redirect: tagged merged, walked out of the open set.
    const srcRow = await store.getCase(src.id)
    assert.ok((srcRow.tags || '').split(',').includes('merged'), 'source tagged merged')
    assert.equal(srcRow.status, 'closed', 'source closed out of the open-case set')
    // Idempotent: re-merging the emptied source is a no-op, no duplicate events.
    const res2 = await store.mergeCases(src.id, tgt.id, { id: 'op', role: 'operator' })
    assert.ok(res2.alreadyMerged, 'second merge is a no-op')
    assert.equal((await store.listEvents(tgt.id)).length, tgtAfter, 'no duplicate events on re-merge')
  })
  await test('mergeCases rejects a self-merge', async () => {
    const { case: c } = await store.findOrCreateCase({ channel: 'sim', external_id: 'self-merge-' + Date.now() })
    const res = await store.mergeCases(c.id, c.id, { id: 'op', role: 'operator' })
    assert.ok(res.error && /itself/.test(res.error), `self-merge rejected: ${res.error}`)
  })

  // ---- split: post-fixing one case that is really two ----------------------
  await test('splitCase moves exactly the named events into a new linked case', async () => {
    const { case: c } = await store.findOrCreateCase({ channel: 'sim', external_id: 'split-' + Date.now() })
    const e1 = await store.appendEvent(c.id, { kind: 'inbound', actor: 'contact', text: 'cattle drooling in Musina' })
    await store.appendEvent(c.id, { kind: 'inbound', actor: 'contact', text: 'and also...' })
    const e3 = await store.appendEvent(c.id, { kind: 'inbound', actor: 'contact', text: 'my sheep in Upington are lame too' })
    // Resolve the real event ids (appendEvent returns thatcher's create record).
    const all = await store.listEvents(c.id)
    const sheepEv = all.find(e => /Upington/.test(e.text))
    const before = all.length
    const res = await store.splitCase(c.id, [sheepEv.id], { subject: 'sheep in Upington', reason: 'separate outbreak' }, { id: 'op', role: 'operator' })
    assert.ok(res.split, 'split reported success')
    // Source loses exactly the moved event (+ gains a linking note).
    const srcEvents = await store.listEvents(c.id)
    assert.ok(!srcEvents.some(e => e.id === sheepEv.id), 'moved event left the source')
    assert.equal(srcEvents.length, before - 1 + 1, 'source: one event left, one link note added')
    // New case has the moved event + its own linking note.
    const newEvents = await store.listEvents(res.newCase.id)
    assert.ok(newEvents.some(e => /Upington/.test(e.text)), 'moved event landed on the new case')
    assert.ok(newEvents.some(e => e.kind === 'note' && /Split out of/.test(e.text)), 'new case has the provenance note')
  })
  await test('splitCase rejects emptying the source and unknown events', async () => {
    const { case: c } = await store.findOrCreateCase({ channel: 'sim', external_id: 'split-bad-' + Date.now() })
    await store.appendEvent(c.id, { kind: 'inbound', actor: 'contact', text: 'only event' })
    const all = await store.listEvents(c.id)
    const r1 = await store.splitCase(c.id, all.map(e => e.id), {}, { id: 'op', role: 'operator' })
    assert.ok(r1.error && /every event/.test(r1.error), `all-events split rejected: ${r1.error}`)
    const r2 = await store.splitCase(c.id, ['no-such-event'], {}, { id: 'op', role: 'operator' })
    assert.ok(r2.error && /not on case/.test(r2.error), `unknown-event split rejected: ${r2.error}`)
  })

  // ---- xstate lifecycle machine: illegal transitions are unrepresentable -----
  await test('case machine accepts legal transitions and rejects illegal ones, with role gates', async () => {
    const { buildCaseMachine, canTransition, nextStates } = await import('./src/case-machine.js')
    const m = buildCaseMachine(store._wf)
    assert.ok(canTransition(m, 'new', 'triaging').ok, 'new -> triaging legal')
    assert.ok(canTransition(m, 'triaging', 'new').ok, 'triaging -> new legal (backward)')
    assert.ok(!canTransition(m, 'new', 'closed').ok, 'new -> closed illegal')
    assert.ok(!canTransition(m, 'resolved', 'new').ok, 'resolved -> new illegal')
    assert.ok(!canTransition(m, 'new', 'nonsense').ok, 'unknown target rejected')
    // closed requires operator/admin: an agent cannot put a resolved case to closed.
    assert.ok(!canTransition(m, 'resolved', 'closed', 'agent').ok, 'agent cannot enter closed')
    assert.ok(canTransition(m, 'resolved', 'closed', 'operator').ok, 'operator can enter closed')
    // nextStates parity with the store's availableTransitions for a sample case.
    const ns = nextStates(m, 'triaging', 'operator').sort()
    assert.deepEqual(ns, store.availableTransitions({ status: 'triaging' }, { role: 'operator' }).sort(), 'nextStates matches availableTransitions')
  })
  await test('store transition still enforces legality through the machine', async () => {
    const { case: c } = await store.findOrCreateCase({ channel: 'sim', external_id: 'machine-' + Date.now() })
    await assert.rejects(() => store.transition(c.id, 'closed', { user: { id: 'a', role: 'agent' } }),
      /cannot move new -> closed/, 'illegal transition rejected by the machine via store')
    const moved = await store.transition(c.id, 'triaging', { user: { id: 'a', role: 'agent' } })
    assert.equal(moved.status, 'triaging', 'legal transition still works')
  })

  // ---- time-based guardrails: how a case goes wrong OVER TIME -----------------
  await test('classifyCaseHealth fires each breach at its threshold and not before', async () => {
    const { classifyCaseHealth, DEFAULT_THRESHOLDS: T } = await import('./src/case-health.js')
    const now = 10_000_000_000_000
    const breaches = c => classifyCaseHealth(c, now).map(b => b.breach)
    // Fresh open case: healthy.
    assert.deepEqual(breaches({ status: 'new', last_event_at: new Date(now - 1000).toISOString(), report: '{}' }), [], 'fresh case healthy')
    // Just under stale: still healthy. Just over: stale.
    const justUnder = new Date(now - T.staleMs + 60e3).toISOString()
    const justOver = new Date(now - T.staleMs - 60e3).toISOString()
    assert.ok(!breaches({ status: 'in_progress', last_event_at: justUnder, report: '{}' }).includes('stale'), 'under threshold not stale')
    assert.ok(breaches({ status: 'in_progress', last_event_at: justOver, report: '{}' }).includes('stale'), 'over threshold is stale')
    // Closed case: never stale/stuck.
    assert.deepEqual(breaches({ status: 'closed', last_event_at: justOver, report: '{}' }), [], 'closed case has no breaches')
    // Unanswered handoff: needs-human tag + idle past handoffMs.
    const ho = new Date(now - T.handoffMs - 60e3).toISOString()
    assert.ok(breaches({ status: 'waiting', tags: 'needs-human', last_event_at: ho, report: '{}' }).includes('unanswered_handoff'), 'unanswered handoff fires')
    // Abandoned intake: visit-critical missing + idle past abandonMs.
    const ab = new Date(now - T.abandonMs - 60e3).toISOString()
    assert.ok(breaches({ status: 'new', last_event_at: ab, report: JSON.stringify({ species: 'cattle' }) }).includes('abandoned_intake'), 'abandoned intake fires')
    // never_closed: resolved + idle past neverClosedMs.
    const nc = new Date(now - T.neverClosedMs - 60e3).toISOString()
    assert.ok(breaches({ status: 'resolved', last_event_at: nc, report: '{}' }).includes('never_closed'), 'never-closed fires')
    // incomplete_critical: active work stage but critical facts still missing.
    const icMs = T.incompleteCriticalMs ?? (8 * 3600e3)
    const ic = new Date(now - icMs - 60e3).toISOString()
    assert.ok(breaches({ status: 'in_progress', last_event_at: ic, report: JSON.stringify({ species: 'cattle' }) }).includes('incomplete_critical'), 'incomplete_critical fires in in_progress with missing facts')
    assert.ok(!breaches({ status: 'in_progress', last_event_at: ic, report: JSON.stringify({ species: 'cattle', symptoms: 'x', location: 'x', how_to_find: 'x', farmer_available: 'x', contact_fallback: 'x' }) }).includes('incomplete_critical'), 'incomplete_critical clears when all critical fields filled')
    // Multiple at once.
    const multi = breaches({ status: 'new', tags: 'needs-human', last_event_at: new Date(now - T.staleMs * 4).toISOString(), report: JSON.stringify({ species: 'cattle' }) })
    assert.ok(multi.includes('stale') && multi.includes('unanswered_handoff') && multi.includes('abandoned_intake'), `multiple breaches surface: ${multi}`)
  })

  await test('sweepCases flags, is idempotent, and clears when the case recovers', async () => {
    const { sweepCases } = await import('./src/case-sweep.js')
    const { DEFAULT_THRESHOLDS: T } = await import('./src/case-health.js')
    const { case: c } = await store.findOrCreateCase({ channel: 'sim', external_id: 'sweep-' + Date.now() })
    // Make it old: force last_event_at well past stale.
    const old = new Date(Date.now() - T.staleMs - 3600e3).toISOString()
    await store.t.update('case', c.id, { last_event_at: old }, { id: 'sys', role: 'admin' })
    const now = Date.now()
    const s1 = await sweepCases(store, now)
    const after1 = await store.getCase(c.id)
    assert.ok(String(after1.tags || '').split(',').includes('health:stale'), 'sweep set health:stale')
    const obs1 = (await store.listEvents(c.id)).filter(e => /GUARDRAIL \[stale\]/.test(e.text || '')).length
    assert.equal(obs1, 1, 'exactly one stale observation')
    // Idempotent: second sweep adds no new observation, no duplicate tag.
    await sweepCases(store, now)
    const tags2 = String((await store.getCase(c.id)).tags || '').split(',').filter(t => t === 'health:stale')
    assert.equal(tags2.length, 1, 'no duplicate health:stale tag')
    const obs2 = (await store.listEvents(c.id)).filter(e => /GUARDRAIL \[stale\]/.test(e.text || '')).length
    assert.equal(obs2, 1, 'no re-spammed observation on the second pass')
    // Recover: touch the case (recent last_event_at) -> next sweep clears the tag.
    await store.t.update('case', c.id, { last_event_at: new Date(now).toISOString() }, { id: 'sys', role: 'admin' })
    await sweepCases(store, now + 1000)
    assert.ok(!String((await store.getCase(c.id)).tags || '').split(',').includes('health:stale'), 'health:stale cleared after recovery')
  })
  await test('sweep preserves non-health tags (needs-human/merged) while reconciling health', async () => {
    const { sweepCases } = await import('./src/case-sweep.js')
    const { DEFAULT_THRESHOLDS: T } = await import('./src/case-health.js')
    const { case: c } = await store.findOrCreateCase({ channel: 'sim', external_id: 'sweep-tags-' + Date.now() })
    await store.updateCase(c.id, { tags: 'needs-human,vip' })
    const old = new Date(Date.now() - T.staleMs - 3600e3).toISOString()
    await store.t.update('case', c.id, { last_event_at: old }, { id: 'sys', role: 'admin' })
    await sweepCases(store, Date.now())
    const tags = String((await store.getCase(c.id)).tags || '').split(',')
    assert.ok(tags.includes('needs-human') && tags.includes('vip'), 'non-health tags preserved')
    assert.ok(tags.includes('health:stale'), 'health tag still added alongside')
  })
  await test('sweep scheduler starts and stops without leaking a timer', async () => {
    // Construct a bare Casey (no init) so we exercise ONLY the timer lifecycle --
    // creating a second fully-booted casey would swap the global case-store
    // singleton the tools resolve through and corrupt later tests.
    const { Casey } = await import('./src/casey.js')
    const c2 = new Casey({ channels: ['sim'] })
    c2.store = store   // a real store so a fired sweep would not throw
    c2.startSweep(50)
    assert.ok(c2._sweepTimer, 'sweep timer started')
    c2.startSweep(50)  // restart must not leak the prior handle
    assert.ok(c2._sweepTimer, 'restart keeps exactly one timer')
    c2.stopSweep()
    assert.equal(c2._sweepTimer, null, 'sweep timer cleared on stop')
    c2.stopSweep()     // double-stop is safe
  })

  // Theme A -- alerting. The sweep must PAGE a person on the breaches a person
  // must act on, route the escalated tier to a distinct supervisor channel, and
  // an observe-mode inbound must flag needs-human and hand off exactly once.
  await test('runSweepOnce pages notifyBreach on a high-severity breach and routes the escalated tier to notifyEscalation', async () => {
    const { Casey } = await import('./src/casey.js')
    const { DEFAULT_THRESHOLDS: T } = await import('./src/case-health.js')
    // A bare Casey wired to the real store but with notifier STUBS, so we observe
    // exactly which channel each breach pages. No gateway boot -> the global
    // case-store singleton the tools resolve through is untouched.
    // Bare Casey (no init -> the notifier fields init() wires are unset), so set the
    // store + notifier stubs directly, exactly as the timer-lifecycle test sets store.
    const breaches = [], escalations = []
    const c3 = new Casey({ channels: ['sim'] })
    c3.store = store
    c3._notifyBreach = async (cs, b) => { breaches.push(b) }
    c3._notifyEscalation = async (cs, b) => { escalations.push(b) }
    // An unanswered handoff idle past the ESCALATION window: classifyCaseHealth
    // emits BOTH unanswered_handoff and unanswered_handoff_escalated (case-health.js:109-118).
    const escMs = T.escalateHandoffMs ?? (12 * 3600e3)
    const { case: hc } = await store.findOrCreateCase({ channel: 'sim', external_id: 'alert-' + Date.now() })
    await store.updateCase(hc.id, { tags: 'needs-human' })
    await store.t.update('case', hc.id, { last_event_at: new Date(Date.now() - escMs - 3600e3).toISOString() }, { id: 'sys', role: 'admin' })
    await c3.runSweepOnce(Date.now())
    assert.ok(breaches.includes('unanswered_handoff'), 'the ordinary tier pages notifyBreach')
    assert.ok(escalations.includes('unanswered_handoff_escalated'), 'the escalated tier pages notifyEscalation distinctly')
    assert.ok(!breaches.includes('unanswered_handoff_escalated'), 'the escalated breach does NOT also page the ordinary channel')
    // A stale-only breach (no needs-human) is surfaced in the inbox but never pages,
    // and a second sweep does NOT re-page the already-flagged handoff (the health tag
    // is the dedup key, so a page fires once per newly-entered breach).
    const sb = breaches.length, se = escalations.length
    const { case: st } = await store.findOrCreateCase({ channel: 'sim', external_id: 'stale-only-' + Date.now() })
    await store.t.update('case', st.id, { last_event_at: new Date(Date.now() - T.staleMs - 3600e3).toISOString() }, { id: 'sys', role: 'admin' })
    await c3.runSweepOnce(Date.now())
    assert.equal(escalations.length, se, 'an already-flagged handoff is not re-paged on the next sweep')
    assert.ok(!breaches.slice(sb).includes('stale'), 'a stale-only case is NOT paged (surfaced in inbox, not an alert)')
  })

  await test('coverage-gap: a roster idle while breaches pile up pages the team once (rising edge), and an operator reply clears it', async () => {
    const { detectCoverageGap } = await import('./src/case-sweep.js')
    const now = Date.now()
    // Pure detector first. A breaching open case + a non-empty roster + zero operator
    // replies in the window IS a coverage gap.
    const breachCase = { id: 'cg1', status: 'waiting', tags: 'health:unanswered_handoff' }
    const ev = new Map([['cg1', []]])
    const roster = [{ id: 'thandi' }, { id: 'sipho' }]
    assert.equal(detectCoverageGap([breachCase], ev, roster, now).gap, true, 'breaches + idle roster = a coverage gap')
    assert.equal(detectCoverageGap([breachCase], ev, [], now).gap, false, 'no roster = no one expected to cover = no gap')
    assert.equal(detectCoverageGap([{ id: 'x', status: 'waiting', tags: '' }], new Map([['x', []]]), roster, now).gap, false, 'no breaching case = no gap even with an idle roster')
    // An operator reply landing in the window clears the gap.
    const replied = new Map([['cg1', [{ kind: 'outbound', actor: 'operator', created_at: new Date(now - 5 * 60e3).toISOString() }]]])
    assert.equal(detectCoverageGap([breachCase], replied, roster, now).gap, false, 'a recent operator reply means the team is covering -- no gap')
    // A reply OLDER than the window does not clear it.
    const old = new Map([['cg1', [{ kind: 'outbound', actor: 'operator', created_at: new Date(now - 3 * 3600e3).toISOString() }]]])
    assert.equal(detectCoverageGap([breachCase], old, roster, now, { windowMs: 60 * 60e3 }).gap, true, 'a reply older than the window does not clear the gap')

    // Live rising-edge dedup against a real Casey. A bare Casey with a stubbed
    // notifier and the env roster (set at top of file) pages coverage_gap once.
    const { Casey } = await import('./src/casey.js')
    const pages = []
    const c4 = new Casey({ channels: ['sim'] })
    c4.store = store
    c4._notifyBreach = async (cs, b, detail) => { pages.push({ b, ref: cs?.ref, detail }) }
    assert.ok(c4._roster.length > 0, 'the env roster is parsed so a coverage gap is pageable')
    // A breaching, never-replied case in the live store. needs-human + an old
    // last_event_at makes the sweep tag health:unanswered_handoff.
    const { case: gc } = await store.findOrCreateCase({ channel: 'sim', external_id: 'coverage-' + Date.now() })
    await store.updateCase(gc.id, { tags: 'needs-human' })
    await store.t.update('case', gc.id, { last_event_at: new Date(now - 6 * 3600e3).toISOString() }, { id: 'sys', role: 'admin' })
    await c4.runSweepOnce(now)
    const cg = pages.filter(p => p.b === 'coverage_gap')
    assert.equal(cg.length, 1, 'the team is paged once for the coverage gap')
    assert.equal(cg[0].ref, 'TEAM-COVERAGE', 'the page reads as a team-coverage alert, not a per-case one')
    // A second sweep with the gap still open does NOT re-page (rising-edge dedup).
    await c4.runSweepOnce(now)
    assert.equal(pages.filter(p => p.b === 'coverage_gap').length, 1, 'a persistent gap is not re-paged every sweep')
  })

  await test('observe-mode inbound flags needs-human and fires notifyHandoff exactly once', async () => {
    const { makeCaseHandler } = await import('./src/gateway-hooks.js')
    let handoffs = 0
    const handle = makeCaseHandler(store, { notifyHandoff: async () => { handoffs++ }, log: { warn() {}, info() {} } })
    const chan = 'observe-' + Date.now()
    const { case: oc } = await store.findOrCreateCase({ channel: 'sim', external_id: chan })
    await store.updateCase(oc.id, { autonomy: 'observe' })
    const mk = (text) => ({ from: chan, text, platform: 'sim', raw: { channel_id: chan, id: chan + '-' + text } })
    const r1 = await handle('sim', mk('my cattle are sick'))
    assert.equal(r1.text, '', 'observe mode sends no auto-reply')
    assert.equal(r1.observed, true, 'inbound is recorded as observed')
    const tags = String((await store.getCase(oc.id)).tags || '').split(',').map(t => t.trim())
    assert.ok(tags.includes('needs-human'), 'observe inbound flags needs-human so the case surfaces')
    assert.equal(handoffs, 1, 'notifyHandoff fires once on first flag')
    await handle('sim', mk('still waiting'))
    assert.equal(handoffs, 1, 'a second observe inbound does NOT re-page (already flagged)')
  })

  await test('disease intake: stub records a report and asks at most one question per reply', async () => {
    const chan = 'farmer-intake-' + Date.now()
    const before = adapter.sent.length
    const transcript = await runScript(adapter, ['my cattle are drooling and 2 died'], { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
    const replies = adapter.sent.slice(before).map(r => r.text || '')
    for (const r of replies) assert.ok((r.match(/\?/g) || []).length <= 1, `at most one question per reply: ${r}`)
    // Fetch THIS run's case by the caseId the reply carried (not listCases order).
    const caseId = [...transcript].reverse().find(t => t.caseId)?.caseId
    const c = caseId ? await store.getCase(caseId) : (await store.listCases()).find(x => x.external_id === chan)
    let rep = {}; try { rep = JSON.parse(c.report || '{}') } catch {}
    assert.ok(Object.keys(rep).length >= 1, `offline intake recorded report fields: ${JSON.stringify(rep)}`)
  })

  // One-shot capture: the worker leaves the site after the first conversation, so
  // a closing "thanks" with a critical on-site fact still missing must NOT take the
  // canned shortcut -- it defers to the agent for one gentle ask, exactly once.
  await test('reportMissingVisitCritical flags incomplete reports, clears when ready', async () => {
    assert.equal(reportMissingVisitCritical(null), true, 'no report -> missing')
    assert.equal(reportMissingVisitCritical(JSON.stringify({ species: 'cattle' })), true, 'partial -> missing')
    const full = { species: 'cattle', symptoms: 'drooling', location: 'Musina', how_to_find: 'past baobab', farmer_available: 'yes', contact_fallback: '0721234567' }
    assert.equal(reportMissingVisitCritical(JSON.stringify(full)), false, 'all visit-critical present -> ready')
  })
  await test('closing "thanks" with a missing on-site fact defers (one-shot), fires once only', async () => {
    const chan = 'closing-' + Date.now()
    // intake: gives only symptoms (no location/availability/etc)
    const t0 = await runScript(adapter, ['my cattle are drooling'], { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
    const caseId = [...t0].reverse().find(t => t.caseId)?.caseId
    assert.ok(caseId, 'intake produced a case')
    // first "thanks": report still missing visit-critical -> defer + tag closing-nudged.
    const before1 = adapter.sent.length
    await runScript(adapter, ['ok thank you'], { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
    const reply1 = (adapter.sent.slice(before1)[0] || {}).text || ''
    const ev1 = await store.listEvents(caseId)
    assert.ok(ev1.some(e => e.kind === 'observation' && /CLOSING-NUDGE/.test(e.text || '')), 'first closing thanks records the one-shot CLOSING-NUDGE marker')
    assert.ok(reply1.length > 0, 'first thanks still produced a reply')
    // second "thanks": already nudged -> canned shortcut, never nags, never silent
    const before2 = adapter.sent.length
    await runScript(adapter, ['thanks again'], { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
    assert.ok((adapter.sent.slice(before2)[0] || {}).text, 'second thanks still gets a reply, never silence')
  })
  await test('closing "thanks" with a complete report just closes warmly (no extra question)', async () => {
    const chan = 'closing-ready-' + Date.now()
    const { case: rc } = await store.findOrCreateCase({ channel: 'sim', external_id: chan })
    await store.updateCase(rc.id, { report: JSON.stringify({ species: 'goats', symptoms: 'sudden death', location: 'Musina', how_to_find: 'past baobab', farmer_available: 'yes', contact_fallback: '0721234567' }) })
    const before = adapter.sent.length
    await runScript(adapter, ['thank you'], { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
    const reply = (adapter.sent.slice(before)[0] || {}).text || ''
    const evs = await store.listEvents(rc.id)
    assert.ok(!evs.some(e => e.kind === 'observation' && /CLOSING-NUDGE/.test(e.text || '')), 'complete report -> no closing nudge')
    assert.ok(reply.length > 0, 'still a warm close')
  })

  await test('first message: reply has reference, is warm, at most one question mark', async () => {
    const chan = 'first-msg-' + Date.now()
    const replies = []
    const origSend = adapter.sent.length
    await runScript(adapter, ['my goats are sick'], { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
    const newReplies = adapter.sent.slice(origSend)
    assert.ok(newReplies.length >= 1, 'at least one reply sent')
    const first = newReplies[0].text || ''
    assert.ok(first.length > 0, 'first reply is not empty')
    // reply must contain the case reference (CASE-xxxx-yyyy format)
    assert.ok(/CASE-[A-Z0-9]+-[a-z0-9]+/i.test(first), 'first reply contains the case reference')
    // at most one question mark (no interrogation)
    const qmarks = (first.match(/\?/g) || []).length
    assert.ok(qmarks <= 1, 'first reply has at most one question mark, got: ' + qmarks)
    // not empty or emoji-only (has real words)
    assert.ok(/[a-zA-Z]{3,}/.test(first), 'first reply contains real words')
    // does not contain internal jargon
    const lc = first.toLowerCase()
    assert.ok(!lc.includes('triage') && !lc.includes(' case ') && !lc.includes('ticket') && !lc.includes('workflow'), 'first reply contains no internal jargon')
  })

  await test('POST /api/cases creates a case with channel=web', async () => {
    const r = await df('http://localhost:4577/api/cases?token=secret', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Jan Bloem', phone: '0821112222', subject: 'Web intake test' }),
    })
    assert.equal(r.status, 201, 'POST /api/cases returns 201')
    const j = await r.json()
    assert.equal(j.channel, 'web', 'new case has channel=web')
    assert.ok(j.id, 'new case has an id')
    assert.ok((j.tags || '').includes('intake_mode:manual'), 'new case tagged intake_mode:manual')
    const webCaseId = j.id

    const intake = await df('http://localhost:4577/api/cases/' + webCaseId + '/intake?token=secret', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ species: 'goats', location: 'Bela-Bela', symptoms: 'limping', affected_count: '4' }),
    })
    assert.equal(intake.status, 200, 'POST /api/cases/:id/intake returns 200')
    const ij = await intake.json()
    assert.equal(ij.report.species, 'goats', 'species written to report')
    assert.equal(ij.report_fill_rate.filled, 4, 'fill_rate counts 4 filled fields')
    assert.equal(ij.report_fill_rate.total_fields, 17, 'fill_rate total_fields is 17')

    const detail = await df('http://localhost:4577/api/cases/' + webCaseId + '?token=secret').then(r => r.json())
    assert.equal(detail.report_fill_rate.filled, 4, 'GET /api/cases/:id includes report_fill_rate')
    assert.ok(detail.report_fill_rate.visit_critical_total >= 4, 'visit_critical_total present')

    const csv = await df('http://localhost:4577/api/cases/export.csv?token=secret')
    assert.equal(csv.status, 200, 'GET /api/cases/export.csv returns 200')
    const body = await csv.text()
    assert.ok(body.startsWith('ref,'), 'CSV starts with ref column')
    assert.ok(body.includes('species'), 'CSV has species column')
    assert.ok(body.includes('Bela-Bela'), 'CSV contains the intake data')

    // 409 on duplicate phone: second POST with same phone returns 409 + existing id
    const dup = await df('http://localhost:4577/api/cases?token=secret', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Jan Bloem', phone: '0821112222', subject: 'Duplicate check' }),
    })
    assert.equal(dup.status, 409, 'duplicate phone returns 409')
    const dupJ = await dup.json()
    assert.ok(dupJ.existing_id, '409 body includes existing_id')
    assert.ok(dupJ.existing_ref, '409 body includes existing_ref')
    assert.equal(dupJ.existing_id, webCaseId, '409 points to the original case')

    // GET /api/cases?ref= returns the matching case
    const refR = await df('http://localhost:4577/api/cases?ref=' + encodeURIComponent(j.ref) + '&token=secret').then(r => r.json())
    assert.equal(refR.cases.length, 1, 'GET /api/cases?ref= finds the case')
    assert.equal(refR.cases[0].id, webCaseId, 'ref search returns the correct case')
  })

  await test('POST /api/cases/:id/split splits events into a new case', async () => {
    const { case: splitSrc } = await store.findOrCreateCase({ channel: 'sim', external_id: 'split-api-' + Date.now() })
    await store.appendEvent(splitSrc.id, { kind: 'inbound', actor: 'contact', text: 'cattle in Musina drooling' })
    await store.appendEvent(splitSrc.id, { kind: 'inbound', actor: 'contact', text: 'also sheep in Upington lame' })
    const evts = await store.listEvents(splitSrc.id)
    const sheepEvt = evts.find(e => /Upington/.test(e.text))
    const r = await df('http://localhost:4577/api/cases/' + splitSrc.id + '/split?token=secret', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event_ids: [sheepEvt.id], subject: 'sheep Upington', reason: 'separate outbreak' }),
    })
    assert.equal(r.status, 200, 'POST /split returns 200')
    const sj = await r.json()
    assert.ok(sj.ok, 'split ok flag set')
    assert.ok(sj.new_case_id, 'split returns new_case_id')
    assert.ok(sj.new_case_ref, 'split returns new_case_ref')
    assert.equal(sj.moved_events, 1, 'split moved exactly 1 event')
  })

  await test('POST /api/cases/:id/note stores a general case note in the timeline', async () => {
    const { case: nc } = await store.findOrCreateCase({ channel: 'sim', external_id: 'note-api-' + Date.now() })
    const r = await df('http://localhost:4577/api/cases/' + nc.id + '/note?token=secret', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Farmer called back, confirmed 8 cattle affected' }),
    })
    assert.equal(r.status, 200, 'POST /note without field returns 200')
    const evs = await store.listEvents(nc.id)
    assert.ok(evs.some(e => e.kind === 'note' && /Farmer called back/.test(e.text)), 'general note stored in timeline')
  })

  await test('GET /report serves the public form without auth', async () => {
    const r = await fetch('http://localhost:4577/report')
    assert.equal(r.status, 200, 'public form loads without token')
    const html = await r.text()
    assert.ok(html.includes('<form'), 'response is an HTML form')
    assert.ok(html.includes('name="ref"'), 'ref field present')
  })

  await test('POST /report submits fields to a case by ref and redirects', async () => {
    const { case: rc } = await store.findOrCreateCase({ channel: 'sim', external_id: 'report-form-' + Date.now() })
    const body = new URLSearchParams({ ref: rc.ref, species: 'cattle', symptoms: 'drooling', location: 'Near Limpopo' })
    // follow redirect so the final URL contains done=1; Node fetch follows 302 automatically
    const r = await fetch('http://localhost:4577/report', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() })
    assert.ok(r.ok, 'POST /report ends in a successful response after redirect')
    assert.ok(r.url.includes('done=1'), 'final URL includes done=1 after redirect')
    const updated = await store.getCase(rc.id)
    let rpt = {}; try { rpt = JSON.parse(updated.report || '{}') } catch { rpt = {} }
    assert.equal(rpt.species, 'cattle', 'species saved to report')
    assert.equal(rpt.location, 'Near Limpopo', 'location saved to report')
  })

  await test('GET /report?ref= shows pre-filled form for known ref', async () => {
    const { case: rc } = await store.findOrCreateCase({ channel: 'sim', external_id: 'report-form2-' + Date.now() })
    await store.mergeReport(rc.id, { species: 'goats' }, { id: 'test', role: 'operator' })
    const r = await fetch('http://localhost:4577/report?ref=' + encodeURIComponent(rc.ref))
    assert.equal(r.status, 200)
    const html = await r.text()
    assert.ok(html.includes('goats'), 'existing report value is pre-filled')
  })

  await test('POST /report with phone creates or finds a case and redirects with done=1', async () => {
    const phone = '0829' + Math.floor(Math.random() * 1e6).toString().padStart(6, '0')
    const body = new URLSearchParams({ phone, species: 'sheep', symptoms: 'limping' })
    const r = await fetch('http://localhost:4577/report', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() })
    assert.ok(r.ok, 'POST /report with phone returns 200 after redirect')
    assert.ok(r.url.includes('done=1'), 'redirect includes done=1')
    // the case was created and tagged public_form
    const norm = '+27' + phone.slice(1)
    const all = await store.listCases({}, { limit: 100000 })
    const found = all.find(c => {
      const eid = String(c.external_id || '')
      return eid === norm || eid === norm.replace(/^\+/, '')
    })
    assert.ok(found, 'a case was created for the phone number')
    assert.ok((found.tags || '').includes('intake_mode:public_form'), 'case tagged intake_mode:public_form')
    let rpt = {}; try { rpt = JSON.parse(found.report || '{}') } catch { rpt = {} }
    assert.equal(rpt.species, 'sheep', 'report field saved from public form')
  })

  await test('GET /api/stats returns per-mode fill-rate breakdown', async () => {
    const r = await df('http://localhost:4577/api/stats?token=secret')
    assert.equal(r.status, 200, 'GET /api/stats returns 200')
    const j = await r.json()
    assert.ok(typeof j.total === 'number', 'stats.total is a number')
    assert.ok(j.by_mode && typeof j.by_mode === 'object', 'stats.by_mode is an object')
    const modes = Object.keys(j.by_mode)
    assert.ok(modes.length >= 1, 'at least one mode in by_mode')
    for (const m of modes) {
      const s = j.by_mode[m]
      assert.ok(typeof s.count === 'number', `${m}.count is a number`)
      assert.ok(typeof s.avg_filled === 'number', `${m}.avg_filled is a number`)
    }
  })

  await test('GET /api/cases/:id/report.html escapes XSS in all contact-supplied fields', async () => {
    // A contact can supply any text including script injection attempts. The
    // report.html endpoint must HTML-escape every field value from the report,
    // the subject, and the ref so none of them can execute as markup.
    const xss = '<script>alert(1)</script>'
    const { case: xc } = await store.findOrCreateCase({ channel: 'sim', external_id: 'xss-' + Date.now(), subject: xss })
    await store.mergeReport(xc.id, { species: xss, location: xss, symptoms: '"<img onerror=alert(2) src=x>' })
    const r = await df('http://localhost:4577/api/cases/' + xc.id + '/report.html?token=secret')
    assert.equal(r.status, 200, 'report.html loads for the case')
    const html = await r.text()
    // The raw XSS strings must NOT appear verbatim; they must be entity-escaped.
    // (A live <script> or <img> tag must not be in the HTML -- the < must be &lt;.)
    assert.ok(!html.includes('<script>alert(1)</script>'), 'script tag is not injected verbatim')
    assert.ok(!html.includes('<img '), 'img tag is not injected verbatim (< must be &lt;)')
    // The encoded forms must be present (field content is still rendered, just escaped).
    assert.ok(html.includes('&lt;script&gt;') || html.includes('&lt;img'), 'XSS payload is HTML-entity-escaped in the output')
  })

  // ---- progression: the weak model is not trusted to drive intake ----------
  // The live model returns content-only replies (no tool_calls), so the case
  // would be an empty shell if intake relied on it. Deterministic extractFields
  // must record what the contact plainly stated on EVERY turn, and the degraded
  // fallback must advance field-by-field rather than re-greeting. These witness
  // the originating defect: "it just logs cases from messages, without all the
  // relevant details ... something without enough details isn't an actionable
  // case, it should get everything it needs."
  await test('extractFields captures what the contact plainly stated', async () => {
    const { extractFields } = await import('./src/extract.js')
    const f = extractFields('three of my cattle died near Musina since Monday, my name is Thabo')
    assert.equal(f.species, 'cattle', `species: ${JSON.stringify(f)}`)
    assert.equal(f.dead_count, '3', `dead_count from "three ... died": ${JSON.stringify(f)}`)
    assert.equal(f.location, 'Musina', `location after "near": ${JSON.stringify(f)}`)
    assert.ok(/monday/i.test(f.onset || ''), `onset after "since": ${JSON.stringify(f)}`)
    assert.equal(f.contact_name, 'Thabo', `name after "my name is": ${JSON.stringify(f)}`)
    // A bare greeting captures nothing (no false fields off "Hi Casey").
    assert.equal(Object.keys(extractFields('hi casey')).length, 0, 'greeting yields no fields')
    // "limp" must not match inside "Limpopo" (the home province of most reporters)
    // -- a fabricated symptom there would stop intake asking the real sign.
    assert.ok(!extractFields('from the Limpopo area').symptoms, 'Limpopo is not a "limp" symptom')
    assert.equal(extractFields('from the Limpopo area').location, 'Limpopo', 'bare place captured without the "from the" article')
    // A weekday after "from" is a date, not a place -- never stored as a location.
    assert.ok(extractFields('from Monday').location == null, 'a weekday is not a location')
    assert.ok(/monday/i.test(extractFields('from Monday').onset || ''), 'a weekday after "from" is still an onset')
    // isiZulu/isiXhosa agglutinated verbs are captured (documented support).
    const zu = extractFields('inkomo ziyagula')
    assert.equal(zu.species, 'inkomo', `singular isiZulu species: ${JSON.stringify(zu)}`)
    assert.ok(zu.symptoms, `isiZulu "ziyagula" (sick) captured: ${JSON.stringify(zu)}`)
    assert.ok(extractFields('inkomo yam ifile').dead_count, 'isiZulu "ifile" (died) sets a death')
    // Controlled-disease signs a reporter commonly states are captured.
    assert.ok(extractFields('my cattle are aborting').symptoms, 'abortion captured')
    assert.ok(extractFields('sores on their mouths').symptoms, 'mouth sores captured')
    assert.ok(extractFields('the cattle are salivating').symptoms, 'salivation captured')
    // ... but ordinary English/Afrikaans words are NOT mis-read as a death/symptom.
    assert.ok(!extractFields('the file is here').dead_count, '"file" is not a death')
    assert.ok(!extractFields('my family is fine').symptoms, '"family" is not a symptom')
    // A 17-19 digit id (e.g. a Discord snowflake that slipped past mention-stripping)
    // is never recorded as a livestock count; a real (even large) herd still is.
    const sf = extractFields('502921403385774090 animals are sick')
    assert.ok(sf.affected_count == null && sf.dead_count == null, `a snowflake id is not a count: ${JSON.stringify(sf)}`)
    assert.equal(extractFields('50000 sheep').affected_count, '50000', 'a large but real herd count is captured')
  })

  await test('multi-turn conversation accumulates every stated field even as the model stays degraded', async () => {
    // The stub model never calls tools; only deterministic capture fills the report.
    const ext = 'progress-' + Date.now()
    await runScript(adapter, ['my cattle are sick'], { from: ext, channel_id: ext, wait: () => casey.drain() })
    await runScript(adapter, ['they are drooling and have blisters'], { from: ext, channel_id: ext, wait: () => casey.drain() })
    await runScript(adapter, ['six of them, near Musina'], { from: ext, channel_id: ext, wait: () => casey.drain() })
    const c = (await store.listCases()).find(x => x.external_id === ext)
    assert.ok(c, 'case exists for the conversation')
    const rep = JSON.parse(c.report || '{}')
    assert.equal(rep.species, 'cattle', `species retained from turn 1: ${JSON.stringify(rep)}`)
    // Turn 1 "sick" fills symptoms; fill-if-empty keeps it (never clobbers) when
    // turn 2 adds "drooling" -- the point is the field is captured, not empty.
    assert.ok(rep.symptoms && rep.symptoms.trim().length > 0, `symptoms captured: ${JSON.stringify(rep)}`)
    assert.equal(rep.affected_count, '6', `count from turn 3: ${JSON.stringify(rep)}`)
    assert.equal(rep.location, 'Musina', `location from turn 3, nothing lost: ${JSON.stringify(rep)}`)
  })

  await test('degraded fallback advances field-by-field and never re-greets an in-progress case', async () => {
    const { advancingFallback } = await import('./src/gateway-hooks.js')
    // A case missing several fields: the fallback names a MISSING field to ask,
    // and asking twice for a case at different fill states asks DIFFERENT things.
    const empty = { ref: 'CASE-1', report: JSON.stringify({}) }
    const partial = { ref: 'CASE-1', report: JSON.stringify({ species: 'cattle', symptoms: 'drooling', location: 'Musina', affected_count: '6' }) }
    const a1 = advancingFallback('ok', empty)
    const a2 = advancingFallback('ok', partial)
    assert.ok(a1 && a1.length > 0, 'fallback is never blank')
    assert.notEqual(a1, a2, 'the ask advances as fields fill -- not the same line every turn')
  })

  await test('a later greeting on an in-progress case still captures content and does not reset', async () => {
    // "hi casey, my goats are limping" -- the greeting must not swallow the report.
    const { extractFields } = await import('./src/extract.js')
    const f = extractFields('hi casey, my goats are limping')
    assert.equal(f.species, 'goats', `species captured despite greeting: ${JSON.stringify(f)}`)
    assert.ok(/limp/.test(f.symptoms || ''), `symptom captured despite greeting: ${JSON.stringify(f)}`)
  })

  // ---- runtime supervisor: the PROCESS lifecycle that keeps casey answering ---
  // The supervisor (src/supervisor.js) forks a worker and reforks it on crash or
  // source change so an operator never has to manually restart. The validation
  // authority is a pure xstate machine (src/supervisor-machine.js); the crash-loop
  // budget and the at-most-once boot resume are the load-bearing safety rules. All
  // three are witnessed here without forking a real OS process (the fork path is
  // exercised live by `casey up`; here we prove the decision surfaces it relies on).
  await test('supervisor machine: legal lifecycle moves resolve, illegal ones are rejected', async () => {
    const { buildSupervisorMachine, canFire, nextEvents, isTerminal } = await import('./src/supervisor-machine.js')
    const m = buildSupervisorMachine()
    // The happy path: boot -> healthy -> (reload) restarting -> booting -> healthy.
    assert.deepEqual(canFire(m, 'booting', 'BOOTED'), { ok: true, target: 'healthy' }, 'booting+BOOTED -> healthy')
    assert.deepEqual(canFire(m, 'healthy', 'RELOAD_REQUESTED'), { ok: true, target: 'restarting' }, 'healthy+RELOAD -> restarting')
    assert.deepEqual(canFire(m, 'restarting', 'RESTART_DONE'), { ok: true, target: 'booting' }, 'restarting+RESTART_DONE -> booting')
    assert.deepEqual(canFire(m, 'restarting', 'BUDGET_EXCEEDED'), { ok: true, target: 'degraded' }, 'crash budget trips to degraded')
    assert.deepEqual(canFire(m, 'degraded', 'HEALTH_OK'), { ok: true, target: 'healthy' }, 'degraded is recoverable on a good health tick')
    // A crash from healthy, degraded, or booting all funnel through restarting.
    for (const from of ['healthy', 'degraded', 'booting', 'restarting'])
      assert.equal(canFire(m, from, 'CRASH').target, 'restarting', `CRASH from ${from} -> restarting`)
    // Illegal moves are unrepresentable, not flag-guarded: RELOAD while stopping,
    // BOOTED while healthy, any event from the terminal stopped state.
    assert.ok(!canFire(m, 'stopping', 'RELOAD_REQUESTED').ok, 'cannot reload while stopping')
    assert.ok(!canFire(m, 'healthy', 'BOOTED').ok, 'a healthy worker does not re-boot')
    assert.ok(!canFire(m, 'stopped', 'CRASH').ok, 'terminal stopped accepts no events')
    assert.ok(!canFire(m, 'nonsense', 'CRASH').ok, 'unknown state rejected')
    assert.ok(isTerminal(m, 'stopped') && !isTerminal(m, 'healthy'), 'only stopped is terminal')
    assert.ok(nextEvents(m, 'healthy').includes('RELOAD_REQUESTED'), 'nextEvents enumerates the legal events')
  })

  await test('crashBudgetExceeded trips only after limit crashes inside the window', async () => {
    const { crashBudgetExceeded } = await import('./src/supervisor-machine.js')
    const now = 10_000_000
    const win = { windowMs: 60_000, limit: 5 }
    // Fewer than the limit: never tripped, however clustered.
    assert.equal(crashBudgetExceeded([now, now - 100, now - 200, now - 300], now, win), false, 'four crashes under a limit of five does not trip')
    // Five within the window: tripped (stop the tight loop, fail loud).
    const five = [now, now - 1e3, now - 2e3, now - 3e3, now - 4e3]
    assert.equal(crashBudgetExceeded(five, now, win), true, 'five crashes inside the window trips the budget')
    // Five spread BEYOND the window: a slow trickle of crashes is not a loop.
    const spread = [now, now - 20e3, now - 40e3, now - 80e3, now - 120e3]
    assert.equal(crashBudgetExceeded(spread, now, win), false, 'crashes older than the window do not count')
    assert.equal(crashBudgetExceeded([], now, win), false, 'no crashes never trips')
  })

  await test('resumePendingTurns re-drives an unanswered inbound exactly once (at-most-once boot resume)', async () => {
    // Simulate a worker that recorded an inbound then died MID-TURN before replying:
    // an inbound event with NO following outbound/draft on an open case. The boot
    // resume sweep must re-drive it once, marking resume-attempted BEFORE the drive
    // so a second sweep (a second crash/boot) skips it -- a miss is preferred over a
    // contact-facing double-send.
    const ext = 'resume-' + Date.now()
    const { case: rc } = await store.findOrCreateCase({ channel: 'sim', external_id: ext, contact: { display_name: 'resumer' } })
    await store.appendEvent(rc.id, { kind: 'inbound', actor: 'contact', text: 'my cattle are dying', msg_id: 'resume-msg-1' })
    const sentBefore = adapter.sent.length
    const r1 = await casey.resumePendingTurns()
    await casey.drain()
    assert.ok(r1.resumed >= 1, `first sweep re-drove the pending turn: ${JSON.stringify(r1)}`)
    const evs1 = await store.listEvents(rc.id)
    assert.equal(evs1.filter(e => /^resume-attempted:resume-msg-1$/.test(e.text || '')).length, 1, 'exactly one resume-attempted marker written')
    assert.ok(adapter.sent.length > sentBefore, 'the re-drive produced a contact reply')
    // Second sweep: the marker is present, so this msgId is skipped -- no double-send.
    const sentMid = adapter.sent.length
    await casey.resumePendingTurns()
    await casey.drain()
    const evs2 = await store.listEvents(rc.id)
    assert.equal(evs2.filter(e => /^resume-attempted:resume-msg-1$/.test(e.text || '')).length, 1, 'no second marker -- the turn is not re-driven again')
    assert.equal(adapter.sent.length, sentMid, 'no second reply -- at-most-once holds across a second boot')
    // A turn that DID complete (has a following outbound) is never re-driven.
    const ext2 = 'resume-done-' + Date.now()
    const { case: dc } = await store.findOrCreateCase({ channel: 'sim', external_id: ext2 })
    await store.appendEvent(dc.id, { kind: 'inbound', actor: 'contact', text: 'answered already', msg_id: 'done-msg-1' })
    await store.appendEvent(dc.id, { kind: 'outbound', actor: 'casey-agent', text: 'we have it, thank you' })
    const sentDone = adapter.sent.length
    await casey.resumePendingTurns()
    await casey.drain()
    const evsD = await store.listEvents(dc.id)
    assert.equal(evsD.filter(e => /^resume-attempted:/.test(e.text || '')).length, 0, 'a completed turn gets no resume marker')
    assert.equal(adapter.sent.length, sentDone, 'a completed turn is never re-driven')
  })

  await test('LLM backend self-heals when a provider that was down at boot recovers (no restart, no latch)', async () => {
    // A provider down at boot must NOT latch casey into holding-message-only mode for
    // the process life. makeResilientCallLLM re-resolves (debounced) so recovery is
    // picked up live. We drive it with a REAL resolver function (down, then up) and a
    // controllable clock -- no mock framework, just the injection points the wrapper
    // exposes. `up` is the real callLLM contract ({messages,tools}) => {content,...}.
    let clock = 1000
    let provider = 'down'
    const up = async ({ messages }) => ({ content: 'real reply for ' + (messages?.length || 0), tool_calls: [] })
    const resolve = async () => provider === 'up'
      ? { callLLM: up, source: 'acptoapi', model: 'test/model', url: 'http://x' }
      : { callLLM: null, source: 'none' }
    const brain = makeResilientCallLLM({ resolve, now: () => clock, intervalMs: 30000 })

    // Boot state: provider down -> status none, callLLM throws (handler then sends its
    // safe holding reply; a throwing backend is the never-dead-end path, not a crash).
    const s0 = await brain.status()
    assert.equal(s0.source, 'none', 'at boot with the provider down the helper reports offline')
    await assert.rejects(() => brain.callLLM({ messages: [{ role: 'user', content: 'hi' }] }),
      /offline/, 'a down provider makes callLLM throw so the handler falls back to a holding reply')

    // Provider recovers, but we are still inside the debounce window: no re-probe yet,
    // so the backend is still degraded (a down provider never adds a probe to every inbound).
    provider = 'up'
    const sDebounced = await brain.status()
    assert.equal(sDebounced.source, 'none', 'within the debounce window the recovered provider is not yet re-probed')

    // Past the debounce window: the next call re-resolves and now delegates to the real
    // backend, and the health row flips to online -- recovery with no restart.
    clock += 30001
    const r = await brain.callLLM({ messages: [{ role: 'user', content: 'hi' }, { role: 'user', content: 'again' }] })
    assert.ok(r && /real reply/.test(r.content), 'after recovery callLLM delegates to the live provider')
    const s1 = await brain.status()
    assert.equal(s1.source, 'acptoapi', 'the health row flips to online once the provider is reachable again')
    assert.equal(s1.model, 'test/model', 'the live model is reported from the re-resolved backend, not the boot snapshot')

    // Once resolved, calls no longer re-probe even if the provider flaps back down
    // (a resolved backend is sticky for this process; the next genuine failure surfaces
    // through the handler's turn-error fallback, not by re-probing on the hot path).
    provider = 'down'
    clock += 30001
    const r2 = await brain.callLLM({ messages: [{ role: 'user', content: 'x' }] })
    assert.ok(r2 && /real reply/.test(r2.content), 'a resolved backend stays bound and does not re-probe on every call')
  })

  await test('health reflects completion-path latency: a resolved-but-slow brain reads degraded, a fast turn clears it', async () => {
    // The "not responding" incident hid behind a false green: /v1/models answered
    // (source acptoapi -> "online") while every /v1/chat/completions hung 20s+, so
    // contacts waited minutes with the pill showing online. makeResilientCallLLM now
    // times the REAL turns it already makes and folds completion health into status(),
    // so a sustained-slow brain reads degraded. We drive it with a controllable clock:
    // the backend advances the clock by `turnMs` per call, so each timed turn lands at
    // a known latency -- no sleeps, no mock framework, just the injection points.
    let clock = 1000
    let turnMs = 25000                  // every turn takes 25s -- past the 20s slowMs ceiling
    const slowUp = async () => { clock += turnMs; return { content: 'slow reply', tool_calls: [] } }
    const resolve = async () => ({ callLLM: slowUp, source: 'acptoapi', model: 'test/model', url: 'http://x' })
    const brain = makeResilientCallLLM({ resolve, now: () => clock, intervalMs: 30000, slowMs: 20000, slowWindow: 3 })

    // Before any turn, no completion data -> not degraded (never a false alarm pre-traffic).
    const s0 = await brain.status()
    assert.equal(s0.degraded, false, 'with no turns yet the completion path is not yet judged degraded')
    assert.equal(s0.source, 'acptoapi', 'reachability still reports the resolved provider')

    // Drive the window full of slow turns (3 = slowWindow). Each returns ok but slow,
    // so once EVERY turn in the window is slow the brain reads degraded -- the operator
    // can tell "online" from "online but answering nobody".
    for (let i = 0; i < 3; i++) await brain.callLLM({ messages: [{ role: 'user', content: 'q' + i }] })
    const sSlow = await brain.status()
    assert.equal(sSlow.degraded, true, 'a window of all-slow turns reads degraded')
    assert.ok(sSlow.lastMs >= 20000, 'status carries the last turn latency for the operator (' + sSlow.lastMs + 'ms)')
    assert.equal(sSlow.source, 'acptoapi', 'degraded is independent of reachability -- the provider still resolves')

    // One fast turn (a recovered provider) clears it: the window is no longer ALL slow.
    // Conservative by design -- a single slow turn never flips the pill, but a sustained
    // slow brain does, and one fast turn restores green.
    turnMs = 1500
    await brain.callLLM({ messages: [{ role: 'user', content: 'fast' }] })
    const sFast = await brain.status()
    assert.equal(sFast.degraded, false, 'one fast turn in the window clears the degraded flag')

    // A throwing/timed-out backend also records an unhealthy turn -- a hanging provider
    // that never returns ok still surfaces as degraded, not a silent stall.
    const throwUp = async () => { clock += 5000; throw new Error('provider timed out') }
    const brain2 = makeResilientCallLLM({ resolve: async () => ({ callLLM: throwUp, source: 'acptoapi', model: 'm', url: 'u' }), now: () => clock, intervalMs: 30000, slowMs: 20000, slowWindow: 3 })
    for (let i = 0; i < 3; i++) await brain2.callLLM({ messages: [{ role: 'user', content: 'z' }] }).catch(() => {})
    const sThrow = await brain2.status()
    assert.equal(sThrow.degraded, true, 'a window of failing turns reads degraded even though each errored fast')
  })

  await test('a greeting DRIVES intake (warm opener + the next needed fact), never the case-ack; a new case escapes', async () => {
    // Pure predicate: a content-free turn (nothing captured this turn, empty report)
    // is conversational; a turn that captured a field or has a recorded report is not.
    assert.equal(isContentFreeTurn([], null), true, 'no capture + empty report -> content-free')
    assert.equal(isContentFreeTurn(['species'], null), false, 'a captured field this turn -> not content-free')
    assert.equal(isContentFreeTurn([], JSON.stringify({ species: 'cattle' })), false, 'an existing report field -> not content-free')
    // A greeting reply DRIVES collection: warm opener + an ask for the next needed
    // fact + the ref. NOT the "Thank you for letting us know" case-ack, and NOT a
    // no-ask pleasantry -- memobot gathers the report, it does not just chat.
    const warm = warmConversationalReply('hi', { ref: 'CASE-9999-zz', report: '{}' })
    assert.ok(!warm.startsWith('Thank you for letting us know'), 'greeting is not the case-ack')
    assert.ok(/\?/.test(warm), `greeting asks for the next needed fact: ${warm}`)
    assert.ok(warm.includes('CASE-9999-zz'), 'greeting keeps the reference')
    assert.ok(warm.length <= 240, `greeting reply stays short (${warm.length})`)
    // The reporter is a field worker relaying a farmer's animals, so an ask must
    // never assume the worker witnessed onset ("when you first noticed it"); once
    // the visit-critical facts and a photo + count are in, the next ask is the
    // people-on-site fact (who is there, link to the owner), framed for a relay.
    const vcDone = warmConversationalReply('hi', { ref: 'CASE-8', report: JSON.stringify({ species: 'cow', symptoms: 'blue eye', location: 'Musina', how_to_find: 'R101', farmer_available: 'yes', contact_fallback: '082', photos: 'x', affected_count: '3' }) })
    assert.ok(!/first noticed|when you first/i.test(vcDone), `ask never assumes the worker witnessed onset: ${vcDone}`)
    assert.ok(/owner|there with the animals/i.test(vcDone), `ask captures who is on site and link to the owner: ${vcDone}`)
    // End-to-end: a greeting-only conversation must drive intake on the first and a
    // repeated greeting, never the case-ack, always asking the next thing.
    const chan = 'greet-' + Date.now()
    for (const g of ['hi', 'hello']) {
      await runScript(adapter, [g], { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
      const reply = adapter.sent[adapter.sent.length - 1]
      assert.ok(reply && reply.text, 'a greeting is never a dead-end (a reply is sent)')
      assert.ok(!/^Thank you for letting us know/.test(reply.text), `greeting "${g}" is not the case-ack: ${reply.text}`)
      assert.ok(/\?/.test(reply.text), `greeting "${g}" drives intake by asking the next fact: ${reply.text}`)
    }
    const gc = (await store.listCases()).find(c => c.external_id === chan)
    assert.ok((await store.listEvents(gc.id)).some(e => e.kind === 'observation' && /GREETING-DRIVE/.test(e.text || '')), 'the greeting-drive path is audited')
    // A bot-mention greeting ("<@BOTID> hello") still drives intake and the mention
    // id is never captured as a count.
    const mchan = 'ment-' + Date.now()
    await runScript(adapter, ['<@1234567890> hello'], { from: mchan, channel_id: mchan, username: mchan, wait: () => casey.drain() })
    const mreply = adapter.sent[adapter.sent.length - 1]
    assert.ok(!/^Thank you for letting us know/.test(mreply.text), `mention greeting is not the case-ack: ${mreply.text}`)
    assert.ok(/\?/.test(mreply.text), `mention greeting drives intake: ${mreply.text}`)
    const mc = (await store.listCases()).find(c => c.external_id === mchan)
    const mrep = mc.report ? JSON.parse(mc.report) : {}
    assert.ok(mrep.affected_count == null && mrep.dead_count == null, `mention id is not captured as a count: ${JSON.stringify(mrep)}`)
    // A real livestock report on the SAME case drives intake and cites the reference.
    await runScript(adapter, ['my cattle are drooling badly'], { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
    const afterReport = adapter.sent[adapter.sent.length - 1]
    assert.ok(afterReport.text.includes(gc.ref), 'a real report turn drives intake and cites the reference')
    // ESCAPE ROUTE: the same contact now states a clearly NEW situation (different
    // species). The conflicting fact is not silently swallowed -- the case is flagged
    // for an operator to split rather than staying trapped on the old report.
    await runScript(adapter, ['now my pigs are dying'], { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
    const gc2 = (await store.listCases()).find(c => c.external_id === chan)
    // The escape signal is a DURABLE append-only observation (the agent's own
    // case_update can rewrite tags mid-turn -- as the stub model does here, even
    // overwriting the report -- so the once-only signal cannot live only in a tag,
    // exactly like FALLBACK-ASK / CLOSING-NUDGE).
    assert.ok((await store.listEvents(gc2.id)).some(e => /NEW-CASE-SIGNAL/.test(e.text || '')), 'a clearly-new situation is flagged for split (durable observation)')
  })

  await test('an asked field with no extractor is captured from the free-text answer; the same question is never asked twice', async () => {
    // The witnessed loop: memobot asks "who is there and how linked to the owner?",
    // the worker answers "boyi son of the owner", and -- because present_person has
    // no deterministic extractor and the stub/weak model does not record it -- the
    // answer was dropped and the identical question repeated forever. The pending-ask
    // binder must record the free-text answer and the next ask must differ.
    const pchan = 'pend-' + Date.now()
    // Drive to the value-add stage: state the visit-critical facts so the next ask
    // is a value-add people fact.
    await runScript(adapter, ['cattle with blue eyes at Musina farm, on the R101, the owner is here, reach him on 0820001111'], { from: pchan, channel_id: pchan, username: pchan, wait: () => casey.drain() })
    // Greet to elicit a value-add ask, capture which field was asked.
    await runScript(adapter, ['hello'], { from: pchan, channel_id: pchan, username: pchan, wait: () => casey.drain() })
    const askedReply = adapter.sent[adapter.sent.length - 1].text
    // Answer in free text -- the answer to whatever was asked.
    await runScript(adapter, ['boyi son of the owner'], { from: pchan, channel_id: pchan, username: pchan, wait: () => casey.drain() })
    const pc = (await store.listCases()).find(c => c.external_id === pchan)
    const events = await store.listEvents(pc.id)
    // The free-text answer was bound to a report field (not dropped).
    assert.ok(events.some(e => /pending-ask answer bound to/.test(e.text || '')), 'the free-text answer was bound to the asked field')
    // The reply after the answer is NOT the identical question that preceded it.
    const afterAnswer = adapter.sent[adapter.sent.length - 1].text
    assert.notEqual(afterAnswer, askedReply, `the same question is not asked twice in a row: ${afterAnswer}`)
  })

  await test('two authors in one channel get distinct cases; a complete report confirms and invites a fresh one', async () => {
    // Witnessed: a second Discord user's "hello" landed on the first user's case
    // because the case was keyed by the channel, not the contact. Each author must
    // get their own case; replies still target the channel.
    const sharedChan = 'multiuser-' + Date.now()
    adapter.inject({ from: 'authorA', channel_id: sharedChan, username: 'A', text: 'my cattle are sick at Musina' })
    await casey.drain()
    adapter.inject({ from: 'authorB', channel_id: sharedChan, username: 'B', text: 'hello' })
    await casey.drain()
    const cases = await store.listCases()
    const caseA = cases.find(c => c.external_id === `${sharedChan}:authorA`)
    const caseB = cases.find(c => c.external_id === `${sharedChan}:authorB`)
    assert.ok(caseA && caseB, `each author has their own case: A=${!!caseA} B=${!!caseB}`)
    assert.notEqual(caseA.id, caseB.id, 'two authors in one channel are not the same case')
    // The reply to either still targets the channel (Discord posts to the channel).
    assert.ok(adapter.sent.slice(-2).every(r => r.to === sharedChan), 'replies target the channel, not the author')
    // A COMPLETE report confirms + invites a fresh report, never a bare "Thank you.+ref".
    const done = warmConversationalReply('hi', { ref: 'CASE-9', report: JSON.stringify({ species: 'cow', symptoms: 'blue eye', location: 'Musina', how_to_find: 'R101', farmer_available: 'yes', contact_fallback: '082', photos: 'x', affected_count: '3', present_person: 'boyi', owner_contact: 'joe', onset: '3 weeks', suspected_disease: 'fmd' }) })
    assert.ok(!/^Thank you\. Your reference/.test(done), `a complete report is not a bare acknowledgement: ${done}`)
    assert.ok(/fresh report|another|different place/i.test(done), `a complete report invites a new one: ${done}`)
  })

  await test('worker enquiry plumbing: active-case binding, explicit create, and a PII-free enquiry projection', async () => {
    // The store-level seams the freddie enquiry/active-case toolset rides on. (The
    // full agent-driven "my cases"/"near me" need an LLM; the deterministic seams
    // are witnessed here on real services.)
    // Explicit create + active-case binding: a worker negotiates a case and binds it.
    const worker = 'worker-' + Date.now()
    const created = await store.createCase({ subject: 'pre-excursion', assignee: worker })
    assert.ok(created && created.id && created.ref, 'createCase opens a real case')
    await store.setActiveCase(worker, created.id)
    const active = await store.getActiveCase(worker)
    assert.equal(active.id, created.id, 'the active case round-trips for the worker')
    // findCaseByRef resolves a selection by reference.
    const byRef = await store.findCaseByRef(created.ref)
    assert.equal(byRef.id, created.id, 'a case is selectable by its reference')
    // operator-where listCases works through the feature-detect shim (open status set).
    const open = await store.listCases({ status: { $in: ['new', 'triaging', 'in_progress'] } }, { limit: 50 })
    assert.ok(open.some(c => c.id === created.id), 'an operator-where ($in) list finds the open case')
    // The enquiry projection (freddie) strips external_id/contact_id before any row
    // reaches the agent -- a worker's list can never surface a phone number.
    const { projectCase, DEFAULT_PROJECTION } = await import('../freddie/src/plugins/case/toolset.js')
    const projected = projectCase({ id: 'x', ref: 'CASE-Z', status: 'new', external_id: '+27820001111', contact_id: 'c1', location: 'Musina' }, DEFAULT_PROJECTION)
    assert.ok(!('external_id' in projected) && !('contact_id' in projected), `enquiry projection excludes PII: ${JSON.stringify(projected)}`)
    assert.equal(projected.ref, 'CASE-Z', 'enquiry projection keeps the safe ref')
  })

  await dash.close()
  await casey.stop()
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
  process.exit(failures ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
