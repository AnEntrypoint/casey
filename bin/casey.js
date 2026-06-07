#!/usr/bin/env node
// casey CLI  --  up / sim / cases / dashboard
import { createCasey } from '../src/casey.js'
import { createCaseStore } from '../src/case-store.js'
import { createDashboard } from '../src/dashboard/server.js'

const [, , cmd, ...rest] = process.argv

function parseFlags(args) {
  const f = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const k = args[i].slice(2)
      const v = args[i + 1] && !args[i + 1].startsWith('--') ? args[(i++, i)] : true
      f[k] = v
    }
  }
  return f
}

async function main() {
  const flags = parseFlags(rest)

  if (cmd === 'up') {
    const channels = (flags.channels || 'sim,discord,whatsapp')
      .split(',').map(s => s.trim()).filter(Boolean)
      .filter(ch => ch === 'sim' || hasCreds(ch))
    // No callLLM here: freddie's runTurn resolves the real provider/model from
    // ~/.freddie config + provider keys. Set CASEY_STUB_LLM=1 to run offline.
    const callLLM = process.env.CASEY_STUB_LLM ? (await import('../src/sim/stub-llm.js')).stubLLM() : null
    const casey = await createCasey({ channels, callLLM })
    await casey.start()
    const dashPort = Number(flags.port || 4000)
    // Let the operator reply on the contact's channel from the dashboard.
    const sendReply = (caseRow, text) => {
      const a = casey.adapters[caseRow.channel]
      return a?.send ? a.send({ to: caseRow.external_id, text }) : Promise.resolve()
    }
    const dash = createDashboard(casey.store, { port: dashPort, sendReply })
    console.log(`casey up  --  channels: ${channels.join(', ')}`)
    console.log(`dashboard: http://localhost:${dash.port}${dash.port && process.env.CASEY_DASHBOARD_TOKEN ? ' (token required)' : ''}`)
    console.log('(ctrl-c to stop)')
    process.on('SIGINT', async () => { await dash.close(); await casey.stop(); process.exit(0) })
    return
  }

  if (cmd === 'dashboard') {
    const store = createCaseStore(); await store.init()
    const dash = createDashboard(store, { port: Number(flags.port || 4000) })
    console.log(`dashboard: http://localhost:${dash.port}  (ctrl-c to stop)`)
    process.on('SIGINT', async () => { await dash.close(); process.exit(0) })
    return
  }

  if (cmd === 'sim') {
    // Offline scripted conversation through the mock adapter.
    const { runScript } = await import('../src/sim/inject.js')
    const { stubLLM } = await import('../src/sim/stub-llm.js')
    const casey = await createCasey({ channels: ['sim'], callLLM: stubLLM() })
    await casey.start()
    const adapter = casey.adapters.sim
    const lines = rest.filter(a => !a.startsWith('--'))
    const script = lines.length ? lines : [
      'Hi, my order #55 still has not arrived',
      'It was supposed to come yesterday',
      'Thanks for looking into it',
    ]
    const transcript = await runScript(adapter, script, { wait: () => casey.drain() })
    for (const t of transcript) console.log(`${t.role === 'contact' ? 'USER: ' : 'BOT: '} ${t.text}`)
    const [c] = await casey.store.listCases()
    if (c) console.log(`\n${c.ref}  status=${c.status}  priority=${c.priority}  tags=${c.tags || '-'}\n   summary: ${c.summary || '(none)'}`)
    await casey.stop()
    process.exit(0)
  }

  if (cmd === 'cases') {
    const store = createCaseStore()
    await store.init()
    const cases = await store.listCases({}, flags.status ? { status: flags.status } : {})
    if (!cases.length) { console.log('no cases'); process.exit(0) }
    for (const c of cases) {
      console.log(`${c.ref}\t[${c.status}]\t${c.priority}\t${c.channel}\t${c.subject || ''}`)
    }
    process.exit(0)
  }

  if (cmd === 'show') {
    const store = createCaseStore(); await store.init()
    const id = rest[0]
    const c = await store.getCase(id) || (await store.listCases()).find(x => x.ref === id)
    if (!c) { console.log('case not found:', id); process.exit(1) }
    console.log(`${c.ref}  [${c.status}]  ${c.priority}  ${c.channel}/${c.external_id}`)
    console.log(`subject: ${c.subject}\nsummary: ${c.summary}\ntags: ${c.tags}`)
    console.log('--- timeline ---')
    for (const e of await store.listEvents(c.id)) console.log(`  ${e.kind}/${e.actor}: ${e.text}`)
    process.exit(0)
  }

  console.log(`casey  --  agentic case tracking

usage:
  casey up [--channels sim,discord,whatsapp] [--port 4000]   start gateway + dashboard
  casey dashboard [--port 4000]                 start only the observe/edit dashboard
  casey sim ["message" ...]                     run an offline simulated conversation
  casey cases [--status <stage>]                list cases
  casey show <ref|id>                           show a case + timeline

env (real channels):
  DISCORD_BOT_TOKEN                             enable discord
  WHATSAPP_API_TOKEN, WHATSAPP_PHONE_NUMBER_ID  enable whatsapp`)
  process.exit(cmd ? 1 : 0)
}

function hasCreds(ch) {
  if (ch === 'discord') return !!process.env.DISCORD_BOT_TOKEN
  if (ch === 'whatsapp') return !!(process.env.WHATSAPP_API_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID)
  return false
}

main().catch(e => { console.error(e); process.exit(1) })
