import { api, ApiError, pollCases } from './api.js';
import { state } from './state.js';

async function json(path, opts) {
  const r = await api(path, opts);
  let body = null;
  try { body = await r.json(); } catch {  }
  if (!r.ok) throw new ApiError(r.status, body);
  return body;
}
const send = (method, path, body) => json(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const seg = (id) => encodeURIComponent(id);

const FIELD_ROLES = ['eco_ranger', 'animal_health_technician'];
export const currentRole = () => (state.currentUser && state.currentUser.role) || null;
export const isFieldRole = () => !!state.authed && !['admin', 'operator', 'secretary', 'viewer'].includes(currentRole());
export const isViewerRole = () => !!state.authed && currentRole() === 'viewer';
export const isTechnician = () => currentRole() === 'animal_health_technician';
export const ROLE_NAME = { eco_ranger: 'Eco Ranger', animal_health_technician: 'Animal Health Technician', viewer: 'Read-only viewer' };
export const roleName = () => ROLE_NAME[currentRole()] || 'Field team';
export { FIELD_ROLES };

function fieldCasesQuery(view, { q = '', state: done = '', offset = 0, limit = 200 } = {}) {
  const p = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (view) p.set('view', view);
  if (q) p.set('q', q);
  if (done) p.set('state', done);
  return '?' + p.toString();
}
export function fetchFieldCases(view, opts) {
  return json('/api/cases' + fieldCasesQuery(view, opts));
}
export const pollFieldCases = (view, opts) => pollCases(fieldCasesQuery(view, opts));
export const fetchFieldCase = (id) => json('/api/cases/' + seg(id));

export const postFieldNote = (id, ref, text, relayed) => send('POST', '/api/cases/' + seg(id) + '/note', { text, relayed: !!relayed, expected_ref: ref });
export const postFieldIntake = (id, ref, fields, expected) => send('POST', '/api/cases/' + seg(id) + '/intake', { ...fields, expected, expected_ref: ref });
export const patchFieldCase = (id, ref, body) => send('PATCH', '/api/cases/' + seg(id), { ...body, expected_ref: ref });
export const postFieldTransition = (id, ref, to, reason, extra) => send('POST', '/api/cases/' + seg(id) + '/transition', { ...(extra || {}), to, reason, expected_ref: ref });
export const postFieldLocation = (id, ref, lat, lon) => send('POST', '/api/cases/' + seg(id) + '/location', { lat, lon, expected_ref: ref });
export const postSendBack = (id, ref, text, missing) => send('POST', '/api/cases/' + seg(id) + '/send-back', { text, missing, expected_ref: ref });

export const fetchTeamMembers = () => json('/api/team-members');
export const fetchNudges = () => json('/api/nudges');

const ROSTER_RETRY_MS = 30000;
let roster = null;
let rosterRetryAt = 0;
export function loadRoster(onDone) {
  if (roster !== null || Date.now() < rosterRetryAt) return;
  roster = [];
  fetchTeamMembers().then((j) => { roster = (j && j.members) || []; if (onDone) onDone(); }).catch(() => { roster = null; rosterRetryAt = Date.now() + ROSTER_RETRY_MS; });
}
export const teamRoster = () => roster || [];
export function assigneeName(value) {
  const v = String(value || '');
  if (!v || v === 'agent') return '';
  const hit = (roster || []).find((m) => m.key === v);
  if (hit) return hit.name;
  return v.startsWith('contact:') ? 'a team member' : v;
}
