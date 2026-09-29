// The people behind a shared phone (src/phone-persons.js). In rural areas one WhatsApp number is often shared by a
// family, neighbours or someone borrowing the phone; the assistant records who is writing (case_speaker) and the
// dashboard lets staff correct what it recorded.
//
//   GET  /api/contacts/:id/persons           who is recorded behind this phone, by name, with their report references
//   POST /api/contacts/:id/persons/rename    { person_id, name?, relation?, expected_name?, expected_ref? }
//   POST /api/contacts/:id/persons/merge     { keep, from: [person_id], expected_ref? }     two records, one person
//   POST /api/contacts/:id/persons/erase     { person_id, confirm_name, reason? }           ADMIN: POPIA, one person
//
// STAFF ONLY, by omission: roles.js's roleGate lets a field login reach only the rows of its allowlist and a viewer only
// its own, and none of these is on either. Erasure additionally needs an admin, like the whole-contact erase.
//
// PAYLOADS ARE PII-SAFE. Names and relations as the person said them, opaque ids (letters only), report references and
// ISO dates; never the phone number and never a bare run of digits. The list is by NAME: the ids ride only as the
// values a screen sends back, the way `contacts.js` uses a contact id.
//
// EVERY WRITE IS GUARDED AND AUDITED. `expected_name` (rename) and `expected_ref` (any write, from a report's page) make a
// stale screen or a wrong click a 409 that changes nothing. Each write is one row in the persons log stamped
// `staff:<login>` (the same append-only audit the assistant's own writes go in), and a rename or merge keeps every
// affected report's "Reported by" in step.
//
// deps: store, authed, isAdmin, actingOperator
import { mountRoutes } from './register.js'
import { listPersons, casesOf, renamePerson, mergePersons, normName, cleanName } from '../../phone-persons.js'
import { parseReport } from '../../timestamp.js'

const SYSTEM = { id: 'casey-agent', role: 'agent' }
const isText = (v) => typeof v === 'string'

async function contactOr404(store, id, res) {
  const c = await store.getContact(String(id || '')).catch(() => null)
  if (!c || c.channel === 'system') { res.status(404).json({ error: 'not found' }); return null }
  return c
}

// expected_ref is the reference of the report the staff member is looking at. It must be a report of THIS phone.
async function refMatches(store, contact, want, res) {
  if (want == null) return true
  const c = isText(want) ? await store.getCaseByRef(want.trim()).catch(() => null) : null
  if (!c || c.contact_id !== contact.id) {
    res.status(409).json({ error: 'This screen is showing a different report from the phone being changed. Nothing was saved -- reload and open the right one.' })
    return false
  }
  return true
}

// The report's "Reported by" follows a rename or merge, on the reports that person gave.
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
      if (!isText(b.person_id) || !b.person_id) return res.status(400).json({ error: 'say which person' })
      if (b.name == null && b.relation == null) return res.status(400).json({ error: 'give a new name or a new relation' })
      if ((b.name != null && !isText(b.name)) || (b.relation != null && !isText(b.relation))) return res.status(400).json({ error: 'a name and a relation are text' })
      if (!(await refMatches(store, contact, b.expected_ref, res))) return
      const people = await listPersons(store, contact.id)
      const cur = people.find(p => p.id === b.person_id)
      if (!cur) return res.status(404).json({ error: 'that person is not recorded behind this phone' })
      if (b.expected_name != null && normName(b.expected_name) !== normName(cur.name)) {
        return res.status(409).json({ error: `This person is now recorded as "${cur.name}", not "${cleanName(b.expected_name)}". Nothing was saved -- reload and try again.`, current: { name: cur.name } })
      }
      const by = `staff:${actingOperator(req).id}`
      const r = await renamePerson(store, contact.id, cur.id, { name: b.name, relation: b.relation, by })
      if (!r.ok) return res.status(r.reason === 'name_taken' ? 409 : 400).json({ error: r.reason === 'name_taken' ? 'Someone else on this phone already has that name. Merge them instead if it is the same person.' : r.reason === 'no_name' ? 'that is not a name' : 'could not rename' })
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
      if (!isText(b.keep) || !b.keep || !Array.isArray(b.from) || !b.from.length || b.from.some(x => !isText(x))) return res.status(400).json({ error: 'say which person to keep and which to fold into them' })
      if (!(await refMatches(store, contact, b.expected_ref, res))) return
      const people = await listPersons(store, contact.id)
      const keep = people.find(p => p.id === b.keep)
      if (!keep) return res.status(404).json({ error: 'that person is not recorded behind this phone' })
      const gone = b.from.map(id => people.find(p => p.id === id))
      if (gone.some(p => !p)) return res.status(404).json({ error: 'that person is not recorded behind this phone' })
      // the reports of the people folded in, read before they stop existing as separate people
      const moved = []
      for (const g of gone) for (const c of await casesOf(store, contact.id, g.id)) moved.push({ ...c, from: g.name })
      const r = await mergePersons(store, contact.id, keep.id, b.from, { by: `staff:${actingOperator(req).id}` })
      if (!r.ok) return res.status(400).json({ error: 'could not merge those people' })
      let synced = 0
      for (const m of moved) synced += await syncReportedBy(store, [m], keep.name, m.from)
      const after = (await listPersons(store, contact.id)).find(p => p.id === keep.id)
      res.json({ ok: true, person: publicPerson(after, await casesOf(store, contact.id, keep.id)), merged: r.merged, reports_updated: synced })
    } catch (e) { res.status(400).json({ error: e.message }) }
  }
}

// Irreversible, admin only, and the person's name has to be typed back: a compliance action with no undo.
export function postPersonErase({ store, authed, isAdmin, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' })
    try {
      const contact = await contactOr404(store, req.params.id, res); if (!contact) return
      const b = req.body || {}
      if (!isText(b.person_id) || !b.person_id) return res.status(400).json({ error: 'say which person' })
      if (!(await refMatches(store, contact, b.expected_ref, res))) return
      const people = await listPersons(store, contact.id)
      const cur = people.find(p => p.id === b.person_id)
      if (!cur) return res.status(404).json({ error: 'that person is not recorded behind this phone' })
      if (!isText(b.confirm_name) || normName(b.confirm_name) !== normName(cur.name)) return res.status(400).json({ error: 'type the person\'s name to confirm erasing them' })
      const reason = isText(b.reason) ? b.reason.trim().slice(0, 300) : ''
      const out = await store.erasePerson(contact.id, cur.id, { reason, operator: { id: actingOperator(req).id } })
      if (!out.ok) return res.status(400).json({ error: 'could not erase that person' })
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
