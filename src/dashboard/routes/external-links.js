// Cross-system correlation panel -- lists proposed links between casey's own
// cases/contacts and records from another system (see EXTERNAL-SYNC.md), and
// lets an authed operator Confirm/Reject each one. Confirm is the only path
// that ever consolidates data (src/sync/apply-link.js's fill-if-empty, never
// an overwrite); Reject just marks the row so a sync pass does not re-propose
// the same non-match.
//
// PII-safe projection, same discipline as contacts.js's publicContact: never
// returns local_id/external_id raw (an internal join key + a third-party
// system's own id, neither is display-safe on its own), only the pre-computed
// external_ref label plus the scoring metadata an operator needs to judge a
// proposal.
//
// deps: store, wrap, actingOperator, authed
import { mountRoutes } from './register.js';

export const publicExternalLink = (l) => ({
  id: l.id, system: l.system, local_entity: l.local_entity,
  external_entity: l.external_entity, external_ref: l.external_ref,
  match_basis: l.match_basis, confidence: Number(l.confidence) || 0,
  status: l.status, created_at: l.created_at,
});

export function getExternalLinks({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
    const status = ['proposed', 'confirmed', 'rejected'].includes(req.query.status) ? req.query.status : 'proposed';
    const rows = await store.t.list('external_link', { status }, { limit: 500, sort: [{ field: 'created_at', dir: 'DESC' }] });
    res.json({ links: rows.map(publicExternalLink) });
  };
}

export function postExternalLinkConfirm({ store, authed, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
    try {
      const user = { id: actingOperator(req).id, role: 'operator' };
      const link = await store.t.get('external_link', req.params.id);
      if (!link) return res.status(404).json({ error: 'link not found' });
      if (link.status !== 'proposed') return res.status(400).json({ error: 'link is not in proposed status' });
      const confirmed = await store.t.update('external_link', link.id, { status: 'confirmed' }, user);
      // No live external record source is wired yet (see EXTERNAL-SYNC.md /
      // sync-adapter-seam) -- confirming records the human decision now;
      // applyConfirmedLink runs once a real adapter can hand this route the
      // external record body, not invented here as a placeholder object.
      res.json({ link: publicExternalLink({ ...link, ...confirmed }) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  };
}

export function postExternalLinkReject({ store, authed, actingOperator }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
    try {
      const user = { id: actingOperator(req).id, role: 'operator' };
      const link = await store.t.get('external_link', req.params.id);
      if (!link) return res.status(404).json({ error: 'link not found' });
      if (link.status !== 'proposed') return res.status(400).json({ error: 'link is not in proposed status' });
      const rejected = await store.t.update('external_link', link.id, { status: 'rejected' }, user);
      res.json({ link: publicExternalLink({ ...link, ...rejected }) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  };
}

const ROUTES = [
  ['get', '/api/external-links', getExternalLinks],
  ['post', '/api/external-links/:id/confirm', postExternalLinkConfirm, { raw: true }],
  ['post', '/api/external-links/:id/reject', postExternalLinkReject, { raw: true }],
];

export function registerExternalLinks(app, deps) {
  mountRoutes(app, deps, ROUTES);
}
