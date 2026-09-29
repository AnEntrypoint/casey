// phone-persons.js -- who is behind a phone. In rural areas one WhatsApp number is
// often shared by a family, neighbours or a herd boy who borrows it, so the phone
// number identifies a CHAT, not a person. This module keeps the people casey has
// learned about behind one contact, who is writing right now, and which reports each
// one gave.
//
// Storage is the same append-only, audited observation log role-invites.js and
// feedback.js use: one `phone-persons` system singleton case, one event per change,
// current state is a replay. No schema change in either config. A phone that never
// had a person recorded has no rows at all, and every reader below answers "nobody
// known" without creating the singleton, so a single-person phone behaves exactly as
// before.
//
// WHO DECIDES WHO IS SPEAKING: the model, through the case_speaker tool
// (case-tools-speaker.js), reading what people write in any language. Nothing in
// this file reads a message or matches a word. A name is stored as the person said
// it; casey never derives, translates or guesses one.
//
// PII: the log holds a name and a relation the person gave, opaque ids, and the
// contact id (an internal key, not the number). No phone digits are written here
// and no reader below returns any. Erasing a person (erasePerson) overwrites their
// name and relation in place, in every row that carries them.

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
// A speaker is kept alive by activity, but written down at most this often, so a busy chat is not one
// store write per message.
const TOUCH_EVERY_MS = 30 * 60e3

// The idle gap after which nobody is assumed to still be writing. Read on every call so a deployment
// can change it without a restart.
export function speakerGapMs() {
  const h = Number(process.env.CASEY_SPEAKER_GAP_HOURS)
  return (Number.isFinite(h) && h > 0 ? h : 8) * 3600e3
}

const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g
// A name or relation as the person said it: control and direction characters go, runs of digits (a
// number typed as a "name") are masked, whitespace is collapsed and the length is capped. Case, accents
// and spelling are left exactly as written.
export function cleanName(t, max = MAX_NAME) {
  return String(t == null ? '' : t).replace(CTRL, ' ').replace(/\+?\d[\d\s().-]{5,}\d/g, '[number]')
    .replace(/[<>{}]/g, '').replace(/\s+/g, ' ').trim().slice(0, max)
}
// Two spellings of the same name compare equal (case, accents and spacing only). It decides whether a
// name the model passes is a person we already have; it never invents a match between different names.
export const normName = (t) => cleanName(t).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
export const firstName = (t) => cleanName(t).split(/\s+/)[0] || ''

// Letters only, so an id can never read as a run of digits in a payload that must carry none.
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

// Replay one contact's rows (or every contact's when contactId is null) into
// { contacts: Map(contactId -> { persons: Map, current, lastActive, asked }) }.
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
      // a row whose name was overwritten by an erasure is an erased person, whichever erasure it was
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
  // A current speaker who is erased or merged away is nobody.
  for (const s of contacts.values()) {
    if (s.current) { const p = s.persons.get(s.current); if (!p || p.erased) s.current = null }
  }
  return contacts
}

// `ops` narrows the read to those operations (the Reporters list only needs to know who exists, not every
// `touch` a busy chat has written).
async function loadRows(store, contactId, ops = null) {
  const caseId = await peekSingletonCaseId(store, KEY)
  if (!caseId) return { caseId: null, rows: [] }
  // The data column carries the contact id, so one contact's rows are one filtered read, not a scan of everyone's.
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

// A person as any reader may see them: no number, no contact id, opaque id + what they said.
// Times leave as ISO strings: a payload with no phone number in it should also hold no bare run of digits.
const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '')
const shape = (p) => ({ id: p.id, name: p.name, relation: p.relation, first_seen: iso(p.first_seen), last_seen: iso(p.last_seen), reports: p.cases.length })
const activePeople = (s) => [...s.persons.values()].filter(p => !p.erased)

// Everyone known on this phone, oldest first. [] when nobody was ever recorded.
export async function listPersons(store, contactId) {
  if (!contactId) return []
  const { rows } = await loadRows(store, contactId)
  const s = replay(rows).get(contactId)
  return s ? activePeople(s).sort((a, b) => a.first_seen - b.first_seen).map(shape) : []
}

// How many people are known behind each contact, in one read (the Reporters panel). Map(contactId -> n).
export async function countPersonsByContact(store) {
  const { rows } = await loadRows(store, null, ['add', 'merge', 'erase'])
  const out = new Map()
  for (const [c, s] of replay(rows)) { const n = activePeople(s).length; if (n) out.set(c, n) }
  return out
}

// The cases each person gave, for the erase route and the case header: [{id, ref}].
export async function casesOf(store, contactId, personId) {
  const { rows } = await loadRows(store, contactId)
  const p = replay(rows).get(contactId)?.persons.get(personId)
  return p && !p.erased ? p.cases.slice() : []
}

// The state one turn reads. `current` is the person writing now (null when nobody is recorded, or the
// chat has been idle past the gap); `previous` is who was writing before the gap.
//   count          people known on this phone
//   awaiting       casey already asked who is writing and has not yet been told
//   needs_ask      two or more people are known, nobody is recorded as writing, and casey has not asked yet
//   open_report_by who gave the report `caseId` (when passed), else null
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

// Record that casey has been told to ask who is writing, so the question is asked once, not on every turn.
export async function noteAsked(store, contactId, { now = Date.now() } = {}) {
  return lock(store, contactId, () => append(store, contactId, { op: 'asked', at: now }))
}

// Add a person the model was told about, or return the one we already have under that name.
// { ok, person, created } | { ok:false, reason }
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

// Staff correction of a name or relation. { ok, person } | { ok:false, reason }
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

// Two records that turned out to be one person (the model heard "Sipho" and "Sipho M"). The kept person
// takes the others' reports; the others disappear as separate people.
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

// Say who is writing (personId) or that nobody is (null). The model calls this through case_speaker; staff
// never set it. `by` is 'model' or a staff label.
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

// A person gave this report. Idempotent per (person, case).
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

// Who gave this case: the person it is attached to, else null.
export async function reporterOfCase(store, contactId, caseId) {
  if (!contactId || !caseId) return null
  const { rows } = await loadRows(store, contactId)
  const s = replay(rows).get(contactId)
  if (!s) return null
  for (const p of activePeople(s)) if (p.cases.some(c => c.id === caseId)) return shape(p)
  return null
}

// Erase ONE person: their name and relation are overwritten in every row that holds them, their reports are
// unlinked, and a tombstone is appended. The phone contact and the other people are untouched.
// Returns { ok, rewritten, cases } where cases is what they had given (the caller scrubs those reports).
export async function erasePerson(store, contactId, personId, { by = 'system', now = Date.now() } = {}) {
  return lock(store, contactId, async () => {
    const { caseId, rows } = await loadRows(store, contactId)
    const s = replay(rows).get(contactId)
    const p = s?.persons.get(personId)
    if (!caseId || !p || p.erased) return { ok: false, reason: 'not_found' }
    const cases = p.cases.slice()
    // every id this person was ever known under (a merge folds others into them)
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
      try { await store.t.update('event', e.id, { text: `${TAG}:${JSON.stringify(rec)}` }, { id: 'casey-system', role: 'admin' }); rewritten++ } catch { /* counted by omission */ }
    }
    await append(store, contactId, { op: 'erase', p: personId, at: now }, by, 'erased')
    return { ok: true, rewritten, cases }
  })
}

// Erasing a whole contact takes every person behind it. Overwrites names and relations for these contact
// ids in place and returns the number of rows rewritten.
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
    try { await store.t.update('event', e.id, { text: `${TAG}:${JSON.stringify(r)}` }, user); n++ } catch { /* counted by omission */ }
  }
  return n
}

// What a screen needs to say who reported a case and how many people share the phone: names, never keys,
// never the number. null when nobody is recorded for this phone.
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

// Record who gave a report. Called when a report is opened (case_new, a new conversation) and after each
// case_report write, and does the same three things every time, all idempotent:
//   - the person is linked to the case in the persons log (their reference list),
//   - the report's `reported_by` field holds their name as they said it, only while it is still empty
//     (the first person to give a report keeps it; a second person on the same phone starts their own),
//   - one `speaker` event on the case carries the person's id, so the timeline says who was writing.
// Nothing happens when nobody is recorded as writing now, so a phone with no persons is untouched.
// Returns { stamped, person } or { stamped:false }.
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
    // bypassObserve: the name of the writer is bookkeeping a human driving the report has no reason to block.
    await store.mergeReport(caseId, { reported_by: person.name }, { id: 'casey-agent', role: 'agent' }, { bypassObserve: true, autoAssign: false, system: true }).catch(() => {})
  }
  const events = await store.t.list('event', { case_id: caseId, kind: 'observation', data: { $like: '%"speaker_person"%' } }, { limit: 500 }).catch(() => [])
  let last = null
  for (const e of byCreatedAscList(events)) { try { last = JSON.parse(e.data).speaker_person } catch { /* skip */ } }
  if (last !== person.id) {
    await store.appendEvent(caseId, { kind: 'observation', actor: 'system', text: 'SPEAKER: a person was recorded as the writer of this report', data: { speaker_person: person.id, speaker_shared_phone: st.count > 1 }, touch: false }).catch(() => {})
  }
  return { stamped: true, person }
}

// The audit fields a STOP or a HELP carries: who was recorded as writing when it arrived, and whether the phone
// is shared. STOP stays per PHONE (the bot can only answer the number), so this records who asked, it does not
// change what stops. Never throws: an audit field must not hold up an irreversible control.
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

// After a HELP switched an opted-out phone back on nobody knows which person wrote it. When two or more people
// share the phone, the recorded writer is cleared so the next reply asks who is writing (and the tool then
// attributes the re-enable to the person named). A phone with one person or none is left alone.
export async function forgetSpeakerAfterHelp(store, contactId) {
  try {
    const st = await speakerState(store, contactId)
    if (st.count >= 2 && st.current) await setSpeaker(store, contactId, null, { by: 'system' })
  } catch { /* an audit nicety never blocks the control */ }
}

// The first name of the person who gave this report, as they said it, or '' when nobody is recorded for it
// (a phone with no persons, or a report given before anyone was named). For greetings and the ranger's link.
export async function reporterFirstName(store, caseRow) {
  try {
    if (!caseRow?.contact_id) return ''
    const sum = await reporterSummary(store, caseRow.contact_id, caseRow.id)
    return sum?.reported_by ? firstName(sum.reported_by.name) : ''
  } catch { return '' }
}

// For a list of cases, who gave each and how many people share its phone, in ONE read of the log:
// Map(caseId -> { name, relation, people }). A case with nobody recorded is absent. Names only, no number.
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
