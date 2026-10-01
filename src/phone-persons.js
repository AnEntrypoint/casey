

import crypto from 'node:crypto'
import { peekSingletonCaseId } from './team-roster.js'
import { taggedObservations } from './store/settings-log.js'
import { byCreatedAscList } from './store/query.js'
import { REPORT_KEYS } from './store/report-shape.js'

const KEY = 'phone-persons'
const TAG = 'phone-person'
export const MAX_NAME = 60
export const MAX_RELATION = 40
export const MAX_PERSONS_PER_PHONE = Math.max(2, Number(process.env.CASEY_MAX_PERSONS_PER_PHONE) || 12)

const TOUCH_EVERY_MS = 30 * 60e3

export function speakerGapMs() {
  const h = Number(process.env.CASEY_SPEAKER_GAP_HOURS)
  return (Number.isFinite(h) && h > 0 ? h : 8) * 3600e3
}

const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g

export function cleanName(t, max = MAX_NAME) {
  return String(t == null ? '' : t).replace(CTRL, ' ').replace(/\+?\d[\d\s().-]{5,}\d/g, '[number]')
    .replace(/[<>{}]/g, '').replace(/\s+/g, ' ').trim().slice(0, max)
}

export const normName = (t) => cleanName(t).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
export const firstName = (t) => cleanName(t).split(/\s+/)[0] || ''

const ID_LETTERS = 'abcdefghjkmnpqrstuvwxyz'
const newId = () => 'pp_' + [...crypto.randomBytes(8)].map(b => ID_LETTERS[b % ID_LETTERS.length]).join('')

function parseRows(events, contactId) {
  const out = []
  for (const { event, payload } of taggedObservations(byCreatedAscList(events || []), TAG)) {
    let r
    try { r = JSON.parse(payload) } catch { continue }
    if (!r || !r.op) continue
    if (contactId && r.c !== contactId) continue
    out.push({ ...r, _event: event })
  }
  return out
}

function replay(rows) {
  const contacts = new Map()
  const of = (c) => {
    if (!contacts.has(c)) contacts.set(c, { persons: new Map(), alias: new Map(), current: null, currentAt: 0, lastActive: 0, asked: 0 })
    return contacts.get(c)
  }
  for (const r of rows) {
    const s = of(r.c)
    const resolve = (id) => { let x = id; for (let i = 0; i < 10 && s.alias.has(x); i++) x = s.alias.get(x); return x }
    const live = (id) => { const p = s.persons.get(resolve(id)); return p && !p.erased ? p : null }
    if (r.op === 'add') {
      if (s.persons.has(r.p)) continue

      s.persons.set(r.p, { id: r.p, name: r.n || '', relation: r.rel || '', first_seen: r.at, last_seen: r.at, cases: [], erased: r.n === '[erased]' })
    } else if (r.op === 'rename') {
      const p = live(r.p); if (!p) continue
      if (typeof r.n === 'string' && r.n) p.name = r.n
      if (typeof r.rel === 'string') p.relation = r.rel
    } else if (r.op === 'merge') {
      const keep = live(r.p); if (!keep) continue
      for (const from of r.from || []) {
        const f = s.persons.get(from)
        if (!f || f === keep || f.erased) continue
        for (const c of f.cases) if (!keep.cases.some(k => k.id === c.id)) keep.cases.push(c)
        keep.first_seen = Math.min(keep.first_seen, f.first_seen)
        keep.last_seen = Math.max(keep.last_seen, f.last_seen)
        s.persons.delete(from)
        s.alias.set(from, keep.id)
      }
    } else if (r.op === 'speaker') {
      const p = r.p ? live(r.p) : null
      s.current = p ? p.id : null
      s.currentAt = r.at
      s.lastActive = r.at
      if (p) p.last_seen = Math.max(p.last_seen, r.at)
    } else if (r.op === 'touch') {
      if (s.current && live(s.current)) { s.lastActive = Math.max(s.lastActive, r.at); live(s.current).last_seen = Math.max(live(s.current).last_seen, r.at) }
    } else if (r.op === 'asked') {
      s.asked = r.at
    } else if (r.op === 'case') {
      const p = live(r.p); if (!p) continue
      if (!p.cases.some(c => c.id === r.case)) p.cases.push({ id: r.case, ref: r.ref || '' })
      p.last_seen = Math.max(p.last_seen, r.at)
    } else if (r.op === 'erase') {
      const p = s.persons.get(resolve(r.p))
      if (p) { p.erased = true; p.name = ''; p.relation = ''; p.cases = [] }
    }
  }

  for (const s of contacts.values()) {
    if (s.current) { const p = s.persons.get(s.current); if (!p || p.erased) s.current = null }
  }
  return contacts
}

async function loadRows(store, contactId, ops = null) {
  const caseId = await peekSingletonCaseId(store, KEY)
  if (!caseId) return { caseId: null, rows: [] }

  const like = contactId ? { data: { $like: `%"contact":"${String(contactId).replace(/[%\\]/g, '')}"%` } } : {}
  const byOp = ops ? { $or: ops.map(op => ({ data: { $like: `%"op":"${op}"%` } })) } : {}
  const events = await store.t.list('event', { case_id: caseId, ...like, ...byOp }, { limit: 100000 }).catch(() => [])
  return { caseId, rows: parseRows(events, contactId || null) }
}

async function append(store, contactId, rec, by = 'system', note = '') {
  const caseId = await store._systemSingletonCaseId(KEY, KEY)
  const full = { ...rec, c: contactId, at: rec.at || Date.now(), by: String(by).slice(0, 80) }
  await store.appendEvent(caseId, {
    kind: 'observation', actor: String(by).startsWith('staff:') ? 'operator' : 'system',
    text: `${TAG}:${JSON.stringify(full)}`,
    data: { op: full.op, contact: contactId, person: full.op === 'erase' ? '[erased]' : (full.p || ''), note },
    touch: false,
  })
  return full
}

const lock = (store, contactId, fn) => store._withLock(`phone-persons|${contactId}`, fn)

const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '')
const shape = (p) => ({ id: p.id, name: p.name, relation: p.relation, first_seen: iso(p.first_seen), last_seen: iso(p.last_seen), reports: p.cases.length })
const activePeople = (s) => [...s.persons.values()].filter(p => !p.erased)

export async function listPersons(store, contactId) {
  if (!contactId) return []
  const { rows } = await loadRows(store, contactId)
  const s = replay(rows).get(contactId)
  return s ? activePeople(s).sort((a, b) => a.first_seen - b.first_seen).map(shape) : []
}

export async function countPersonsByContact(store) {
  const { rows } = await loadRows(store, null, ['add', 'merge', 'erase'])
  const out = new Map()
  for (const [c, s] of replay(rows)) { const n = activePeople(s).length; if (n) out.set(c, n) }
  return out
}

export async function casesOf(store, contactId, personId) {
  const { rows } = await loadRows(store, contactId)
  const p = replay(rows).get(contactId)?.persons.get(personId)
  return p && !p.erased ? p.cases.slice() : []
}

export async function speakerState(store, contactId, { now = Date.now(), touch = false, caseId = null } = {}) {
  const empty = { count: 0, people: [], current: null, previous: null, stale: false, awaiting: false, needs_ask: false, open_report_by: null }
  if (!contactId) return empty
  const { rows } = await loadRows(store, contactId)
  const s = replay(rows).get(contactId)
  if (!s) return empty
  const people = activePeople(s).sort((a, b) => a.first_seen - b.first_seen)
  let current = s.current ? s.persons.get(s.current) : null
  let previous = null, stale = false
  if (current && now - s.lastActive > speakerGapMs()) { previous = current; current = null; stale = true }
  const awaiting = !current && s.asked > 0 && s.asked >= s.currentAt && now - s.asked < speakerGapMs()
  const state = {
    count: people.length, people: people.map(shape),
    current: current ? shape(current) : null, previous: previous ? shape(previous) : null, stale,
    awaiting, needs_ask: people.length >= 2 && !current && !awaiting,
    open_report_by: caseId ? (people.filter(p => p.cases.some(c => c.id === caseId)).map(shape)[0] || null) : null,
  }
  if (touch && current && now - s.lastActive > TOUCH_EVERY_MS) {
    await lock(store, contactId, () => append(store, contactId, { op: 'touch', at: now })).catch(() => {})
  }
  return state
}

export async function noteAsked(store, contactId, { now = Date.now() } = {}) {
  return lock(store, contactId, () => append(store, contactId, { op: 'asked', at: now }))
}

export async function addPerson(store, contactId, { name = '', relation = '', by = 'model', now = Date.now() } = {}) {
  const n = cleanName(name)
  if (!n || n === '[number]' || !normName(n)) return { ok: false, reason: 'no_name' }
  const rel = cleanName(relation, MAX_RELATION)
  return lock(store, contactId, async () => {
    const { rows } = await loadRows(store, contactId)
    const s = replay(rows).get(contactId)
    const have = s ? activePeople(s) : []
    const same = have.find(p => normName(p.name) === normName(n))
    if (same) {
      if (rel && rel !== same.relation) await append(store, contactId, { op: 'rename', p: same.id, rel, at: now }, by)
      return { ok: true, person: shape({ ...same, relation: rel || same.relation }), created: false }
    }
    if (have.length >= MAX_PERSONS_PER_PHONE) return { ok: false, reason: 'too_many' }
    const p = newId()
    await append(store, contactId, { op: 'add', p, n, rel, at: now }, by)
    return { ok: true, person: { id: p, name: n, relation: rel, first_seen: iso(now), last_seen: iso(now), reports: 0 }, created: true }
  })
}

export async function renamePerson(store, contactId, personId, { name, relation, by = 'system', now = Date.now() } = {}) {
  const n = name == null ? null : cleanName(name)
  if (name != null && (!n || n === '[number]')) return { ok: false, reason: 'no_name' }
  return lock(store, contactId, async () => {
    const { rows } = await loadRows(store, contactId)
    const s = replay(rows).get(contactId)
    const p = s?.persons.get(personId)
    if (!p || p.erased) return { ok: false, reason: 'not_found' }
    if (n && activePeople(s).some(o => o.id !== p.id && normName(o.name) === normName(n))) return { ok: false, reason: 'name_taken' }
    await append(store, contactId, { op: 'rename', p: personId, ...(n ? { n } : {}), ...(relation != null ? { rel: cleanName(relation, MAX_RELATION) } : {}), at: now }, by)
    return { ok: true, person: shape({ ...p, name: n || p.name, relation: relation != null ? cleanName(relation, MAX_RELATION) : p.relation }) }
  })
}

export async function mergePersons(store, contactId, keepId, fromIds, { by = 'system', now = Date.now() } = {}) {
  const from = [...new Set((fromIds || []).map(String).filter(id => id && id !== keepId))]
  if (!from.length) return { ok: false, reason: 'nothing_to_merge' }
  return lock(store, contactId, async () => {
    const { rows } = await loadRows(store, contactId)
    const s = replay(rows).get(contactId)
    const keep = s?.persons.get(keepId)
    if (!keep || keep.erased) return { ok: false, reason: 'not_found' }
    const bad = from.filter(id => { const f = s.persons.get(id); return !f || f.erased })
    if (bad.length) return { ok: false, reason: 'not_found' }
    await append(store, contactId, { op: 'merge', p: keepId, from, at: now }, by)
    return { ok: true, kept: keepId, merged: from.length }
  })
}

export async function setSpeaker(store, contactId, personId, { by = 'model', now = Date.now() } = {}) {
  return lock(store, contactId, async () => {
    if (personId) {
      const { rows } = await loadRows(store, contactId)
      const p = replay(rows).get(contactId)?.persons.get(personId)
      if (!p || p.erased) return { ok: false, reason: 'not_found' }
    }
    await append(store, contactId, { op: 'speaker', p: personId || null, at: now }, by)
    return { ok: true }
  })
}

export async function attachCase(store, contactId, personId, { caseId, ref = '', now = Date.now() } = {}) {
  if (!contactId || !personId || !caseId) return { ok: false }
  return lock(store, contactId, async () => {
    const { rows } = await loadRows(store, contactId)
    const s = replay(rows).get(contactId)
    const p = s?.persons.get(personId)
    if (!p || p.erased) return { ok: false, reason: 'not_found' }
    if (p.cases.some(c => c.id === caseId)) return { ok: true, already: true }
    await append(store, contactId, { op: 'case', p: personId, case: caseId, ref: String(ref).slice(0, 40), at: now }, 'system')
    return { ok: true }
  })
}

export async function reporterOfCase(store, contactId, caseId) {
  if (!contactId || !caseId) return null
  const { rows } = await loadRows(store, contactId)
  const s = replay(rows).get(contactId)
  if (!s) return null
  for (const p of activePeople(s)) if (p.cases.some(c => c.id === caseId)) return shape(p)
  return null
}

export async function erasePerson(store, contactId, personId, { by = 'system', now = Date.now() } = {}) {
  return lock(store, contactId, async () => {
    const { caseId, rows } = await loadRows(store, contactId)
    const s = replay(rows).get(contactId)
    const p = s?.persons.get(personId)
    if (!caseId || !p || p.erased) return { ok: false, reason: 'not_found' }
    const cases = p.cases.slice()

    const ids = new Set([personId])
    for (const r of rows) if (r.op === 'merge' && r.p === personId) for (const f of r.from || []) ids.add(f)
    let rewritten = 0
    for (const r of rows) {
      const mine = ids.has(r.p) || (r.op === 'merge' && (r.from || []).some(f => ids.has(f)))
      if (!mine) continue
      const e = r._event
      let rec; try { rec = JSON.parse(String(e.text).slice(TAG.length + 1)) } catch { continue }
      if (rec.op === 'add' || rec.op === 'rename') { rec.n = rec.n ? '[erased]' : rec.n; if (rec.rel) rec.rel = '' }
      if (rec.op === 'case') { rec.ref = ''; rec.case = '[erased]' }
      try { await store.t.update('event', e.id, { text: `${TAG}:${JSON.stringify(rec)}` }, { id: 'casey-system', role: 'admin' }); rewritten++ } catch {  }
    }
    await append(store, contactId, { op: 'erase', p: personId, at: now }, by, 'erased')
    return { ok: true, rewritten, cases }
  })
}

export async function scrubPersonsFor(store, contactIds, user) {
  const ids = new Set((contactIds || []).map(String).filter(Boolean))
  const caseId = await peekSingletonCaseId(store, KEY)
  if (!caseId || !ids.size) return 0
  const evs = await store.t.list('event', { case_id: caseId }, { limit: 100000 }).catch(() => [])
  let n = 0
  for (const e of evs) {
    if (typeof e.text !== 'string' || !e.text.startsWith(`${TAG}:`)) continue
    let r; try { r = JSON.parse(e.text.slice(TAG.length + 1)) } catch { continue }
    if (!ids.has(String(r.c))) continue
    let changed = false
    if (r.n && r.n !== '[erased]') { r.n = '[erased]'; changed = true }
    if (r.rel) { r.rel = ''; changed = true }
    if (r.op === 'case' && r.case !== '[erased]') { r.case = '[erased]'; r.ref = ''; changed = true }
    if (!changed) continue
    try { await store.t.update('event', e.id, { text: `${TAG}:${JSON.stringify(r)}` }, user); n++ } catch {  }
  }
  return n
}

export async function reporterSummary(store, contactId, caseId) {
  if (!contactId) return null
  const { rows } = await loadRows(store, contactId)
  const s = replay(rows).get(contactId)
  if (!s) return null
  const people = activePeople(s)
  if (!people.length) return null
  const by = caseId ? people.find(p => p.cases.some(c => c.id === caseId)) : null
  return { people: people.length, reported_by: by ? { id: by.id, name: by.name, relation: by.relation } : null }
}

export async function stampReporter(store, contactId, caseId, { now = Date.now() } = {}) {
  if (!contactId || !caseId) return { stamped: false }
  const st = await speakerState(store, contactId, { now })
  if (!st.current) return { stamped: false }
  const c = await store.getCase(caseId)
  if (!c || c.channel === 'system') return { stamped: false }
  const person = st.current
  await attachCase(store, contactId, person.id, { caseId, ref: c.ref, now })
  let report = {}
  try { report = c.report ? JSON.parse(c.report) : {} } catch { report = {} }
  if (REPORT_KEYS.has('reported_by') && !report.reported_by) {

    await store.mergeReport(caseId, { reported_by: person.name }, { id: 'casey-agent', role: 'agent' }, { bypassObserve: true, autoAssign: false, system: true }).catch(() => {})
  }
  const events = await store.t.list('event', { case_id: caseId, kind: 'observation', data: { $like: '%"speaker_person"%' } }, { limit: 500 }).catch(() => [])
  let last = null
  for (const e of byCreatedAscList(events)) { try { last = JSON.parse(e.data).speaker_person } catch {  } }
  if (last !== person.id) {
    await store.appendEvent(caseId, { kind: 'observation', actor: 'system', text: 'SPEAKER: a person was recorded as the writer of this report', data: { speaker_person: person.id, speaker_shared_phone: st.count > 1 }, touch: false }).catch(() => {})
  }
  return { stamped: true, person }
}

export async function controlActor(store, contactId, { now = Date.now() } = {}) {
  try {
    const st = await speakerState(store, contactId, { now })
    return {
      ...(st.current ? { person_id: st.current.id } : {}),
      ...(!st.current && st.previous ? { last_known_person: st.previous.id } : {}),
      ...(st.count > 1 ? { shared_phone_people: st.count } : {}),
    }
  } catch { return {} }
}

export async function forgetSpeakerAfterHelp(store, contactId) {
  try {
    const st = await speakerState(store, contactId)
    if (st.count >= 2 && st.current) await setSpeaker(store, contactId, null, { by: 'system' })
  } catch {  }
}

export async function reporterFirstName(store, caseRow) {
  try {
    if (!caseRow?.contact_id) return ''
    const sum = await reporterSummary(store, caseRow.contact_id, caseRow.id)
    return sum?.reported_by ? firstName(sum.reported_by.name) : ''
  } catch { return '' }
}

export async function reportersForCases(store, caseRows) {
  const out = new Map()
  const rows = (caseRows || []).filter(c => c && c.contact_id)
  if (!rows.length) return out
  const { rows: log } = await loadRows(store, null)
  if (!log.length) return out
  const all = replay(log)
  for (const c of rows) {
    const s = all.get(c.contact_id)
    if (!s) continue
    const people = activePeople(s)
    if (!people.length) continue
    const by = people.find(p => p.cases.some(k => k.id === c.id))
    out.set(c.id, { name: by ? by.name : '', relation: by ? by.relation : '', people: people.length })
  }
  return out
}
