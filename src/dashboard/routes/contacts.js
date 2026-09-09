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
    display_name: c.display_name || null, tier: c.tier === 'field_worker' ? 'field_worker' : 'reporter',
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
    const contacts = await store.listContacts({ limit: 1000 })
    res.json({ contacts: contacts.map(publicContact) })
  }
}

export function postContactTier({ store, authed, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    try {
      const { tier } = req.body || {}
      if (tier !== 'reporter' && tier !== 'field_worker') return res.status(400).json({ error: 'tier must be "reporter" or "field_worker"' })
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

const ROUTES = [
  ['get', '/api/contacts', getContacts],
  ['post', '/api/contacts/:id/tier', postContactTier, { raw: true }],
  ['post', '/api/contacts/:id/erase', postContactErase, { raw: true }],
]

export function registerContacts(app, deps) {
  mountRoutes(app, deps, ROUTES)
}
