// fetch wrapper + the named endpoint functions used across the app. Thin
// one-line-per-endpoint wrappers around the shared api() call, no logic.
// Every request carries credentials:'include' (session cookie), throws a
// typed ApiError on non-2xx, and toggles the connection-lost banner via
// state.js on network failure vs success.
//
// This is the merged superset of the per-worktree api.js variants (shell/
// case-list/case-detail/panels) -- every endpoint function any consumer
// module imports is present here, verified against the real route files in
// src/dashboard/routes/*.js.

import { setConnLost } from './state.js';

export class ApiError extends Error {
  constructor(status, body) {
    super((body && (body.error || body.message)) || ('request failed: ' + status));
    this.status = status;
    this.body = body;
  }
}

export async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, Object.assign({ credentials: 'include' }, opts));
  } catch (e) {
    setConnLost(true);
    throw e;
  }
  setConnLost(false);
  return res;
}

async function json(path, opts) {
  const r = await api(path, opts);
  let body = null;
  try { body = await r.json(); } catch { /* no body */ }
  if (!r.ok) throw new ApiError(r.status, body);
  return body;
}
function post(path, body) {
  return json(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
}
function patch(path, body) {
  return json(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
}
function put(path, body) {
  return json(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
}
function del(path) { return json(path, { method: 'DELETE' }); }

function qs(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? ('?' + s) : '';
}

// --- auth ---
export const whoami = () => json('/api/whoami');
export const login = (username, password) => post('/api/login', { username, password });
export const logout = () => post('/api/logout');
export const logoutEverywhere = () => post('/api/logout-everywhere');

// --- config / health ---
export const fetchConfig = () => json('/api/config');
export const fetchHealth = () => json('/api/health');
export const fetchRuntime = () => json('/api/runtime');
export const fetchFleetHealth = () => json('/api/fleet-health');
export const runSweepApi = () => post('/api/sweep', {});
export const runSweep = runSweepApi;

// --- cases ---
export const fetchCases = (params) => {
  if (typeof params === 'string') return json('/api/cases' + params);
  return json('/api/cases' + qs(params));
};
export const fetchCase = (id) => json('/api/cases/' + encodeURIComponent(id));
export const fetchCaseEvents = (id, params) => {
  const q = typeof params === 'string' ? params : qs(params);
  return json('/api/cases/' + encodeURIComponent(id) + '/events' + q);
};
export const patchCaseApi = (id, body) => patch('/api/cases/' + encodeURIComponent(id), body);
export const postTransition = (id, to, reason) => post('/api/cases/' + encodeURIComponent(id) + '/transition', { to, reason });
export const postSnooze = (id, minutes) => post('/api/cases/' + encodeURIComponent(id) + '/snooze', { minutes });
export const postNote = (id, text, field) => post('/api/cases/' + encodeURIComponent(id) + '/note', field ? { text, field } : { text });
export const postFlagReply = (id, eventId, reason) => post('/api/cases/' + encodeURIComponent(id) + '/flag-reply', { event_id: eventId, reason });
export const postIntake = (id, fieldOrBody, value) => {
  const body = (value !== undefined) ? { field: fieldOrBody, value } : fieldOrBody;
  return post('/api/cases/' + encodeURIComponent(id) + '/intake', body);
};
export const postMerge = (id, targetId, reason) => post('/api/cases/' + encodeURIComponent(id) + '/merge', { target_id: targetId, into: targetId, reason });
export const postSplit = (id, bodyOrEventIds, subject, reason) => {
  const body = (subject !== undefined) ? { event_ids: bodyOrEventIds, subject, reason } : bodyOrEventIds;
  return post('/api/cases/' + encodeURIComponent(id) + '/split', body);
};
export const postUndo = (id) => post('/api/cases/' + encodeURIComponent(id) + '/undo', {});
export const postDraftApprove = (id, text) => post('/api/cases/' + encodeURIComponent(id) + '/draft/approve', text != null && typeof text !== 'object' ? { text } : (text || {}));
export const postDraftDiscard = (id) => post('/api/cases/' + encodeURIComponent(id) + '/draft/discard', {});
export const fetchSuggestions = (id) => json('/api/cases/' + encodeURIComponent(id) + '/suggestions');
export const fetchSiteHistory = (id) => json('/api/cases/' + encodeURIComponent(id) + '/site-history');
export const postBulk = (ids, action, extra) => post('/api/cases/bulk', Object.assign({ ids, action }, extra || {}));
export const createCase = (body) => post('/api/cases', body);
export const postClaim = (id) => post('/api/cases/bulk', { ids: [id], action: 'claim' });
export const postDispatch = (id, body) => post('/api/cases/' + encodeURIComponent(id) + '/dispatch', body);

// --- attention / stats / thresholds ---
export const fetchAttention = (params) => json('/api/attention' + qs(params));
export const fetchStats = () => json('/api/stats');
export const fetchThresholds = () => json('/api/thresholds');
export const putThresholds = (body) => put('/api/thresholds', body);

// --- reports / analytics ---
export const fetchOverview = (days) => json('/api/overview' + qs({ days }));
export const fetchReportJson = (days) => json('/api/report.json' + (days ? ('?days=' + days) : ''));
export const fetchSlaAtRiskByType = () => json('/api/sla-at-risk/by-type');
export const fetchClusters = () => json('/api/clusters');
export const fetchGeo = () => json('/api/geo');
export const fetchDistribution = () => json('/api/distribution');
export const fetchActivity = (params) => json('/api/activity' + qs(params));
export const fetchHandover = () => json('/api/handover');
export const postStartShift = () => post('/api/handover/start-shift', {});
export const fetchUnreplied = () => json('/api/unreplied');
export const fetchOperatorWorkload = () => json('/api/operators/workload');

// --- map ---
export const fetchMapCases = (params) => json('/api/map/cases' + qs(params));
export const fetchMapWorkers = () => json('/api/map/workers');
export const fetchMapLastReports = () => json('/api/map/last-reports');
export const fetchOperatorIdentities = () => json('/api/operators/identities');

// --- contacts / reporters ---
export const fetchContacts = () => json('/api/contacts');
export const postContactTier = (id, tier) => post('/api/contacts/' + encodeURIComponent(id) + '/tier', { tier });
export const postContactErase = (id, reason) => post('/api/contacts/' + encodeURIComponent(id) + '/erase', { reason });

// --- accounts (admin) ---
export const fetchAccounts = () => json('/api/accounts');
export const postAccount = (body) => post('/api/accounts', body);
export const deleteAccount = (id) => del('/api/accounts/' + encodeURIComponent(id));

// --- degraded turns ---
export const fetchDegradedTurns = (params) => json('/api/turns/degraded' + qs(params));
