// areas.js  --  which eco ranger covers which area, and what follows from it.
//
// The team's rule: rangers are loaded with the AREA they cover (an association or
// village, e.g. "Upper Lambasi"); a case reported in that area is allocated to
// that ranger automatically and the ranger becomes its triage owner. Operators
// (secretaries) are not regional: they see everything, override any allocation,
// and are the only ones who can catch a case filed under the wrong area.
//
// STORAGE. An append-only, audited log on a 'system' singleton case (the same
// pattern as role-invites.js and the thresholds/fleet-health settings): no schema
// change, a full history of who mapped what, current state a replay of the log.
//   {op:'set',    id, name, primary, backups[], aliases[], at, by}
//   {op:'remove', id, at, by}
// `primary` and each backup are ASSIGNEE KEYS, exactly the strings case.assignee
// holds: `contact:<id>` for a ranger who works over WhatsApp, or a dashboard
// username for one who works in the GUI.
//
// RESOLUTION IS NOT TEXT CLASSIFICATION. The model records the report's
// `association` field (report-fields.yml area_field) from what the person said, or
// an operator sets it; resolveArea then does EQUALITY only: the normalised value
// against each area name and alias. With no association recorded it falls back to
// the location text, split on the person's own delimiters (comma, semicolon, slash,
// line break, spaced dash) and each whole piece compared for equality. It never
// looks for an alias inside a longer sentence, never fuzzy-matches, and has no
// gazetteer: an area is known because an operator listed it and its spellings.
//
// AUTO-ASSIGN (autoAssignByArea) runs after a report write that touched the area
// field or the location, only for an OPEN, UNASSIGNED case, only ONCE per case (any
// later release/reassignment by a person is an override that stays), to the first of
// primary then backups who is still a valid ranger. It writes case.assignee and an
// 'action' event carrying assigned_contact_id, which is exactly what
// staff-notices.js reads as "newly assigned".

import { taggedObservations } from './store/settings-log.js'
import { normalizeLocation } from './location-normalize.js'
import { parseReport } from './timestamp.js'
import { isOpenCase } from './format.js'
import { evData } from './safe.js'
import { TIER_FIELD_WORKER, TIER_ANIMAL_HEALTH_TECHNICIAN, resolveTierValue } from './contact-tiers.js'
import { assigneeKeyFor, isContactAssignee, contactIdOfAssignee, isOwnConversation } from './case-assignment.js'
import { staffLabel, releaseCase } from './hooks/staff-outbound.js'
import { clearFocusForCase } from './team-focus.js'
import { AREA_FIELD } from './store/report-shape.js'

const KEY = 'areas'
const TAG = 'area-map'
const UNCLAIMED = 'agent'
const SYSTEM_ACTOR = { id: 'casey-system', role: 'admin' }
export const MAX_AREAS = 300
export const MAX_ALIASES = 40
const MAX_BACKUPS = 6

// ---------- normalisation and matching (equality only) ----------

export const norm = (s) => normalizeLocation(s).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()

// The person's own delimiters, nothing smarter: comma, semicolon, slash, pipe,
// line break, and a dash with spaces round it.
const SEGMENT_SPLIT = /[,;\/|\n\r]+|\s[-\u2013\u2014]\s/

export function locationPieces(text) {
  const whole = norm(text)
  if (!whole) return []
  const out = [whole]
  for (const p of String(text).split(SEGMENT_SPLIT)) {
    const n = norm(p)
    if (n && !out.includes(n)) out.push(n)
  }
  return out
}

const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

function indexAreas(areas) {
  const idx = new Map()
  for (const a of areas) {
    for (const spelling of [a.name, ...(a.aliases || [])]) {
      const n = norm(spelling)
      if (n && !idx.has(n)) idx.set(n, a)
    }
  }
  return idx
}

// {area, matched_by:'association'|'location', matched} or null.
export function resolveArea(areas, { association = '', location = '' } = {}) {
  const idx = indexAreas(areas)
  const a = norm(association)
  if (a && idx.has(a)) return { area: idx.get(a), matched_by: 'association', matched: a }
  // A stated association that names no area is NOT second-guessed from the
  // location: the model or operator said which place it is, and the unmapped list
  // is where that gap gets surfaced for an operator to map or correct.
  if (a) return null
  for (const piece of locationPieces(location)) {
    if (idx.has(piece)) return { area: idx.get(piece), matched_by: 'location', matched: piece }
  }
  return null
}

// Location text only, ignoring any stated association (for the wrong-area check).
export function resolveAreaFromLocation(areas, location) {
  return resolveArea(areas, { association: '', location })
}

export const statedArea = (report) => (AREA_FIELD && report?.[AREA_FIELD] != null ? String(report[AREA_FIELD]).trim() : '')

// ---------- the log ----------

function replay(events) {
  const areas = new Map()
  for (const { payload } of taggedObservations(events, TAG)) {
    let r
    try { r = JSON.parse(payload) } catch { continue }
    if (!r?.id) continue
    if (r.op === 'set') areas.set(r.id, { id: r.id, name: r.name, primary: r.primary, backups: r.backups || [], aliases: r.aliases || [], updated_at: r.at, updated_by: r.by || '' })
    else if (r.op === 'remove') areas.delete(r.id)
  }
  return [...areas.values()]
}

// Reads never create the singleton: an unused deployment gains no system row from
// the mere question "is there an area for this?".
async function existingCaseId(store) {
  const c = await store.findOpenCase({ channel: 'system', external_id: `settings:${KEY}` }).catch(() => null)
  return c?.id || null
}

export async function loadAreas(store) {
  const id = await existingCaseId(store)
  if (!id) return []
  const events = await store.listEvents(id).catch(() => [])
  return replay(events).sort((a, b) => a.name.localeCompare(b.name))
}

async function append(store, rec, note) {
  const caseId = await store._systemSingletonCaseId(KEY, KEY)
  await store.appendEvent(caseId, { kind: 'observation', actor: 'operator', text: `${TAG}:${JSON.stringify(rec)}`, data: { op: rec.op, id: rec.id, note } })
}

// ---------- rangers ----------

// Is this assignee key someone who can hold a triage record right now? A WhatsApp
// ranger (contact key) must be a field worker or technician; a login must be an
// eco_ranger or technician account. Returns {ok, name, contact?} or {ok:false, why}.
export async function checkRanger(store, key) {
  const k = String(key || '').trim()
  if (!k || k === UNCLAIMED) return { ok: false, why: 'no ranger given' }
  if (isContactAssignee(k)) {
    const contact = await store.getContact(contactIdOfAssignee(k)).catch(() => null)
    if (!contact || contact.channel === 'system') return { ok: false, why: 'that team member is not registered' }
    const t = resolveTierValue(contact.tier)
    if (t !== TIER_FIELD_WORKER && t !== TIER_ANIMAL_HEALTH_TECHNICIAN) return { ok: false, why: 'that person does not hold a ranger or technician role' }
    return { ok: true, name: staffLabel(contact), contact }
  }
  const [acct] = await store.t.list('operator_account', { username: k }, { limit: 1 }).catch(() => [])
  if (!acct || acct.status === 'deleted' || acct.disabled === 1 || acct.disabled === '1' || acct.disabled === true) return { ok: false, why: 'no login by that name' }
  if (acct.role !== 'eco_ranger' && acct.role !== 'animal_health_technician') return { ok: false, why: 'that login is not an eco ranger or technician' }
  return { ok: true, name: acct.display_name || acct.username, contact: null }
}

async function rangerName(store, key) {
  if (isContactAssignee(key)) {
    const c = await store.getContact(contactIdOfAssignee(key)).catch(() => null)
    return c ? staffLabel(c) : 'a team member'
  }
  const [acct] = await store.t.list('operator_account', { username: String(key) }, { limit: 1 }).catch(() => [])
  return String(acct?.display_name || '').trim() || key
}

async function normaliseInput(store, areas, input, existing) {
  const name = String(input.name ?? existing?.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 80)
  if (!name) throw new Error('an area needs a name')
  const primary = String(input.primary ?? existing?.primary ?? '').trim()
  const p = await checkRanger(store, primary)
  if (!p.ok) throw new Error(`the first ranger: ${p.why}`)
  const backups = [...new Set((input.backups ?? existing?.backups ?? []).map(b => String(b).trim()).filter(Boolean))].filter(b => b !== primary)
  if (backups.length > MAX_BACKUPS) throw new Error(`at most ${MAX_BACKUPS} backup rangers`)
  for (const b of backups) { const r = await checkRanger(store, b); if (!r.ok) throw new Error(`backup ranger ${await rangerName(store, b)}: ${r.why}`) }
  const aliases = [...new Set((input.aliases ?? existing?.aliases ?? []).map(a => String(a).trim().replace(/\s+/g, ' ').slice(0, 80)).filter(Boolean))]
  if (aliases.length > MAX_ALIASES) throw new Error(`at most ${MAX_ALIASES} other names for one area`)
  // Two areas must never claim the same spelling, or resolution would depend on order.
  const mine = new Set([name, ...aliases].map(norm))
  for (const other of areas) {
    if (existing && other.id === existing.id) continue
    const clash = [other.name, ...other.aliases].find(s => mine.has(norm(s)))
    if (clash) throw new Error(`"${clash}" already belongs to the area ${other.name}`)
  }
  return { name, primary, backups, aliases }
}

const findArea = (areas, ref) => {
  const r = String(ref || '').trim()
  if (!r) return null
  return areas.find(a => a.id === r) || areas.find(a => norm(a.name) === norm(r)) || indexAreas(areas).get(norm(r)) || null
}
export { findArea }

// ---------- add / update / remove ----------

export async function addArea(store, input, by = 'operator') {
  return store._withLock(`${KEY}|log`, async () => {
    const areas = await loadAreas(store)
    if (areas.length >= MAX_AREAS) throw new Error(`there are already ${MAX_AREAS} areas`)
    const v = await normaliseInput(store, areas, input, null)
    const id = slug(v.name)
    if (!id) throw new Error('that name has no usable letters')
    if (areas.some(a => a.id === id)) throw new Error(`the area ${v.name} already exists; update it instead`)
    await append(store, { op: 'set', id, ...v, at: Date.now(), by: String(by).slice(0, 80) }, `area added: ${v.name}`)
    return (await loadAreas(store)).find(a => a.id === id)
  })
}

export async function updateArea(store, ref, patch, by = 'operator') {
  return store._withLock(`${KEY}|log`, async () => {
    const areas = await loadAreas(store)
    const cur = findArea(areas, ref)
    if (!cur) throw new Error('no such area')
    const v = await normaliseInput(store, areas, patch, cur)
    await append(store, { op: 'set', id: cur.id, ...v, at: Date.now(), by: String(by).slice(0, 80) }, `area updated: ${v.name}`)
    return (await loadAreas(store)).find(a => a.id === cur.id)
  })
}

// Add or update by name/id in one call (the PUT route's shape).
export async function upsertArea(store, input, by = 'operator') {
  const areas = await loadAreas(store)
  const cur = findArea(areas, input.id || input.name)
  return cur ? updateArea(store, cur.id, input, by) : addArea(store, input, by)
}

export async function removeArea(store, ref, by = 'operator') {
  return store._withLock(`${KEY}|log`, async () => {
    const areas = await loadAreas(store)
    const cur = findArea(areas, ref)
    if (!cur) throw new Error('no such area')
    await append(store, { op: 'remove', id: cur.id, at: Date.now(), by: String(by).slice(0, 80) }, `area removed: ${cur.name}`)
    return true
  })
}

// The areas a ranger covers (as primary or backup), for my-day and the wrong-area check.
export function areasOfRanger(areas, keys) {
  const want = new Set((Array.isArray(keys) ? keys : [keys]).filter(Boolean))
  return areas.filter(a => want.has(a.primary) || a.backups.some(b => want.has(b)))
}

// ---------- auto-assign ----------

// First of primary, backups that is still a valid ranger and not the case's own
// reporter. Returns {key, name, contact, tried:[...]} or null.
export async function pickRanger(store, area, caseRow) {
  for (const key of [area.primary, ...area.backups]) {
    const r = await checkRanger(store, key)
    if (!r.ok) continue
    if (r.contact && caseRow && isOwnConversation(caseRow, r.contact)) continue
    return { key, name: r.name, contact: r.contact }
  }
  return null
}

const isUnheld = (c) => { const a = String(c?.assignee || '').trim(); return !a || a === UNCLAIMED }

// Give an unassigned open case to its area's ranger. Safe to call on every report
// write: every "no" is a quiet {assigned:false, why}. Never throws to the caller's
// turn (the caller also catches).
export async function autoAssignByArea(store, caseId, { user = SYSTEM_ACTOR } = {}) {
  if (!AREA_FIELD) return { assigned: false, why: 'no area field configured' }
  return store._withLock(`assign|${caseId}`, async () => {
    const c = await store.getCase(caseId)
    if (!c || c.channel === 'system' || !isOpenCase(c)) return { assigned: false, why: 'not an open report' }
    if (!isUnheld(c)) return { assigned: false, why: 'already held by someone' }
    const areas = await loadAreas(store)
    if (!areas.length) return { assigned: false, why: 'no areas mapped' }
    const report = parseReport(c)
    const hit = resolveArea(areas, { association: statedArea(report), location: report.location })
    if (!hit) return { assigned: false, why: 'area not mapped' }
    // Once per case: an earlier automatic allocation that a person later undid
    // (released, reassigned, unassigned) is an override, and it wins.
    const events = await store.listEvents(c.id)
    if (events.some(e => evData(e).area_auto_assigned)) return { assigned: false, why: 'already auto-assigned once' }
    const pick = await pickRanger(store, hit.area, c)
    if (!pick) return { assigned: false, why: 'no valid ranger for that area', area: hit.area.name }
    await store.updateCase(c.id, { assignee: pick.key }, user)
    const data = { assignee: pick.key, by: 'area-router', assigned_name: pick.name, area_id: hit.area.id, area_name: hit.area.name, matched_by: hit.matched_by, area_auto_assigned: true }
    if (pick.contact) data.assigned_contact_id = pick.contact.id
    await store.appendEvent(c.id, { kind: 'action', actor: 'system', text: `given automatically to ${pick.name} (area ${hit.area.name})`, data })
    return { assigned: true, to: pick.key, name: pick.name, area: hit.area.name, ref: c.ref, matched_by: hit.matched_by }
  })
}

// After an operator maps a new area (or fixes a spelling), give the open unassigned
// cases THAT AREA now resolves to its ranger. `area` is the area just edited: only a
// case whose stated area or place resolves to it (its name or an alias) is touched, so
// saving one area never hands out reports that belong to another or to none. `skipped`
// counts only the cases in scope that could not be given out (no valid ranger, or the
// case had been handed out once already).
export async function applyAreasToUnassigned(store, { user = SYSTEM_ACTOR, area = null } = {}) {
  const areas = await loadAreas(store)
  const out = { assigned: [], skipped: 0 }
  if (!areas.length || !AREA_FIELD || !area) return out
  const open = (await store.listCases({}, { limit: 10000, offset: 0 })).filter(c => c.channel !== 'system' && isOpenCase(c) && isUnheld(c))
  for (const c of open) {
    const r = parseReport(c)
    const hit = resolveArea(areas, { association: statedArea(r), location: r.location })
    if (!hit || hit.area.id !== area.id) continue
    const res = await autoAssignByArea(store, c.id, { user }).catch(() => ({ assigned: false }))
    if (res.assigned) out.assigned.push({ ref: res.ref, area: res.area, to: res.name })
    else out.skipped += 1
  }
  return out
}

// ---------- unmapped list ----------

// Open cases whose stated association (or, failing that, location) matches no
// area, grouped by what was said. PII-free: counts, the spelling, and references.
export async function unmappedAreas(store, { areas = null, cap = 100 } = {}) {
  const list = areas || await loadAreas(store)
  const open = (await store.listCases({}, { limit: 10000, offset: 0 })).filter(c => c.channel !== 'system' && isOpenCase(c))
  const groups = new Map()
  for (const c of open) {
    const r = parseReport(c)
    const stated = statedArea(r)
    if (resolveArea(list, { association: stated, location: r.location })) continue
    const kind = stated ? 'association' : (String(r.location || '').trim() ? 'location' : 'none')
    const value = stated || String(r.location || '').trim().slice(0, 120)
    const k = `${kind}|${norm(value)}`
    const g = groups.get(k) || { value, kind, count: 0, refs: [] }
    g.count += 1
    if (g.refs.length < 10) g.refs.push(c.ref)
    groups.set(k, g)
  }
  const rows = [...groups.values()].sort((a, b) => b.count - a.count)
  return { total: rows.reduce((n, g) => n + g.count, 0), groups: rows.slice(0, cap), truncated: rows.length > cap }
}

// ---------- wrong-area derivation ----------

// null when nothing looks wrong. Otherwise {reasons, location_area, association_area,
// assignee_areas}. Two independent signals, both from data already on the record:
//   location_elsewhere  the location text resolves to an area the current assignee
//                       does not cover (only when the assignee covers some area)
//   association_disagrees  the recorded association names one area, the location
//                       text another
export function possiblyWrongArea(caseRow, areas) {
  if (!caseRow || !areas?.length) return null
  const report = parseReport(caseRow)
  const stated = statedArea(report)
  const assocHit = stated ? resolveArea(areas, { association: stated }) : null
  const locHit = resolveAreaFromLocation(areas, report.location)
  const held = !isUnheld(caseRow) ? String(caseRow.assignee).trim() : ''
  const mine = held ? areasOfRanger(areas, [held]) : []
  const reasons = []
  if (locHit && mine.length && !mine.some(a => a.id === locHit.area.id)) reasons.push('location_elsewhere')
  if (assocHit && locHit && assocHit.area.id !== locHit.area.id) reasons.push('association_disagrees')
  if (!reasons.length) return null
  const brief = (a) => (a ? { id: a.id, name: a.name } : null)
  return { reasons, location_area: brief(locHit?.area), association_area: brief(assocHit?.area), assignee_areas: mine.map(brief) }
}

// Every open case flagged by possiblyWrongArea, most recently active first, as plain
// rows for the wrong-area list: what the report is, the area it counts as now, the area
// it seems to belong in and that area's first valid ranger. Holder and ranger are
// returned as KEYS (`holder_key`, `suggested_ranger_key`) for the route to name.
export async function wrongAreaCases(store, areas = null) {
  const list = areas || await loadAreas(store)
  if (!list.length || !AREA_FIELD) return []
  const open = (await store.listCases({}, { limit: 10000, offset: 0 })).filter(c => c.channel !== 'system' && isOpenCase(c))
  open.sort((x, y) => (Number(y.last_event_at) || 0) - (Number(x.last_event_at) || 0))
  const rows = []
  const rangerOf = new Map()
  for (const c of open) {
    const flag = possiblyWrongArea(c, list)
    if (!flag) continue
    const r = parseReport(c)
    const now = resolveArea(list, { association: statedArea(r), location: r.location })
    const sug = flag.location_area || flag.association_area
    const target = sug ? list.find(a => a.id === sug.id) : null
    if (target && !rangerOf.has(target.id)) rangerOf.set(target.id, (await pickRanger(store, target, null))?.key || '')
    rows.push({
      id: c.id, ref: c.ref, subject: c.subject || '',
      report: { species: r.species != null ? String(r.species) : '', location: r.location != null ? String(r.location) : '', association: statedArea(r) },
      current_area: now ? { id: now.area.id, name: now.area.name } : null,
      suggested_area: sug ? { id: sug.id, name: sug.name } : null,
      suggested_ranger_key: target ? rangerOf.get(target.id) : '',
      reasons: flag.reasons, flag,
      holder_key: isUnheld(c) ? '' : String(c.assignee).trim(),
    })
  }
  return rows
}

// The area facts a staff case detail carries.
export async function areaInfoFor(store, caseRow, areas = null) {
  if (!AREA_FIELD) return null
  const list = areas || await loadAreas(store)
  const report = parseReport(caseRow)
  const hit = resolveArea(list, { association: statedArea(report), location: report.location })
  return {
    association: statedArea(report) || null,
    area: hit ? { id: hit.area.id, name: hit.area.name, matched_by: hit.matched_by } : null,
    possibly_wrong_area: possiblyWrongArea(caseRow, list),
  }
}

// ---------- relocate and reassign ----------

// The secretary/operator correction: record the area the case really belongs to
// and (by default) hand it to that area's ranger. `area` names a mapped area (id,
// name or alias); `association` is a free spelling to record when the place is not
// mapped yet (then no automatic ranger exists, so pass `assignee` or leave the
// holder as it was). `assignee` always wins over the area's ranger.
export async function relocateCase(store, caseId, { area = '', association = '', assignee = '', reassign = true, reason = '', by = 'an operator', user = SYSTEM_ACTOR } = {}) {
  if (!AREA_FIELD) return { ok: false, error: 'areas are not set up for this system' }
  return store._withLock(`assign|${caseId}`, async () => {
    const c = await store.getCase(caseId)
    if (!c || c.channel === 'system') return { ok: false, error: 'No such report.' }
    if (!isOpenCase(c)) return { ok: false, error: 'That report is finished. Reopen it before moving it to another area.' }
    const areas = await loadAreas(store)
    const wanted = String(area || '').trim()
    const target = wanted ? findArea(areas, wanted) : null
    if (wanted && !target) return { ok: false, error: `No area called "${wanted.slice(0, 80)}". Add the area first, or write the place in your own words.` }
    const spelling = target ? target.name : String(association || '').trim().slice(0, 120)
    if (!spelling) return { ok: false, error: 'Say which area the report belongs in.' }

    const report = parseReport(c)
    const oldStated = statedArea(report)
    const oldHit = resolveArea(areas, { association: oldStated, location: report.location })
    const had = String(c.assignee || '').trim()

    let next = null
    if (assignee) {
      const r = await checkRanger(store, assignee)
      if (!r.ok) return { ok: false, error: `That person cannot be used: ${r.why}.` }
      if (r.contact && isOwnConversation(c, r.contact)) return { ok: false, error: 'That is the reporter\'s own chat, so it cannot be given to them.' }
      next = { key: String(assignee).trim(), name: r.name, contact: r.contact }
    } else if (target && reassign) {
      next = await pickRanger(store, target, c)
      if (!next) return { ok: false, error: `No valid ranger is set for ${target.name}. Fix the area first, or choose a person.` }
    }

    // The area field is a correction: written directly (not through the auto-assign
    // path), so the old value is on the timeline as from -> to.
    const merged = await store.mergeReport(c.id, { [AREA_FIELD]: spelling }, user, { bypassObserve: true, autoAssign: false })
    if (merged.error) return { ok: false, error: merged.error }

    let reassigned = false
    if (next && next.key !== had) {
      if (had && had !== UNCLAIMED) { await releaseCase({ store, caseRow: c, by, user }); clearFocusForCase(c.id) }
      await store.updateCase(c.id, { assignee: next.key }, user)
      reassigned = true
    }
    const data = {
      by, relocated: true, reason: String(reason || '').slice(0, 300),
      from_area: oldHit?.area.name || oldStated || null, to_area: spelling,
      corrections: { [AREA_FIELD]: { from: oldStated || null, to: spelling } },
    }
    if (reassigned) { data.assignee = next.key; data.assigned_name = next.name; if (had && had !== UNCLAIMED) data.was = had; if (next.contact) data.assigned_contact_id = next.contact.id }
    await store.appendEvent(c.id, {
      kind: 'action', actor: 'operator',
      text: `Moved to another area by ${by}: ${data.from_area || 'no area'} -> ${spelling}${reassigned ? `; now with ${next.name}` : ''}${reason ? ` (${String(reason).slice(0, 200)})` : ''}`,
      data,
    })
    return { ok: true, ref: c.ref, from_area: data.from_area, to_area: spelling, mapped: !!target, reassigned, assigned_to: next ? { key: next.key, name: next.name } : null }
  })
}

export { rangerName }
