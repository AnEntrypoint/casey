// Contacts/Reporters panel -- the browse surface for the operator-assignable
// access-tier design (see thatcher.config.yml contact.tier, gateway-hooks.js
// toolCtx.tier). Internal-team-only (never on the public /report form): shows
// who has reported, their current tier, and lets any authed operator promote/
// demote (not admin-only -- unlike account management, tier assignment is an
// everyday triage action). Also the data-retention/erasure endpoint.
//
// deps: store, wrap, actingOperator, authed, isAdmin, fmtPhone27
export function registerContacts(app, deps) {
  const { store, wrap, actingOperator, authed, isAdmin, fmtPhone27 } = deps

  const publicContact = (c) => ({
    id: c.id, channel: c.channel, external_id_masked: fmtPhone27(c.external_id),
    display_name: c.display_name || null, tier: c.tier === 'field_worker' ? 'field_worker' : 'reporter',
    last_location_lat: c.last_location_lat ?? null, last_location_lon: c.last_location_lon ?? null,
    last_location_at: c.last_location_at || null, created_at: c.created_at,
  })
  app.get('/api/contacts', wrap(async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const contacts = await store.listContacts({ limit: 1000 })
    res.json({ contacts: contacts.map(publicContact) })
  }))
  app.post('/api/contacts/:id/tier', async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    try {
      const { tier } = req.body || {}
      if (tier !== 'reporter' && tier !== 'field_worker') return res.status(400).json({ error: 'tier must be "reporter" or "field_worker"' })
      await store.setContactTier(req.params.id, tier, { id: actingOperator(req).id, role: 'operator' })
      const updated = await store.getContact(req.params.id)
      res.json({ contact: publicContact(updated) })
    } catch (e) { res.status(400).json({ error: e.message }) }
  })
  // Data retention / right-to-erasure (POPIA/GDPR-style): admin-only, irreversible
  // -- scrubs the contact's identifying fields plus every case's PII report fields
  // (see case-store.js eraseContact), leaving an audited tombstone event on each
  // touched case rather than a silent delete. Admin-gated like account management,
  // not the low-friction everyday-triage tier of /api/contacts/:id/tier above --
  // this is a compliance action with no undo.
  app.post('/api/contacts/:id/erase', async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' })
    try {
      const reason = String(req.body?.reason || '').trim().slice(0, 300)
      const result = await store.eraseContact(req.params.id, { reason, operator: { id: actingOperator(req).id } })
      res.json({ ok: true, ...result })
    } catch (e) { res.status(400).json({ error: e.message }) }
  })
}
