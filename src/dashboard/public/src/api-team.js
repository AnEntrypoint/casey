// api-team.js -- the browser's calls for areas, the hand-over to the technician,
// "my day", bulk team registration and feedback. Built on api.js's one exported
// api() call (as api-roles.js is), so credentials, timeouts and the connection
// banner behave identically. The contract for every path is the header comment of
// the server route file named beside it.
import { api, ApiError } from './api.js';

async function json(path, opts) {
  const r = await api(path, opts);
  let body = null;
  try { body = await r.json(); } catch { /* no body */ }
  if (!r.ok) throw new ApiError(r.status, body);
  return body;
}
const send = (method, path, body) => json(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const seg = (id) => encodeURIComponent(id);

// ---- areas (routes/areas.js) ------------------------------------------------
export const fetchAreas = () => json('/api/areas');
export const fetchWrongArea = (offset, limit) => json('/api/areas/wrong-area?offset=' + (offset || 0) + '&limit=' + (limit || 25));
export const putArea = (body) => send('PUT', '/api/areas', body);
export const deleteArea = (id) => json('/api/areas/' + seg(id), { method: 'DELETE' });
export const postRelocate = (id, body) => send('POST', '/api/cases/' + seg(id) + '/relocate', body);

// ---- hand-over to the sign-off desk and "my day" (routes/areas.js) ----------
export const postHandoff = (id, ref, note) => send('POST', '/api/cases/' + seg(id) + '/handoff', { note: note || '', expected_ref: ref });
export const fetchMyDay = () => json('/api/my-day');

// ---- bulk team registration (routes/team-import.js) -------------------------
export const postRolesImport = (csv, dryRun) => send('POST', '/api/roles/import', { csv, dry_run: !!dryRun });
export const fetchRoster = () => json('/api/roles/roster');

// ---- feedback (routes/feedback.js) ------------------------------------------
export const fetchFeedback = () => json('/api/feedback?limit=100');
export const postFeedback = (text) => send('POST', '/api/feedback', { text });

// ---- who is who --------------------------------------------------------------
// The assignable people (a WhatsApp team member is held as an opaque contact key).
// A person with a WhatsApp number and a dashboard login is listed twice by the
// server; the login row carries `alias_of`, and the pair is one person here.
export const fetchTeamMembers = () => json('/api/team-members');
// Dashboard logins by name: the one people call a field login may make, used to
// turn a login name on a list row into the person's own name.
export const fetchOperatorNames = () => json('/api/operators');
