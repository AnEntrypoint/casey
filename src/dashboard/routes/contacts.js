// Contacts/Reporters panel -- the browse surface for the operator-assignable
// access-tier design (see thatcher.config.yml contact.tier, gateway-hooks.js
// toolCtx.tier). Internal-team-only (never on the public /report form): shows
// who has reported, their current tier, and lets any authed operator promote/
// demote (not admin-only -- unlike account management, tier assignment is an
// everyday triage action). Also the data-retention/erasure endpoint.
//
// deps: store, wrap, actingOperator, authed, isAdmin
import { fmtPhone27 } from '../../format.js'
import { mountRoutes } from './register.js'
import { TIER_ORDER, TIER_REPORTER, TIER_OPERATOR, ADMIN_ONLY_TIERS, grantableBy, resolveContactTier } from '../../contact-tiers.js'
import { createInvite, listInvites, revokeInvite, normalizeMsisdn } from '../../role-invites.js'
import { countPersonsByContact } from '../../phone-persons.js'

// The one allowlist through which a contact row may reach JSON (AGENTS.md
// Security invariants). Module-level and named on purpose: the three fields
// that may never be emitted -- external_id, author_key, contact_id -- stay
// unemitted because this is the single definition every contact handler has to
// go through, not a binding that happens to be in scope beside twenty others.
// external_id_formatted is the deliberate DISPLAY form: an authed operator may
// ring back the person reporting a dying herd, so the number is formatted here
// via format.js's fmtPhone27 and the raw routing key never leaves.
// last_location_lat/lon are deliberately NOT emitted here. They were, and
// nothing ever read them: the contacts panel renders only last_location_at, as
// "last seen <time>" or "never". They also carried no provenance. A worker's
// stored position may be the model's own guess at a place name they said
// rather than a GPS fix, which is why the map's own worker projection
// (routes/map.js workerPinProjection) emits location_source beside the
// coordinate and draws the two differently. Handing a bare lat/lon to a client
// through this allowlist invited the opposite: a guess rendered as a fact, by
// whichever panel picked the fields up first.
//
// If a panel does need to show where a worker is, it should go through the map
// projection, which carries the provenance -- or this allowlist should gain
// last_location_source at the same time as the coordinates, never before.
//
// `named` and `has_number` are DERIVED HERE, from the stored columns, rather
// than left to the client to infer from the rendered string. The public form
// opens a contact with no name entry by writing the generated routing key into
// display_name as well, so `display_name || external_id_formatted` put a
// machine token -- web-1787845705110 -- in the operator's "Who" column on 12 of
// 20 live rows, presented exactly like a person's name. Comparing the two
// stored columns is a fact about the data; matching the rendered string against
// a /^web-/ shape would be a guess about it, and would break the moment the
// routing-key format changed.
export const publicContact = (c) => {
  const formatted = fmtPhone27(c.external_id)
  return {
    id: c.id, channel: c.channel, external_id_formatted: formatted,
    // resolveContactTier, not a two-way ternary: the ladder has three rungs
    // (contact-tiers.js) and collapsing anything-but-field_worker to 'reporter'
    // here would show an operator the LOWEST rung for the contact holding the
    // HIGHEST one, on the very panel they use to assign it. Still fail-closed --
    // an unrecognised stored value is reported as the reporter it is treated as,
    // never rendered raw.
    display_name: c.display_name || null, tier: resolveContactTier(c),
    // A name somebody gave, as opposed to the routing key echoed into the
    // column because nobody gave one.
    named: !!(c.display_name && c.display_name !== c.external_id),
    // fmtPhone27 returns its input unchanged when the value is not a number it
    // recognises, so a formatted value that DIFFERS from the raw one is exactly
    // "this is a phone number an operator can ring back".
    has_number: formatted !== String(c.external_id || ''),
    last_location_at: c.last_location_at || null, created_at: c.created_at,
  }
}

export function getContacts({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    // The panel's default view is the TEAM, but the newest-first cut used to be taken before
    // any filtering: once public reporters passed 1000 the team (registered earlier) fell off
    // the end and "Team members (0)" was shown over people who exist. So the segment and the
    // search are applied here, over everyone, and the counts say what exists.
    // How many people are recorded behind each phone (src/phone-persons.js): one read for the whole list. A phone
    // with nobody recorded carries no `people` at all, so a single-person phone looks exactly as before.
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
      // Validated against the real ladder rather than a hand-written pair, so a
      // rung added to contact-tiers.js is assignable here with nothing to keep in
      // sync -- and an unrecognised value is still REFUSED at this write boundary
      // rather than quietly coerced (see case-store.js's setContactTier for why
      // reads coerce and writes refuse).
      if (!TIER_ORDER.includes(tier)) return res.status(400).json({ error: `tier must be one of ${TIER_ORDER.map(t => `"${t}"`).join(', ')}` })
      // The operator and technician rungs (team management, sign-off): only an admin may grant them.
      if (ADMIN_ONLY_TIERS.includes(tier) && !isAdmin(req)) return res.status(403).json({ error: `only an admin can make someone ${tier === TIER_OPERATOR ? 'an operator' : 'a technician'}` })
      // The operator rung is an admin's to give AND to take away.
      const existing = await store.getContact(req.params.id)
      if (existing && resolveContactTier(existing) === TIER_OPERATOR && tier !== TIER_OPERATOR && !isAdmin(req)) return res.status(403).json({ error: 'only an admin can change an operator' })
      await store.setContactTier(req.params.id, tier, { id: actingOperator(req).id, role: 'operator' })
      const updated = await store.getContact(req.params.id)
      res.json({ contact: publicContact(updated) })
    } catch (e) { res.status(400).json({ error: e.message }) }
  }
}

// Data retention / right-to-erasure (POPIA/GDPR-style): admin-only, irreversible
// -- scrubs the contact's identifying fields plus every case's PII report fields
// (see case-store.js eraseContact), leaving an audited tombstone event on each
// touched case rather than a silent delete. Admin-gated like account management,
// not the low-friction everyday-triage tier of /api/contacts/:id/tier above --
// this is a compliance action with no undo.
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

// Register a phone number in a role before it ever messages in (mechanism 1 of
// 2; mechanism 2 is the one-time WhatsApp code below).
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

// One-time WhatsApp role codes (mechanism 2). The plain code is in the create
// response ONCE; only its hash is stored, so it cannot be shown again.
export function getRoleInvites({ store, authed, getRoster }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    // A dashboard-made code records the maker's username; show the operator's
    // display name from the account roster (a code minted over WhatsApp already
    // carries a display label, which has no roster entry and passes through).
    const names = new Map((await getRoster()).map(r => [r.id, r.name]))
    const invites = (await listInvites(store)).map(v => ({ ...v, created_by: names.get(v.created_by) || v.created_by }))
    res.json({ invites })
  }
}

export function postRoleInvite({ store, authed, isAdmin, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    try {
      const { tier, label, ttl_hours, max_uses } = req.body || {}
      const grantableTiers = grantableBy(isAdmin(req))
      const invite = await createInvite(store, { tier, label, ttlHours: ttl_hours, maxUses: max_uses, by: actingOperator(req).id, grantableTiers })
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
