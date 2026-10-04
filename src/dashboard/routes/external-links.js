import { mountRoutes } from './register.js';
import { fmtPhone27 } from '../../format.js';

export const publicExternalLink = (l) => ({
  id: l.id, system: l.system, local_entity: l.local_entity,
  local_ref: l.local_ref || null,
  external_entity: l.external_entity, external_ref: l.external_ref,
  match_basis: l.match_basis, confidence: Number(l.confidence) || 0,
  status: l.status, created_at: l.created_at,
});

async function resolveLocalRef(store, l) {
  try {
    if (l.local_entity === 'case') {
      const c = await store.t.get('case', l.local_id);
      return c ? (c.ref || null) : null;
    }
    if (l.local_entity === 'contact') {
      const ct = await store.t.get('contact', l.local_id);
      if (!ct) return null;
      const named = ct.display_name && ct.display_name !== ct.external_id;
      if (named) return ct.display_name;
      const formatted = fmtPhone27(ct.external_id);
      return formatted !== String(ct.external_id || '') ? formatted : 'unnamed contact';
    }
  } catch {  }
  return null;
}

export function getExternalLinks({ store, authed }) {
  return async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
    const status = ['proposed', 'confirmed', 'rejected'].includes(req.query.status) ? req.query.status : 'proposed';
    const rows = await store.t.list('external_link', { status }, { limit: 500, sort: [{ field: 'created_at', dir: 'DESC' }] });
    const links = await Promise.all(rows.map(async (l) => publicExternalLink({ ...l, local_ref: await resolveLocalRef(store, l) })));
    res.json({ links });
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
