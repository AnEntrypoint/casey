// api-roles.js -- the browser's calls for the role-shaped screens: the field
// team's own home (eco ranger / animal health technician) and the operator's
// team views. Kept apart from api.js (which another builder owns) and built on
// its one exported api() call, so credentials, timeouts and the connection
// banner behave identically.
import { api, ApiError } from './api.js';
import { state } from './state.js';

async function json(path, opts) {
  const r = await api(path, opts);
  let body = null;
  try { body = await r.json(); } catch { /* no body */ }
  if (!r.ok) throw new ApiError(r.status, body);
  return body;
}
const send = (method, path, body) => json(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const seg = (id) => encodeURIComponent(id);

// ---- who am I ------------------------------------------------------------
const FIELD_ROLES = ['eco_ranger', 'animal_health_technician'];
export const currentRole = () => (state.currentUser && state.currentUser.role) || null;
// Fail-closed the same way the server is: anything that is not a known staff
// role is treated as the field team's narrow screens.
export const isFieldRole = () => !!state.authed && !['admin', 'operator', 'secretary'].includes(currentRole());
export const isTechnician = () => currentRole() === 'animal_health_technician';
export const ROLE_NAME = { eco_ranger: 'Eco Ranger', animal_health_technician: 'Animal Health Technician' };
export const roleName = () => ROLE_NAME[currentRole()] || 'Field team';
export { FIELD_ROLES };

// ---- the field team's cases ------------------------------------------------
// view: 'mine' (assigned to me) | 'signoff' (waiting for a technician) | '' (everything I may see)
export const fetchFieldCases = (view) => json('/api/cases?limit=200' + (view ? '&view=' + view : ''));
export const fetchFieldCase = (id) => json('/api/cases/' + seg(id));

// Every write names the case the screen believes it is changing; the server
// refuses (409) if that is not the case in the URL.
export const postFieldNote = (id, ref, text, relayed) => send('POST', '/api/cases/' + seg(id) + '/note', { text, relayed: !!relayed, expected_ref: ref });
export const postFieldIntake = (id, ref, fields) => send('POST', '/api/cases/' + seg(id) + '/intake', { ...fields, expected_ref: ref });
export const patchFieldCase = (id, ref, body) => send('PATCH', '/api/cases/' + seg(id), { ...body, expected_ref: ref });
export const postFieldTransition = (id, ref, to, reason) => send('POST', '/api/cases/' + seg(id) + '/transition', { to, reason, expected_ref: ref });
export const postFieldLocation = (id, ref, lat, lon) => send('POST', '/api/cases/' + seg(id) + '/location', { lat, lon, expected_ref: ref });
export const postSendBack = (id, ref, text, missing) => send('POST', '/api/cases/' + seg(id) + '/send-back', { text, missing, expected_ref: ref });

// ---- the operator's team views ---------------------------------------------
export const fetchTeamMembers = () => json('/api/team-members');
export const fetchNudges = () => json('/api/nudges');

// Who a stored assignee value names, for display. A WhatsApp team member is
// held as an opaque `contact:<id>` key; the roster resolves it to a name.
let roster = null;
export function loadRoster(onDone) {
  if (roster !== null) return;
  roster = [];
  fetchTeamMembers().then((j) => { roster = (j && j.members) || []; if (onDone) onDone(); }).catch(() => { roster = []; });
}
export const teamRoster = () => roster || [];
export function assigneeName(value) {
  const v = String(value || '');
  if (!v || v === 'agent') return '';
  const hit = (roster || []).find((m) => m.key === v);
  if (hit) return hit.name;
  return v.startsWith('contact:') ? 'a team member' : v;
}
