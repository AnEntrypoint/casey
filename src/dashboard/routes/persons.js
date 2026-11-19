import { mountRoutes } from './register.js'
import { listPersons, casesOf, renamePerson, mergePersons, normName, cleanName } from '../../phone-persons.js'
import { parseReport } from '../../timestamp.js'
import { caseyText } from '../../deployment-text.js';

const SYSTEM = { id: 'casey-agent', role: 'agent' }
const isText = (v) => typeof v === 'string'

async function contactOr404(store, id, res) {
  const c = await store.getContact(String(id || '')).catch(() => null)
  if (!c || c.channel === 'system') { res.status(404).json({ error: caseyText("src/dashboard/routes/persons.js#w0") }); return null }
  return c
}

async function refMatches(store, contact, want, res) {
  if (want == null) return true
  const c = isText(want) ? await store.getCaseByRef(want.trim()).catch(() => null) : null
  if (!c || c.contact_id !== contact.id) {
    res.status(409).json({ error: caseyText("src/dashboard/routes/persons.js#w1") })
    return false
  }
  return true
}

async function syncReportedBy(store, cases, to, from) {
  let n = 0
  for (const ref of cases) {
    const c = await store.getCase(ref.id).catch(() => null)
    if (!c) continue
    const cur = parseReport(c).reported_by
    if (!cur || (from && normName(cur) !== normName(from))) continue
    if (cur === to) continue
    const r = await store.mergeReport(c.id, { reported_by: to }, SYSTEM, { bypassObserve: true, autoAssign: false, system: true }).catch(() => ({ error: 'x' }))
    if (!r.error) n++
  }
  return n
}

const publicPerson = (p, refs) => ({ id: p.id, name: p.name, relation: p.relation || '', first_seen: p.first_seen, last_seen: p.last_seen, reports: refs.map(r => r.ref).filter(Boolean) })

export function getPersons({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const contact = await contactOr404(store, req.params.id, res); if (!contact) return
    const people = await listPersons(store, contact.id)
    const out = []
    for (const p of people) out.push(publicPerson(p, await casesOf(store, contact.id, p.id)))
    res.json({ persons: out, count: out.length, shared: out.length > 1 })
  }
}

export function postPersonRename({ store, authed, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    try {
      const contact = await contactOr404(store, req.params.id, res); if (!contact) return
      const b = req.body || {}
      if (!isText(b.person_id) || !b.person_id) return res.status(400).json({ error: caseyText("src/dashboard/routes/persons.js#w2") })
      if (b.name == null && b.relation == null) return res.status(400).json({ error: caseyText("src/dashboard/routes/persons.js#w3") })
      if ((b.name != null && !isText(b.name)) || (b.relation != null && !isText(b.relation))) return res.status(400).json({ error: caseyText("src/dashboard/routes/persons.js#w4") })
      if (!(await refMatches(store, contact, b.expected_ref, res))) return
      const people = await listPersons(store, contact.id)
      const cur = people.find(p => p.id === b.person_id)
      if (!cur) return res.status(404).json({ error: caseyText("src/dashboard/routes/persons.js#w5") })
      if (b.expected_name != null && normName(b.expected_name) !== normName(cur.name)) {
        return res.status(409).json({ error: caseyText("src/dashboard/routes/persons.js#w6", [cur.name, cleanName(b.expected_name)]), current: { name: cur.name } })
      }
      const by = `staff:${actingOperator(req).id}`
      const r = await renamePerson(store, contact.id, cur.id, { name: b.name, relation: b.relation, by })
      if (!r.ok) return res.status(r.reason === 'name_taken' ? 409 : 400).json({ error: r.reason === 'name_taken' ? caseyText("src/dashboard/routes/persons.js#w7") : r.reason === 'no_name' ? caseyText("src/dashboard/routes/persons.js#w8") : caseyText("src/dashboard/routes/persons.js#w9") })
      const synced = r.person.name !== cur.name ? await syncReportedBy(store, await casesOf(store, contact.id, cur.id), r.person.name, cur.name) : 0
      res.json({ ok: true, person: publicPerson(r.person, await casesOf(store, contact.id, cur.id)), reports_updated: synced })
    } catch (e) { res.status(400).json({ error: e.message }) }
  }
}

export function postPersonMerge({ store, authed, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    try {
      const contact = await contactOr404(store, req.params.id, res); if (!contact) return
      const b = req.body || {}
      if (!isText(b.keep) || !b.keep || !Array.isArray(b.from) || !b.from.length || b.from.some(x => !isText(x))) return res.status(400).json({ error: caseyText("src/dashboard/routes/persons.js#w10") })
      if (!(await refMatches(store, contact, b.expected_ref, res))) return
      const people = await listPersons(store, contact.id)
      const keep = people.find(p => p.id === b.keep)
      if (!keep) return res.status(404).json({ error: caseyText("src/dashboard/routes/persons.js#w11") })
      const gone = b.from.map(id => people.find(p => p.id === id))
      if (gone.some(p => !p)) return res.status(404).json({ error: caseyText("src/dashboard/routes/persons.js#w12") })
      const moved = []
      for (const g of gone) for (const c of await casesOf(store, contact.id, g.id)) moved.push({ ...c, from: g.name })
      const r = await mergePersons(store, contact.id, keep.id, b.from, { by: `staff:${actingOperator(req).id}` })
      if (!r.ok) return res.status(400).json({ error: caseyText("src/dashboard/routes/persons.js#w13") })
      let synced = 0
      for (const m of moved) synced += await syncReportedBy(store, [m], keep.name, m.from)
      const after = (await listPersons(store, contact.id)).find(p => p.id === keep.id)
      res.json({ ok: true, person: publicPerson(after, await casesOf(store, contact.id, keep.id)), merged: r.merged, reports_updated: synced })
    } catch (e) { res.status(400).json({ error: e.message }) }
  }
}

export function postPersonErase({ store, authed, isAdmin, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    if (!isAdmin(req)) return res.status(403).json({ error: caseyText("src/dashboard/routes/persons.js#w14") })
    try {
      const contact = await contactOr404(store, req.params.id, res); if (!contact) return
      const b = req.body || {}
      if (!isText(b.person_id) || !b.person_id) return res.status(400).json({ error: caseyText("src/dashboard/routes/persons.js#w15") })
      if (!(await refMatches(store, contact, b.expected_ref, res))) return
      const people = await listPersons(store, contact.id)
      const cur = people.find(p => p.id === b.person_id)
      if (!cur) return res.status(404).json({ error: caseyText("src/dashboard/routes/persons.js#w16") })
      if (!isText(b.confirm_name) || normName(b.confirm_name) !== normName(cur.name)) return res.status(400).json({ error: caseyText("src/dashboard/routes/persons.js#w17") })
      const reason = isText(b.reason) ? b.reason.trim().slice(0, 300) : ''
      const out = await store.erasePerson(contact.id, cur.id, { reason, operator: { id: actingOperator(req).id } })
      if (!out.ok) return res.status(400).json({ error: caseyText("src/dashboard/routes/persons.js#w18") })
      res.json({ ok: true, complete: out.complete !== false, reports_scrubbed: out.casesScrubbed.length, reports_failed: out.casesFailed.length, people_left: (await listPersons(store, contact.id)).length })
    } catch (e) { res.status(400).json({ error: e.message }) }
  }
}

const ROUTES = [
  ['get', '/api/contacts/:id/persons', getPersons],
  ['post', '/api/contacts/:id/persons/rename', postPersonRename, { raw: true }],
  ['post', '/api/contacts/:id/persons/merge', postPersonMerge, { raw: true }],
  ['post', '/api/contacts/:id/persons/erase', postPersonErase, { raw: true }],
]

export function registerPersons(app, deps) {
  mountRoutes(app, deps, ROUTES)
}
