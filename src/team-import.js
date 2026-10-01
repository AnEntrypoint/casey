

import { TIER_ORDER, TIER_REPORTER, TIER_FIELD_WORKER, TIER_ANIMAL_HEALTH_TECHNICIAN, TIER_OPERATOR, ADMIN_ONLY_TIERS, DEFAULT_TIER_LABELS, resolveTierValue, tierRank, tierLabel } from './contact-tiers.js'
import { normalizeMsisdn } from './role-invites.js'
import { TIER_LABELS } from './store/report-shape.js'
import { loadRoster, recordRoster, rosterKey } from './team-roster.js'

export const MAX_IMPORT_ROWS = 500
export const MAX_IMPORT_CHARS = 90000
const AREA_PREFIX = 'Association: '

const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

function roleTable() {
  const m = new Map()
  const add = (word, tier) => m.set(norm(word), tier)
  for (const t of TIER_ORDER) { add(t, t); add(tierLabel(t, TIER_LABELS), t); add(DEFAULT_TIER_LABELS[t], t) }
  for (const w of ['ranger', 'eco ranger', 'ecoranger', 'field worker', 'fieldworker', 'field']) add(w, TIER_FIELD_WORKER)
  for (const w of ['aht', 'a h t', 'technician', 'animal health tech', 'animal health']) add(w, TIER_ANIMAL_HEALTH_TECHNICIAN)
  for (const w of ['op', 'ops']) add(w, TIER_OPERATOR)
  return m
}

export function mapRole(word) {
  const w = norm(word)
  if (w === 'secretary') return { error: 'an operator dashboard login is not a WhatsApp role; create it under Accounts' }
  if (!w) return { error: 'no role given' }
  const tier = roleTable().get(w)
  if (!tier || tier === TIER_REPORTER) return { error: `"${clean(word, 40)}" is not a role this import knows (use ${tierLabel(TIER_FIELD_WORKER, TIER_LABELS)}, ${tierLabel(TIER_ANIMAL_HEALTH_TECHNICIAN, TIER_LABELS)} or ${tierLabel(TIER_OPERATOR, TIER_LABELS)})` }
  return { tier }
}

const YES = new Set(['yes', 'y', 'true', '1', 'smartphone', 'smart phone', 'has smartphone'])
const NO = new Set(['no', 'n', 'false', '0', 'none', 'feature phone', 'featurephone', 'basic phone', 'no smartphone'])
export function parseSmartphone(v) {
  const w = norm(v)
  if (!w) return null
  if (YES.has(w)) return true
  if (NO.has(w)) return false
  return undefined
}

const HEADERS = {
  name: ['name', 'full name', 'person', 'ranger', 'names'],
  phone: ['phone', 'cell', 'cellphone', 'cell phone', 'mobile', 'number', 'whatsapp', 'phone number', 'cell number', 'contact number', 'msisdn'],
  role: ['role', 'position', 'type', 'tier'],
  area: ['association', 'area', 'community', 'group', 'farm', 'region', 'ward'],
  smartphone: ['smartphone', 'smart phone', 'has smartphone', 'has a smartphone', 'smart'],
}
function headerKey(h) {
  const n = norm(h)
  for (const [k, list] of Object.entries(HEADERS)) if (list.includes(n)) return k
  return null
}

export function parseCsv(text) {
  const src = String(text || '').replace(/^\ufeff/, '')
  const first = src.split(/\r?\n/, 1)[0] || ''
  const delim = [',', ';', '\t'].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0]
  const rows = []
  let row = [], cell = '', q = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (q) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++ } else q = false } else cell += ch
    } else if (ch === '"' && cell === '') q = true
    else if (ch === delim) { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(c => c.trim() !== '')) rows.push(row); row = [] }
    else cell += ch
  }
  row.push(cell)
  if (row.some(c => c.trim() !== '')) rows.push(row)
  return rows
}

export function toRows({ csv, rows } = {}) {
  let out
  if (Array.isArray(rows)) {
    out = rows.map((r, i) => {
      const o = { line: i + 1 }
      for (const [k, v] of Object.entries(r && typeof r === 'object' ? r : {})) { const key = headerKey(k); if (key && o[key] === undefined) o[key] = v }
      return o
    })
  } else if (typeof csv === 'string') {
    if (csv.length > MAX_IMPORT_CHARS) throw new Error(`that file is too large (over ${MAX_IMPORT_CHARS} characters); split it into parts of at most ${MAX_IMPORT_ROWS} people`)
    const table = parseCsv(csv)
    if (table.length < 2) throw new Error('the file needs a header row and at least one person')
    const keys = table[0].map(headerKey)
    if (!keys.includes('name') || !keys.includes('role')) throw new Error('the first row must name the columns; at least "name" and "role" are needed (also phone, association, smartphone)')
    out = table.slice(1).map((cells, i) => {
      const o = { line: i + 2 }
      keys.forEach((k, j) => { if (k && o[k] === undefined) o[k] = cells[j] })
      return o
    })
  } else throw new Error('send a csv text or a rows list')
  if (out.length > MAX_IMPORT_ROWS) throw new Error(`too many people in one go (${out.length}); the limit is ${MAX_IMPORT_ROWS}`)
  if (!out.length) throw new Error('there are no people in that file')
  return out
}

const maskPhone = (msisdn) => (msisdn ? `...${msisdn.slice(-3)}` : '')
const smartLabel = (v) => (v === true ? 'yes' : v === false ? 'no' : 'unknown')
const withAreaNote = (notes, area) => {
  const lines = String(notes || '').split('\n').filter(l => !l.startsWith(AREA_PREFIX))
  if (area) lines.push(AREA_PREFIX + area)
  return lines.filter(l => l.trim() !== '').join('\n')
}
const areaOfNotes = (notes) => (String(notes || '').split('\n').find(l => l.startsWith(AREA_PREFIX)) || '').slice(AREA_PREFIX.length)

export async function planImport(store, input, { isAdmin = false } = {}) {
  const rows = toRows(input)
  const contacts = await store.listContacts({ limit: 5000 })
  const byPhone = new Map(contacts.filter(c => c.channel === 'whatsapp').map(c => [String(c.external_id), c]))
  const { people } = await loadRoster(store)
  const seen = new Set()
  const out = []
  for (const r of rows) {
    const name = clean(r.name, 80)
    const area = clean(r.area, 80)
    const sp = parseSmartphone(r.smartphone)
    const res = { line: r.line, name, phone: maskPhone(normalizeMsisdn(r.phone)), role: '', area, smartphone: smartLabel(sp === undefined ? null : sp), action: 'error', reason: '' }
    const fail = (reason) => { res.action = 'error'; res.reason = reason; out.push(res) }
    const skip = (reason) => { res.action = 'skip'; res.reason = reason; out.push(res) }
    if (!name) { fail('no name'); continue }
    if (sp === undefined) { fail(`"${clean(r.smartphone, 20)}" is not yes or no for smartphone`); continue }
    const role = mapRole(r.role)
    if (role.error) { fail(role.error); continue }
    const tier = role.tier
    res.role = tierLabel(tier, TIER_LABELS)
    if (ADMIN_ONLY_TIERS.includes(tier) && !isAdmin) { fail(`only an admin can make someone ${tierLabel(tier, TIER_LABELS)}`); continue }
    const rawPhone = String(r.phone == null ? '' : r.phone).trim()
    const msisdn = normalizeMsisdn(rawPhone)
    if (rawPhone && !msisdn) { fail('that is not a phone number we can use (a South African number is 27 plus nine digits)'); continue }
    const hasPhone = !!msisdn
    if (sp !== false && !hasPhone) { fail('no phone number, so they cannot be registered on WhatsApp'); continue }
    const key = rosterKey({ phone: msisdn, name, area })
    if (seen.has(key)) { skip('the same person appears earlier in the file'); continue }
    seen.add(key)
    const person = { name, phone: msisdn, tier, area, smartphone: sp }
    const onRoster = people.get(key)
    if (sp === false) {
      res.smartphone = 'no'
      const same = onRoster && onRoster.smartphone === false && onRoster.tier === tier && onRoster.area === area && onRoster.name === name
      if (same) { skip('already on the training roster with no smartphone'); continue }
      res.action = onRoster ? 'update' : 'create'
      res.reason = 'no smartphone: kept on the training roster, not registered on WhatsApp'
      out.push({ ...res, _do: { roster: person } })
      continue
    }
    const existing = byPhone.get(msisdn)
    const held = existing ? resolveTierValue(existing.tier) : null
    if (existing && tierRank(held) > tierRank(tier)) { skip(`already holds a higher role (${tierLabel(held, TIER_LABELS)}); not changed`); continue }
    const areaNow = existing ? areaOfNotes(existing.notes) : ''
    const unchanged = existing && held === tier && (areaNow === area || !area) && onRoster && onRoster.tier === tier && (onRoster.area === area || !area) && onRoster.smartphone === (sp === null ? onRoster.smartphone : sp)
    if (unchanged) { skip('already registered, nothing to change'); continue }
    if (!existing) { res.action = 'create'; res.reason = 'new registration' }
    else if (held !== tier) { res.action = 'update'; res.reason = `promoted from ${tierLabel(held, TIER_LABELS)}` }
    else { res.action = 'update'; res.reason = 'already registered; area or roster entry updated' }
    out.push({ ...res, _do: { register: existing ? held !== tier : true, existing, roster: { ...person, smartphone: sp === null ? true : sp } } })
  }
  return out
}

export const summarize = (results) => results.reduce((s, r) => { s[r.action] = (s[r.action] || 0) + 1; return s }, { create: 0, update: 0, skip: 0, error: 0 })

const publicRow = ({ _do, ...r }) => r

export async function runImport(store, input, { dryRun = true, isAdmin = false, by = 'operator' } = {}) {
  const run = async () => {
    const plan = await planImport(store, input, { isAdmin })
    if (dryRun) return { dry_run: true, summary: summarize(plan), results: plan.map(publicRow) }
    const user = { id: String(by).slice(0, 80), role: 'operator' }
    for (const r of plan) {
      if (!r._do) continue
      try {
        let contactId = r._do.existing?.id || ''
        const p = r._do.roster
        if (r._do.register) {
          const c = await store.registerContact({ channel: 'whatsapp', external_id: p.phone, display_name: p.name, tier: p.tier }, user)
          contactId = c.id
        }
        if (p.phone && p.smartphone !== false) {
          const cur = r._do.existing?.id ? await store.getContact(r._do.existing.id) : await store.findOrCreateContactLocked({ channel: 'whatsapp', external_id: p.phone, display_name: p.name })
          contactId = cur.id
          const notes = withAreaNote(cur.notes, p.area || areaOfNotes(cur.notes))
          if (notes !== String(cur.notes || '')) await store.t.update('contact', cur.id, { notes }, user)
        }
        await recordRoster(store, { ...p, contactId }, { by: user.id, note: r.action })
      } catch (e) {
        r.action = 'error'
        r.reason = 'could not be saved: ' + clean(e?.message, 120)
      }
    }
    return { dry_run: false, summary: summarize(plan), results: plan.map(publicRow) }
  }
  return dryRun ? run() : store._withLock('team-import', run)
}
