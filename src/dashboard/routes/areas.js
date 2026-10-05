import { mountRoutes } from './register.js'
import { isStaffAccount, isTechnician, resolveContact } from '../roles.js'
import { isContactAssignee, contactIdOfAssignee } from '../../case-assignment.js'
import { TIER_FIELD_WORKER, TIER_ANIMAL_HEALTH_TECHNICIAN } from '../../contact-tiers.js'
import { staffLabel } from '../../hooks/staff-outbound.js'
import { handoffToTechnician } from '../../signoff-desk.js'
import { myDay, keysForContact } from '../../my-day.js'
import { AREA_FIELD } from '../../store/report-shape.js'
import { isOpenCase } from '../../format.js'
import { parseReport } from '../../timestamp.js'
import {
  loadAreas, upsertArea, removeArea, findArea, unmappedAreas, applyAreasToUnassigned,
  relocateCase, resolveArea, statedArea, wrongAreaCases,
} from '../../areas.js'
import { assigneeNamer } from '../assignee-names.js'

const staffOnly = (req, res) => {
  if (isStaffAccount(req.caseyAccount)) return true
  res.status(403).json({ error: 'This is not available for your login.', code: 'role_forbidden' })
  return false
}

const keysOfAreas = (areas) => areas.flatMap(a => [a.primary, ...a.backups])
const namerFor = (store, keys) => assigneeNamer(store, keys, (k) => k, { logins: true })

function areaView(name, a, openCounts) {
  const person = (key) => ({ key, name: name(key) })
  return {
    id: a.id, name: a.name, aliases: a.aliases,
    primary: person(a.primary), backups: a.backups.map(person),
    lat: a.lat ?? null, lon: a.lon ?? null, district: a.district || '',
    updated_at: a.updated_at, updated_by: name(a.updated_by), open_cases: openCounts.get(a.id) || 0,
  }
}

export function getAreas({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    if (!staffOnly(req, res)) return
    const areas = await loadAreas(store)
    const open = (await store.listCases({}, { limit: 10000, offset: 0 })).filter(c => c.channel !== 'system' && isOpenCase(c))
    const counts = new Map()
    for (const c of open) {
      const r = parseReport(c)
      const hit = resolveArea(areas, { association: statedArea(r), location: r.location })
      if (hit) counts.set(hit.area.id, (counts.get(hit.area.id) || 0) + 1)
    }
    const name = await namerFor(store, [...keysOfAreas(areas), ...areas.map(a => a.updated_by)])
    res.json({
      area_field: AREA_FIELD,
      areas: areas.map(a => areaView(name, a, counts)),
      unmapped: await unmappedAreas(store, { areas }),
    })
  }
}

export function getWrongArea({ store, authed, clampLimit, offsetOf }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    if (!staffOnly(req, res)) return
    const limit = clampLimit ? clampLimit(req.query.limit, 25) : 25
    const offset = offsetOf ? offsetOf(req.query.offset) : 0
    const areas = await loadAreas(store)
    const all = await wrongAreaCases(store, areas)
    const page = all.slice(offset, offset + limit)
    const name = await namerFor(store, page.flatMap(r => [r.holder_key, r.suggested_ranger_key]))
    res.json({
      total: all.length, limit, offset,
      items: page.map(({ holder_key, suggested_ranger_key, ...r }) => ({
        ...r,
        holder: holder_key ? { name: name(holder_key) } : null,
        suggested_ranger: suggested_ranger_key ? { name: name(suggested_ranger_key) } : null,
      })),
    })
  }
}

export function putArea({ store, authed, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    if (!staffOnly(req, res)) return
    const b = req.body || {}
    const op = actingOperator(req)
    try {
      const area = await upsertArea(store, { id: b.id, name: b.name, primary: b.primary, backups: b.backups, aliases: b.aliases, lat: b.lat, lon: b.lon, district: b.district }, op.name || op.id)
      const name = await namerFor(store, [...keysOfAreas([area]), area.updated_by])
      const out = { area: areaView(name, area, new Map()) }
      if (b.apply_to_unassigned === true) out.applied = await applyAreasToUnassigned(store, { user: op, area })
      res.json(out)
    } catch (e) { res.status(400).json({ error: e.message }) }
  }
}

export function deleteArea({ store, authed, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    if (!staffOnly(req, res)) return
    const areas = await loadAreas(store)
    if (!findArea(areas, req.params.id)) return res.status(404).json({ error: 'no such area' })
    const op = actingOperator(req)
    await removeArea(store, req.params.id, op.name || op.id)
    res.json({ ok: true })
  }
}

export function postRelocate({ store, authed, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    if (!staffOnly(req, res)) return
    const c = await store.getCase(req.params.id)
    if (!c || c.channel === 'system') return res.status(404).json({ error: 'not found' })
    const b = req.body || {}
    const op = actingOperator(req)
    const out = await relocateCase(store, c.id, {
      area: typeof b.area === 'string' ? b.area : '', association: typeof b.association === 'string' ? b.association : '',
      assignee: typeof b.assignee === 'string' ? b.assignee : '', reassign: b.reassign !== false,
      reason: typeof b.reason === 'string' ? b.reason : '', by: op.name || op.id, user: op,
    })
    if (!out.ok) return res.status(400).json({ error: out.error })
    const { ok, ...rest } = out
    res.json({ ok: true, ...rest })
  }
}

export function postHandoff({ store, authed, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const c = await store.getCase(req.params.id)
    if (!c || c.channel === 'system') return res.status(404).json({ error: 'not found' })
    const op = actingOperator(req)
    const note = typeof req.body?.note === 'string' ? req.body.note : ''
    const out = await handoffToTechnician(store, c.id, { by: op.name || op.id, user: op, data: { by: op.id }, note })
    if (!out.ok) return res.status(400).json({ error: out.error, code: out.code, ...(out.missing ? { missing: out.missing } : {}) })
    res.json({ ok: true, ref: out.ref, ...(out.already ? { already: true } : {}) })
  }
}

export function getMyDay({ store, authed, findAccountByUsername }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const acct = req.caseyAccount
    const since = req.query.since != null && Number.isFinite(Number(req.query.since)) ? Number(req.query.since) : null
    let keys = []; let contact = null; let tier = ''; let name = ''; let ranger
    if (!isStaffAccount(acct)) {
      const asked = String(req.query.ranger || '').trim()
      if (asked && asked !== acct.username && !(acct._contact && asked === `contact:${acct._contact.id}`)) return res.status(403).json({ error: 'You can see your own day only.', code: 'role_forbidden' })
      contact = acct._contact || await resolveContact(store, acct)
      keys = [acct.username, ...(contact ? await keysForContact(store, contact) : [])]
      tier = contact?.tier || (isTechnician(acct) ? TIER_ANIMAL_HEALTH_TECHNICIAN : TIER_FIELD_WORKER)
      name = acct.display_name || acct.username
    } else {
      const key = String(req.query.ranger || '').trim()
      if (!key) return res.status(400).json({ error: 'Choose which ranger to look at.' })
      if (isContactAssignee(key)) {
        contact = await store.getContact(contactIdOfAssignee(key)).catch(() => null)
        if (!contact) return res.status(404).json({ error: 'no such team member' })
        keys = await keysForContact(store, contact); tier = contact.tier; name = staffLabel(contact)
      } else {
        const a = await findAccountByUsername(store, key)
        if (!a) return res.status(404).json({ error: 'no such team member' })
        contact = await resolveContact(store, a)
        keys = [a.username, ...(contact ? await keysForContact(store, contact) : [])]
        tier = contact?.tier || (a.role === 'animal_health_technician' ? TIER_ANIMAL_HEALTH_TECHNICIAN : TIER_FIELD_WORKER)
        name = a.display_name || a.username
      }
      ranger = { key, name }
    }
    res.json({ ...(ranger ? { ranger } : {}), ...(await myDay(store, { keys, contact, tier, name, since })) })
  }
}

const ROUTES = [
  ['get', '/api/areas', getAreas],
  ['get', '/api/areas/wrong-area', getWrongArea],
  ['put', '/api/areas', putArea],
  ['delete', '/api/areas/:id', deleteArea],
  ['post', '/api/cases/:id/relocate', postRelocate],
  ['post', '/api/cases/:id/handoff', postHandoff],
  ['get', '/api/my-day', getMyDay],
]

export function registerAreas(app, deps) {
  mountRoutes(app, deps, ROUTES)
}
