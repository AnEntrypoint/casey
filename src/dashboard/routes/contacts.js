import { fmtPhone27 } from '../../format.js'
import { mountRoutes } from './register.js'
import { TIER_ORDER, TIER_REPORTER, TIER_OPERATOR, ADMIN_ONLY_TIERS, grantableBy, resolveContactTier } from '../../contact-tiers.js'
import { createInvite, createInvites, listInvites, revokeInvite, normalizeMsisdn } from '../../role-invites.js'
import { countPersonsByContact } from '../../phone-persons.js'

export const publicContact = (c) => {
  const formatted = fmtPhone27(c.external_id)
  return {
    id: c.id, channel: c.channel, external_id_formatted: formatted,
    display_name: c.display_name || null, tier: resolveContactTier(c),
    named: !!(c.display_name && c.display_name !== c.external_id),
    has_number: formatted !== String(c.external_id || ''),
    last_location_at: c.last_location_at || null, created_at: c.created_at,
  }
}

export function getContacts({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const people = await countPersonsByContact(store).catch(() => new Map())
    const all = (await store.listContacts({ limit: 10000 })).map((c) => ({ ...publicContact(c), ...(people.has(c.id) ? { people: people.get(c.id), shared_phone: people.get(c.id) > 1 } : {}) }))
    const team = all.filter((c) => c.tier !== TIER_REPORTER)
    const seg = String(req.query.segment || '')
    const q = String(req.query.q || '').trim().slice(0, 100).toLowerCase().replace(/\s+/g, ' ')
    let rows = seg === 'team' ? team : seg === 'public' ? all.filter((c) => c.tier === TIER_REPORTER) : all
    if (q) rows = rows.filter((c) => [c.display_name, c.external_id_formatted].join(' ').toLowerCase().includes(q))
    const CAP = 300
    res.json({ contacts: rows.slice(0, CAP), matched: rows.length, capped: rows.length > CAP, counts: { team: team.length, public: all.length - team.length, all: all.length } })
  }
}

export function postContactTier({ store, authed, isAdmin, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    try {
      const { tier } = req.body || {}
      if (!TIER_ORDER.includes(tier)) return res.status(400).json({ error: `tier must be one of ${TIER_ORDER.map(t => `"${t}"`).join(', ')}` })
      if (ADMIN_ONLY_TIERS.includes(tier) && !isAdmin(req)) return res.status(403).json({ error: `only an admin can make someone ${tier === TIER_OPERATOR ? 'an operator' : 'a technician'}` })
      const existing = await store.getContact(req.params.id)
      if (existing && resolveContactTier(existing) === TIER_OPERATOR && tier !== TIER_OPERATOR && !isAdmin(req)) return res.status(403).json({ error: 'only an admin can change an operator' })
      await store.setContactTier(req.params.id, tier, { id: actingOperator(req).id, role: 'operator' })
      const updated = await store.getContact(req.params.id)
      res.json({ contact: publicContact(updated) })
    } catch (e) { res.status(400).json({ error: e.message }) }
  }
}

export function postContactErase({ store, authed, isAdmin, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' })
    try {
      const reason = String(req.body?.reason || '').trim().slice(0, 300)
      const result = await store.eraseContact(req.params.id, { reason, operator: { id: actingOperator(req).id } })
      res.json({ ok: true, ...result })
    } catch (e) { res.status(400).json({ error: e.message }) }
  }
}

export function postContactRegister({ store, authed, isAdmin, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    try {
      const { phone, name, tier } = req.body || {}
      const external_id = normalizeMsisdn(phone)
      if (!external_id) return res.status(400).json({ error: 'that does not look like a phone number -- use the full number, e.g. 079 091 5297 or +27 79 091 5297' })
      if (!TIER_ORDER.includes(tier) || tier === TIER_REPORTER) return res.status(400).json({ error: `role must be one of ${TIER_ORDER.filter(t => t !== TIER_REPORTER).map(t => `"${t}"`).join(', ')}` })
      if (ADMIN_ONLY_TIERS.includes(tier) && !isAdmin(req)) return res.status(403).json({ error: `only an admin can make someone ${tier === TIER_OPERATOR ? 'an operator' : 'a technician'}` })
      const known = (await store.listContacts({ limit: 1000 })).find(k => k.channel === 'whatsapp' && k.external_id === external_id)
      if (known && resolveContactTier(known) === TIER_OPERATOR && tier !== TIER_OPERATOR && !isAdmin(req)) return res.status(403).json({ error: 'only an admin can change an operator' })
      const contact = await store.registerContact({ channel: 'whatsapp', external_id, display_name: String(name || '').trim().slice(0, 80), tier }, { id: actingOperator(req).id, role: 'operator' })
      res.json({ contact: publicContact(contact) })
    } catch (e) { res.status(400).json({ error: e.message }) }
  }
}

export function getRoleInvites({ store, authed, getRoster }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const names = new Map((await getRoster()).map(r => [r.id, r.name]))
    const invites = (await listInvites(store)).map(v => ({ ...v, created_by: names.get(v.created_by) || v.created_by }))
    res.json({ invites })
  }
}

export function postRoleInvite({ store, authed, isAdmin, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    try {
      const { tier, label, ttl_hours, max_uses, count } = req.body || {}
      const grantableTiers = grantableBy(isAdmin(req))
      const opts = { tier, label, ttlHours: ttl_hours, maxUses: max_uses, by: actingOperator(req).id, grantableTiers }
      if (count !== undefined && count !== null && count !== '') {
        const n = typeof count === 'number' || (typeof count === 'string' && /^\s*\d+\s*$/.test(count)) ? Number(count) : NaN
        if (!Number.isInteger(n) || n < 1 || n > 100) return res.status(400).json({ error: 'How many codes must be a whole number from 1 to 100.' })
        if (n > 1) return res.json({ invites: await createInvites(store, { ...opts, count: n }) })
      }
      const invite = await createInvite(store, opts)
      res.json({ invite })
    } catch (e) { res.status(400).json({ error: e.message }) }
  }
}

export function deleteRoleInvite({ store, authed, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    try { await revokeInvite(store, req.params.id, actingOperator(req).id); res.json({ ok: true }) }
    catch (e) { res.status(400).json({ error: e.message }) }
  }
}

const ROUTES = [
  ['post', '/api/contacts/register', postContactRegister, { raw: true }],
  ['get', '/api/role-invites', getRoleInvites],
  ['post', '/api/role-invites', postRoleInvite, { raw: true }],
  ['delete', '/api/role-invites/:id', deleteRoleInvite, { raw: true }],
  ['get', '/api/contacts', getContacts],
  ['post', '/api/contacts/:id/tier', postContactTier, { raw: true }],
  ['post', '/api/contacts/:id/erase', postContactErase, { raw: true }],
]

export function registerContacts(app, deps) {
  mountRoutes(app, deps, ROUTES)
}
