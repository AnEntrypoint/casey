import { api, ApiError } from './api.js';

async function json(path, opts) {
  const r = await api(path, opts);
  let body = null;
  try { body = await r.json(); } catch {  }
  if (!r.ok) throw new ApiError(r.status, body);
  return body;
}
const send = (method, path, body) => json(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const seg = (id) => encodeURIComponent(id);

function query(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? '?' + s : '';
}

export const createPortalRouter = (body) => send('POST', '/api/admin/routers', body);
export const deleteRouterRecord = (routerId) => send('DELETE', '/api/admin/routers/' + seg(routerId));
export const rotateRouterToken = (routerId) => send('POST', '/api/admin/routers/' + seg(routerId) + '/rotate-token');
export const putRouterUplink = (routerId, body) => send('PUT', '/api/admin/routers/' + seg(routerId) + '/uplink', body);
export const fetchPortalConfig = () => json('/api/portal/config');
export const putPortalConfig = (settings) => send('PUT', '/api/portal/config', { settings });
export const putPortalRouterConfig = (routerId, settings) => send('PUT', '/api/portal/config/' + seg(routerId), { settings });
export const fetchPortalUsage = (params) => json('/api/portal/usage' + query(params));
export const fetchPortalHealth = (params) => json('/api/portal/health' + query(params));
