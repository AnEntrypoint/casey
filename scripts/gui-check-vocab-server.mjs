

import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [port, workdir, configDir, callsFile] = process.argv.slice(2)
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
const PW = process.env.GUI_PW
process.chdir(workdir)
process.env.CASEY_CONFIG_DIR = configDir
process.env.CASEY_COOKIE_SECURE = '0'
process.env.CASEY_LLM_MODEL = process.env.CASEY_LLM_MODEL || 'openrouter/deepseek/deepseek-v4.1-flash'

const { createCaseStore } = await import(path.join(SRC, 'case-store.js'))
const { createAccount } = await import(path.join(SRC, 'dashboard/auth.js'))
const { createDashboard } = await import(path.join(SRC, 'dashboard/server.js'))
const store = createCaseStore({})
await store.init()

const mk = (u, role, name, extra = {}) => createAccount(store, { username: u, password: PW, displayName: name, role, mustChangePassword: false, ...extra })
await mk('vadm', 'admin', 'Vocab Admin')
await mk('vrng', 'eco_ranger', 'Vocab Ranger', { contactPhone: '082 111 2222' })
await mk('vrng2', 'eco_ranger', 'Vocab Ranger Two')
await mk('vaht', 'animal_health_technician', 'Vocab Technician', { contactPhone: '083 333 4444' })
await mk('vvw', 'viewer', 'Vocab Viewer')
await store.registerContact({ channel: 'whatsapp', external_id: '27821112222', display_name: 'Vocab Ranger', tier: 'field_worker' })
await store.registerContact({ channel: 'whatsapp', external_id: '27833334444', display_name: 'Vocab Technician', tier: 'animal_health_technician' })

const XH = 'Iinkomo zam ziyakhohlela kakhulu kwaye azityi.'
const seed = {}
const mkcase = async (ext, subject, report, assignee, tags) => {
  const { case: c } = await store.findOrCreateCase({ channel: 'whatsapp', external_id: ext, contact: { name: 'Farmer Zola ' + ext.slice(-3), phone: ext }, subject })
  if (report) await store.mergeReport(c.id, report, { id: 'seed', role: 'agent' })
  const patch = { ...(assignee ? { assignee } : {}), ...(tags ? { tags } : {}) }
  if (Object.keys(patch).length) await store.updateCase(c.id, patch, { id: 'casey-system', role: 'admin' })
  return await store.getCase(c.id)
}
const ev = (c, kind, actor, text, data) => store.appendEvent(c.id, { kind, actor, channel: 'whatsapp', text, data: data || null })

const full = { species: 'cattle', symptoms: 'coughing', location: 'Musina' }
const t1 = await mkcase('27800200001', 'Vocab one', { ...full, identifying_traits: 'brown cow, ear tag 12', herd_total: '40', present_person: 'Sipho the herder', language_detected: 'isiXhosa' }, 'vrng')
const e1 = await ev(t1, 'inbound', 'contact', XH)
const e1out = await ev(t1, 'outbound', 'agent', 'Thank you. I have recorded that.')
const e1note = await ev(t1, 'note', 'operator', 'Operator note about this report.')
const e1long = await ev(t1, 'inbound', 'contact', 'x'.repeat(2500))
seed.t1 = { id: t1.id, ref: t1.ref, inbound: e1.id, outbound: e1out.id, note: e1note.id, long: e1long.id }

const t2 = await mkcase('27800200002', 'Vocab stop', { ...full, language_detected: 'isiZulu' }, 'vrng', 'opted-out')
const e2 = await ev(t2, 'inbound', 'contact', 'Ngiyacela ungisize, izinkomo zami ziyagula.')
seed.t2 = { id: t2.id, ref: t2.ref, inbound: e2.id }

const t3 = await mkcase('27800200003', 'Vocab other ranger', full, 'vrng2')
const e3 = await ev(t3, 'inbound', 'contact', 'Imbuzi zam ziyafa.')
seed.t3 = { id: t3.id, ref: t3.ref, inbound: e3.id }

const t4 = await mkcase('27800200004', 'Vocab one-off inbounds', full, 'vadm')
seed.t4 = { id: t4.id, ref: t4.ref, inbound: [] }
for (let i = 0; i < 12; i++) seed.t4.inbound.push((await ev(t4, 'inbound', 'contact', 'Molo ' + i)).id)

const t5 = await mkcase('27800200005', 'Vocab technician', { ...full, identifying_traits: 'grey goat' }, 'vaht')
seed.t5 = { id: t5.id, ref: t5.ref, inbound: (await ev(t5, 'inbound', 'contact', 'Inkomo yam iyagula.')).id }

const t6 = await mkcase('27800200006', 'Vocab sign-off desk', full, '')
seed.t6 = { id: t6.id, ref: t6.ref, inbound: (await ev(t6, 'inbound', 'contact', 'Izimvu zami zife.')).id }

const callLLM = async (req) => {
  appendFileSync(callsFile, JSON.stringify({ model: req.model, messages: req.messages, max_tokens: req.max_tokens }) + '\n')
  const text = String(req.messages[1].content).replace(/^<<MESSAGE>>/, '').replace(/<<END>>$/, '')
  return { content: JSON.stringify({ language: text === XH ? 'isiXhosa' : 'isiZulu', english: '[stub] ' + text.slice(0, 60) }) }
}
await createDashboard(store, { port: Number(port), callLLM })
console.log('SEED ' + JSON.stringify(seed))
setInterval(() => {}, 1 << 30)
