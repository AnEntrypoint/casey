// team-roster.js -- the training roster: who the deployment plans to bring onto
// the system, per association/area, and whether each person has a smartphone.
//
// Some people on the roster will never get a WhatsApp registration (no
// smartphone), so this cannot live on the contact table: a contact row exists
// only for a number that can message the bot. The roster is therefore the same
// append-only, audited observation log role-invites.js uses -- one 'system'
// singleton case, one event per registration -- and current state is a replay of
// the log (the latest record for a person wins). No schema change in any config.
//
// The rollout table (`casey roles roster`, GET /api/roles/roster) is derived, not
// stored: total and smartphones come from the log; registered, first message and
// first case are read from contacts and cases, so they cannot drift from what the
// system actually holds.

import crypto from 'node:crypto'
import { taggedObservations } from './store/settings-log.js'
import { atLeast, resolveTierValue, TIER_FIELD_WORKER } from './contact-tiers.js'
import { normalizeMsisdn } from './role-invites.js'
import { parseReport } from './timestamp.js'

const KEY = 'team-roster'
const TAG = 'team-roster'
export const NO_AREA = '(no area given)'

// The roster key of a person: their number when they have one, else a hash of
// name + area (a person without a smartphone often has no number on file).
export function rosterKey({ phone = '', name = '', area = '' } = {}) {
  const p = normalizeMsisdn(phone)
  if (p) return p
  return 'n:' + crypto.createHash('sha1').update(`${String(name).trim().toLowerCase()}|${String(area).trim().toLowerCase()}`).digest('hex').slice(0, 12)
}

// The singleton's case id WITHOUT creating it: a read-only command must not
// write. Null when nothing was ever recorded.
export async function peekSingletonCaseId(store, key) {
  const [row] = await store.t.list('case', { channel: 'system', external_id: `settings:${key}` }, { limit: 1 })
  return row ? row.id : null
}

function replay(events) {
  const people = new Map()
  for (const { payload } of taggedObservations(events, TAG)) {
    let r
    try { r = JSON.parse(payload) } catch { continue }
    if (!r?.k) continue
    if (r.op === 'erase') { people.delete(r.k); continue }
    if (r.op === 'row') people.set(r.k, { key: r.k, name: r.name || '', phone: r.ph || '', tier: resolveTierValue(r.tier), area: r.area || '', smartphone: r.sp === true ? true : r.sp === false ? false : null, contact_id: r.cid || '', at: r.at, by: r.by || '' })
  }
  return people
}

export async function loadRoster(store) {
  const id = await peekSingletonCaseId(store, KEY)
  if (!id) return { caseId: null, people: new Map() }
  return { caseId: id, people: replay(await store.listEvents(id).catch(() => [])) }
}

// One audit event per registration. `person` = { name, phone, tier, area, smartphone, contactId }.
export async function recordRoster(store, person, { by = 'operator', note = 'registered', now = Date.now() } = {}) {
  const caseId = await store._systemSingletonCaseId(KEY, KEY)
  const k = rosterKey(person)
  const rec = {
    op: 'row', k, name: String(person.name || '').slice(0, 80), ph: normalizeMsisdn(person.phone) || '', tier: person.tier,
    area: String(person.area || '').slice(0, 80), sp: person.smartphone === true ? true : person.smartphone === false ? false : null,
    cid: person.contactId || '', at: now, by: String(by).slice(0, 80),
  }
  await store.appendEvent(caseId, { kind: 'observation', actor: 'operator', text: `${TAG}:${JSON.stringify(rec)}`, data: { op: 'row', by: rec.by, tier: rec.tier, note } })
  return k
}

// Remove one person from the roster (append a tombstone; the earlier rows of a
// person stay in the log until an erasure rewrites them).
export async function forgetRoster(store, phoneOrKey, by = 'operator') {
  const { caseId, people } = await loadRoster(store)
  const k = normalizeMsisdn(phoneOrKey) || String(phoneOrKey)
  if (!caseId || !people.has(k)) return false
  await store.appendEvent(caseId, { kind: 'observation', actor: 'operator', text: `${TAG}:${JSON.stringify({ op: 'erase', k, at: Date.now(), by })}`, data: { op: 'erase', by } })
  return true
}

// Erasure: blank the name, number and area of every roster row tied to these
// contact ids, in place. Returns the number of events rewritten.
export async function scrubRosterFor(store, contactIds, user) {
  const ids = new Set((contactIds || []).map(String))
  const caseId = await peekSingletonCaseId(store, KEY)
  if (!caseId || !ids.size) return 0
  const evs = await store.t.list('event', { case_id: caseId }, { limit: 100000 }).catch(() => [])
  let n = 0
  for (const e of evs) {
    if (typeof e.text !== 'string' || !e.text.startsWith(`${TAG}:`)) continue
    let r; try { r = JSON.parse(e.text.slice(TAG.length + 1)) } catch { continue }
    if (r?.op !== 'row' || !ids.has(String(r.cid))) continue
    r.name = '[erased]'; r.ph = ''; r.area = ''; r.cid = '[erased]'
    try { await store.t.update('event', e.id, { text: `${TAG}:${JSON.stringify(r)}` }, user); n++ } catch { /* counted by omission */ }
  }
  return n
}

// The rollout table: per association, how far each person has got. Everything
// after `smartphones` is read live from contacts and cases.
export async function rolloutTable(store) {
  const { people } = await loadRoster(store)
  const list = [...people.values()]
  const phones = new Set(list.map(p => p.phone).filter(Boolean))
  const contacts = new Map()
  if (phones.size) for (const c of await store.listContacts({ limit: 5000 })) if (c.channel === 'whatsapp' && phones.has(String(c.external_id))) contacts.set(String(c.external_id), c)
  const casesBy = new Map()
  if (contacts.size) {
    for (const c of await store.listCases({}, { limit: 10000, offset: 0 })) {
      if (c.channel !== 'whatsapp' || !contacts.has(String(c.external_id))) continue
      const a = casesBy.get(String(c.external_id)) || []
      a.push(c); casesBy.set(String(c.external_id), a)
    }
  }
  const status = new Map()
  for (const p of list) {
    const c = p.phone ? contacts.get(p.phone) : null
    const own = p.phone ? (casesBy.get(p.phone) || []) : []
    let messaged = false
    for (const cs of own) { if ((await store.listEvents(cs.id).catch(() => [])).some(e => e.kind === 'inbound')) { messaged = true; break } }
    status.set(p.key, {
      registered: !!c && atLeast(resolveTierValue(c.tier), TIER_FIELD_WORKER),
      first_message: messaged,
      first_case: own.some(cs => Object.values(parseReport(cs) || {}).some(v => v != null && String(v).trim() !== '')),
    })
  }
  const areas = new Map()
  for (const p of list) {
    const area = p.area || NO_AREA
    const row = areas.get(area) || { area, total: 0, smartphones: 0, no_smartphone: 0, registered: 0, first_message: 0, first_case: 0 }
    const s = status.get(p.key)
    row.total++
    if (p.smartphone === false) row.no_smartphone++; else row.smartphones++
    if (s.registered) row.registered++
    if (s.first_message) row.first_message++
    if (s.first_case) row.first_case++
    areas.set(area, row)
  }
  const rows = [...areas.values()].sort((a, b) => a.area.localeCompare(b.area))
  const sum = (f) => rows.reduce((n, r) => n + r[f], 0)
  return {
    areas: rows,
    totals: { total: sum('total'), smartphones: sum('smartphones'), no_smartphone: sum('no_smartphone'), registered: sum('registered'), first_message: sum('first_message'), first_case: sum('first_case') },
    people: list.map(p => ({ name: p.name, tier: p.tier, area: p.area || NO_AREA, smartphone: p.smartphone, phone_ending: p.phone ? p.phone.slice(-3) : '', ...status.get(p.key) })),
  }
}
