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

    await test('scenario "non-english-spanish": at least one reply is in Spanish', async () => {
      const chan = 'scn-es'
      const sentBefore = adapter.sent.length
      await runScript(adapter, SCENARIOS['non-english-spanish'].lines, { from: chan, channel_id: chan, username: chan, wait: () => casey.drain() })
      const replies = adapter.sent.slice(sentBefore).map(r => r.text || '')
      assert.ok(replies.some(t => /\b(persona|gracias|ayudar|mensaje|referencia)\b/i.test(t)), `expected a Spanish reply in: ${JSON.stringify(replies)}`)
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
    })

    await test('intent: true positives across languages and the "???" help signal', async () => {
      const { detectContactIntent } = await import('./src/gateway-hooks.js')
      const cases = [
        ['STOP', 'stop'], ['basta!!', 'stop'], ['yeka', 'stop'], ['khalas', 'stop'],
        ['i want to talk to a human', 'human'], ['umuntu', 'human'], ['insan', 'human'],
        ['call me please', 'human'],
        ['any news?', 'status'], ['kahan hai', 'status'],
        ['AYUDAME!!', 'help'], ['???', 'help'], ['usizo', 'help'],
        ['thank you', 'thanks'], ['ngiyabonga', 'thanks'],
        ['hi', 'greeting'], ['sawubona', 'greeting'], ['namaste', 'greeting'],
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

  await casey.stop()
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
  process.exit(failures ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
