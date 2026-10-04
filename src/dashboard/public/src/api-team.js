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

export const fetchAreas = () => json('/api/areas');
export const fetchWrongArea = (offset, limit) => json('/api/areas/wrong-area?offset=' + (offset || 0) + '&limit=' + (limit || 25));
export const putArea = (body) => send('PUT', '/api/areas', body);
export const deleteArea = (id) => json('/api/areas/' + seg(id), { method: 'DELETE' });
export const postRelocate = (id, body) => send('POST', '/api/cases/' + seg(id) + '/relocate', body);

export const postHandoff = (id, ref, note) => send('POST', '/api/cases/' + seg(id) + '/handoff', { note: note || '', expected_ref: ref });
export const fetchMyDay = () => json('/api/my-day');

export const postRolesImport = (csv, dryRun) => send('POST', '/api/roles/import', { csv, dry_run: !!dryRun });
export const fetchRoster = () => json('/api/roles/roster');

export const fetchFeedback = () => json('/api/feedback?limit=100');
export const postFeedback = (text) => send('POST', '/api/feedback', { text });

export const fetchTeamMembers = () => json('/api/team-members');
export const fetchOperatorNames = () => json('/api/operators');
