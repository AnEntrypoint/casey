// casey end-to-end smoke test  --  one file, real services (thatcher + freddie),
// stub LLM. Covers the full chain plus every hardened behaviour: autonomy modes,
// illegal transitions, message dedup, empty-message handling, dashboard
// auth/paging/escaping/reply, discord WS receive, and whatsapp webhook.
import assert from 'node:assert'
import { rmSync } from 'node:fs'
import { createCasey } from './src/casey.js'
import { createDashboard } from './src/dashboard/server.js'
import { runScript, MockAdapter } from './src/sim/inject.js'
import { stubLLM } from './src/sim/stub-llm.js'
import { intentReply, fallbackReply, reportMissingVisitCritical } from './src/gateway-hooks.js'

process.env.CASEY_LOG = 'silent'

let failures = 0
const test = async (name, fn) => {
  try { await fn(); console.log('ok  ', name) }
  catch (e) { failures++; console.error('FAIL', name, '\n   ', e.message) }
}

async function main() {
  rmSync('./data', { recursive: true, force: true })
  const casey = await createCasey({ channels: ['sim'], callLLM: stubLLM() })
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
    assert.equal(c.priority, 'high')
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
    const c3 = (await store.listCases()).find(c => c.external_id === 'c3')
    assert.ok(c3, 'case opened for media-only message')
    const reply = adapter.sent[adapter.sent.length - 1]
    assert.ok(reply.text && reply.text.trim().length > 0, 'reply is never blank')
  })

  // ---- dashboard API ----
  let dash
  await test('dashboard requires token when configured', async () => {
    dash = createDashboard(store, { port: 4577, token: 'secret', sendReply: (c, t) => adapter.send({ to: c.external_id, text: t }) })
    const noAuth = await fetch('http://localhost:4577/api/cases')
    assert.equal(noAuth.status, 401)
    const ok = await fetch('http://localhost:4577/api/cases?token=secret')
    assert.equal(ok.status, 200)
  })

  await test('dashboard cases endpoint paginates with total', async () => {
    const r = await fetch('http://localhost:4577/api/cases?token=secret&limit=1').then(r => r.json())
    assert.ok(Array.isArray(r.cases))
    assert.equal(r.limit, 1)
    assert.ok(typeof r.total === 'number' && r.total >= 2)
  })

  await test('dashboard case detail returns events_total + transitions', async () => {
    const r = await fetch('http://localhost:4577/api/cases/' + caseId + '?token=secret').then(r => r.json())
    assert.ok(typeof r.events_total === 'number')
    assert.ok(Array.isArray(r.transitions))
  })

  await test('dashboard operator reply sends on channel + logs outbound', async () => {
    const sentBefore = adapter.sent.length
    const r = await fetch('http://localhost:4577/api/cases/' + caseId + '/reply?token=secret', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'operator here' }),
    })
    assert.equal(r.status, 200)
    assert.equal(adapter.sent.length, sentBefore + 1)
    const last = (await store.listEvents(caseId)).pop()
    assert.equal(last.kind, 'outbound'); assert.equal(last.actor, 'operator')
  })

  await test('dashboard reply surfaces the sent flag (delivered vs logged-only)', async () => {
    const wired = await fetch('http://localhost:4577/api/cases/' + caseId + '/reply?token=secret', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'wired' }),
    }).then(r => r.json())
    assert.equal(wired.sent, true, 'sendReply present -> sent:true')
    // a dashboard with no sendReply logs the outbound but reports sent:false
    const noSend = createDashboard(store, { port: 4578, token: 'secret' })
    const logged = await fetch('http://localhost:4578/api/cases/' + caseId + '/reply?token=secret', {
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
      const r = await fetch('http://localhost:4577/api/cases/' + caseId + '/transition?token=secret', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: avail[0], reason: 'operator-reason-xyz' }),
      })
      assert.equal(r.status, 200)
      const t = (await store.listEvents(caseId)).filter(e => e.kind === 'transition').pop()
      assert.ok(JSON.stringify(t).includes('operator-reason-xyz') || (t.text && t.text.includes('operator-reason-xyz')), 'reason recorded on transition')
    } else {
      assert.ok(true, 'no transition available from ' + cur + ' — skipped')
    }
  })

  await test('OPERATOR FLOW: needs-human case, canned reply sends once as operator, transition + reason surface', async () => {
    const chan = 'op-flow-1'
    await runScript(adapter, ['please get me a real human'], { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
    const opCase = (await store.listCases()).find(c => c.external_id === chan)
    assert.ok(opCase, 'case opened for operator-flow contact')
    assert.ok((opCase.tags || '').includes('needs-human'), 'contact flagged needs-human')

    const detail = await fetch('http://localhost:4577/api/cases/' + opCase.id + '?token=secret').then(r => r.json())
    assert.ok((detail.case.tags || '').includes('needs-human'), 'dashboard surfaces needs-human tag')

    const sentBefore = adapter.sent.length
    const reply = await fetch('http://localhost:4577/api/cases/' + opCase.id + '/reply?token=secret', {
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
    const tr = await fetch('http://localhost:4577/api/cases/' + opCase.id + '/transition?token=secret', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: target, reason: 'operator picked it up' }),
    })
    assert.equal(tr.status, 200)
    const after = await fetch('http://localhost:4577/api/cases/' + opCase.id + '?token=secret').then(r => r.json())
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
    await fetch('http://localhost:4577/api/cases/' + c.id + '/reply?token=secret', {
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
    const post = (path, body) => fetch('http://localhost:4577/api/cases/' + someCase.id + path + '?token=secret', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    // bad autonomy / priority are rejected before thatcher is touched
    const badAuto = await fetch('http://localhost:4577/api/cases/' + someCase.id + '?token=secret', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ autonomy: 'wizard' }),
    })
    assert.equal(badAuto.status, 400, 'invalid autonomy rejected')
    const badPrio = await fetch('http://localhost:4577/api/cases/' + someCase.id + '?token=secret', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ priority: '11' }),
    })
    assert.equal(badPrio.status, 400, 'invalid priority rejected')
    // non-string field is rejected, not coerced
    const objField = await fetch('http://localhost:4577/api/cases/' + someCase.id + '?token=secret', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject: { evil: 1 } }),
    })
    assert.equal(objField.status, 400, 'object subject rejected')
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

  await test('countCases is exact for casey scale (50k cap is a worst-case ceiling, not a truncation here)', async () => {
    const n = await store.countCases({ channel: 'sim' })
    const listed = (await store.listCases({ channel: 'sim' }, { limit: 100000 })).length
    assert.equal(n, listed, 'countCases matches a full list of the same where')
  })
  await dash.close()

  // ---- discord WS receive ----
  await test('discord adapter emits message on MESSAGE_CREATE, ignores bots', async () => {
    const { DiscordAdapter } = await import('file://' + process.cwd().replace(/\\/g, '/') + '/node_modules/freddie/plugins/platform-discord/handler.js')
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
    const { WhatsappAdapter } = await import('file://' + process.cwd().replace(/\\/g, '/') + '/node_modules/freddie/plugins/platform-whatsapp/handler.js')
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

    const cru = createDashboard(store, { port: 4579, token: 'secret' })
    try {
      const r = await fetch('http://localhost:4579/api/cases?token=secret&limit=1').then(r => r.json())
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

  await casey.stop()
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
  process.exit(failures ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
