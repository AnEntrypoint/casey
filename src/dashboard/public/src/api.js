import { state, setConnLost } from './state.js';

export class ApiError extends Error {
  constructor(status, body) {
    super((body && (body.error || body.message)) || ('request failed: ' + status));
    this.status = status;
    this.body = body;
  }
}

const OFFLINE_ENVELOPE = /"error"\s*:\s*"offline"/;

async function isOfflineResponse(res) {
  if (!res || res.status !== 503) return false;
  try { return OFFLINE_ENVELOPE.test(await res.clone().text()); } catch { return false; }
}

export function isOfflineError(e) {
  if (e instanceof ApiError) return e.status === 503 && !!(e.body && e.body.error === 'offline');
  return true;
}

const restoredListeners = new Set();
const sessionLostListeners = new Set();
export function onSessionLost(fn) {
  sessionLostListeners.add(fn);
  return () => sessionLostListeners.delete(fn);
}
export function onConnectionRestored(fn) {
  restoredListeners.add(fn);
  return () => restoredListeners.delete(fn);
}

const FETCH_TIMEOUT_MS = 20000;

const VIEW_AS_KEY = 'casey.viewAs';
export function viewAsId() { try { return sessionStorage.getItem(VIEW_AS_KEY) || ''; } catch { return ''; } }
export function setViewAs(id) {
  try { if (id) sessionStorage.setItem(VIEW_AS_KEY, id); else sessionStorage.removeItem(VIEW_AS_KEY); } catch {  }
  clearConditionalCache();
  clearLastKnown('whoami');
  location.hash = '';
  location.reload();
}

export async function api(path, opts = {}) {
  let res;
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), FETCH_TIMEOUT_MS);
  const passedSignal = opts.signal;
  let onAbort = null;
  const signal = passedSignal
    ? (() => {
        const merged = new AbortController();
        if (passedSignal.aborted) { merged.abort(); return merged.signal; }
        onAbort = () => merged.abort();
        passedSignal.addEventListener('abort', onAbort);
        timeoutController.signal.addEventListener('abort', onAbort);
        return merged.signal;
      })()
    : timeoutController.signal;
  try {
    const viewAs = viewAsId();
    const headers = viewAs ? Object.assign({}, opts.headers || {}, { 'x-view-as': viewAs }) : opts.headers;
    res = await fetch(path, Object.assign({ credentials: 'include' }, opts, headers ? { headers } : {}, { signal }));
  } catch (e) {
    setConnLost(true);
    throw e;
  } finally {
    clearTimeout(timeoutId);
    if (onAbort) {
      passedSignal.removeEventListener('abort', onAbort);
      timeoutController.signal.removeEventListener('abort', onAbort);
    }
  }
  if (await isOfflineResponse(res) || res.status >= 500) {
    setConnLost(true);
    return res;
  }
  if (res.status === 401 && !/^\/api\/(login|logout|whoami|ready|branding|change-password)/.test(String(path))) {
    for (const fn of sessionLostListeners) { try { fn(); } catch {  } }
  }
  lastContactAt = Date.now();
  const wasLost = state.connLost;
  setConnLost(false);
  if (wasLost) {
    for (const fn of restoredListeners) {
      try { fn(); } catch {  }
    }
  }
  return res;
}

const QUIET_MS = 8000;
const PROBE_MIN_GAP_MS = 4000;
const WATCH_TICK_MS = 2000;
let lastContactAt = Date.now();
let lastProbeAt = 0;
let probing = false;

async function probeConnection() {
  if (probing) return;
  probing = true;
  lastProbeAt = Date.now();
  try { await api('/api/ready', { cache: 'no-store' }); } catch {  }
  probing = false;
}

export function startConnectionWatch() {
  const tick = setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    if (Date.now() - lastContactAt < QUIET_MS) return;
    if (Date.now() - lastProbeAt < PROBE_MIN_GAP_MS) return;
    probeConnection();
  }, WATCH_TICK_MS);
  window.addEventListener('offline', () => setConnLost(true));
  window.addEventListener('online', probeConnection);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') probeConnection();
  });
  return () => clearInterval(tick);
}

const LAST_KNOWN_PREFIX = 'casey_last_known_';

function readLastKnown(key) {
  try {
    const raw = localStorage.getItem(LAST_KNOWN_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function writeLastKnown(key, value) {
  try { localStorage.setItem(LAST_KNOWN_PREFIX + key, JSON.stringify(value)); } catch {  }
}
function clearLastKnown(key) {
  try { localStorage.removeItem(LAST_KNOWN_PREFIX + key); } catch {  }
}

export function lastKnownSession() { return readLastKnown('whoami'); }
export function forgetLastKnownSession() { clearLastKnown('whoami'); }

async function json(path, opts) {
  const r = await api(path, opts);
  let body = null;
  try { body = await r.json(); } catch {  }
  if (!r.ok) throw new ApiError(r.status, body);
  return body;
}

const condCache = new Map();
const CONDITIONAL_CACHE_MAX = 20;
export function clearConditionalCache() { condCache.clear(); }
function rememberConditional(path, entry) {
  condCache.delete(path);
  condCache.set(path, entry);
  while (condCache.size > CONDITIONAL_CACHE_MAX) condCache.delete(condCache.keys().next().value);
}

export async function conditional(path) {
  const prev = condCache.get(path);
  const r = await api(path, prev ? { headers: { 'if-none-match': prev.etag } } : {});
  if (r.status === 304 && prev) { rememberConditional(path, prev); return { body: prev.body, unchanged: true }; }
  let body = null, parsed = false;
  try { body = await r.json(); parsed = true; } catch {  }
  if (!r.ok) { condCache.delete(path); throw new ApiError(r.status, body); }
  const etag = r.headers.get('etag');
  if (etag && parsed) rememberConditional(path, { etag, body }); else condCache.delete(path);
  return { body, unchanged: false };
}
const condBody = async (path) => (await conditional(path)).body;
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

export const whoami = async () => {
  const j = await json('/api/whoami');
  if (j && j.authed) writeLastKnown('whoami', j); else clearLastKnown('whoami');
  return j;
};
export const login = async (username, password) => {
  clearConditionalCache();
  return post('/api/login', { username, password });
};
export const logout = async () => {
  clearLastKnown('whoami');
  clearConditionalCache();
  return post('/api/logout');
};
export const logoutEverywhere = () => post('/api/logout-everywhere');

export const fetchConfig = async () => {
  try {
    const cfg = await json('/api/config');
    if (cfg) writeLastKnown('config', cfg);
    return cfg;
  } catch (e) {
    if (isOfflineError(e)) {
      const cached = readLastKnown('config');
      if (cached) return cached;
    }
    throw e;
  }
};
const cachedBranding = () => {
  const b = readLastKnown('branding');
  if (b && (b.brand || b.leaf)) return b;
  const cfg = readLastKnown('config');
  const ui = cfg && cfg.dashboard_ui;
  return ui && (ui.brand || ui.leaf) ? ui : null;
};
export const fetchBranding = async () => {
  try {
    const r = await api('/api/branding');
    if (!r.ok) return cachedBranding();
    const b = await r.json();
    if (b && (b.brand || b.leaf)) writeLastKnown('branding', b);
    return b;
  } catch { return cachedBranding(); }
};
const absentRunRoutes = new Set();

async function optionalRunRoute(kind, id) {
  if (absentRunRoutes.has(kind)) return null;
  const cfg = readLastKnown('config');
  if (cfg && cfg.run_routes === false) return null;
  try {
    const r = await api('/api/runs/' + encodeURIComponent(id) + '/' + kind);
    if (r.status === 404) { absentRunRoutes.add(kind); return null; }
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export const fetchRunConfig = (id) => optionalRunRoute('config', id);
export const fetchRunNotes = (id) => optionalRunRoute('notes', id);
export const fetchHealth = () => condBody('/api/health');
export const fetchRuntime = () => condBody('/api/runtime');
export const fetchFleetHealth = () => condBody('/api/fleet-health');
export const runSweepApi = () => post('/api/sweep', {});
export const runSweep = runSweepApi;

const casesPath = (params) => '/api/cases' + (typeof params === 'string' ? params : qs(params));
export const fetchCases = (params) => condBody(casesPath(params));
export const pollCases = (params) => conditional(casesPath(params));
export const fetchCase = (id) => json('/api/cases/' + encodeURIComponent(id));
export const fetchCaseEvents = (id, params) => {
  const q = typeof params === 'string' ? params : qs(params);
  return json('/api/cases/' + encodeURIComponent(id) + '/events' + q);
};
export const patchCaseApi = (id, body) => patch('/api/cases/' + encodeURIComponent(id), body);
export const postTransition = (id, to, reason) => post('/api/cases/' + encodeURIComponent(id) + '/transition', { to, reason });
export const postSnooze = (id, minutes) => post('/api/cases/' + encodeURIComponent(id) + '/snooze', { minutes });
export const postNote = (id, text, field) => post('/api/cases/' + encodeURIComponent(id) + '/note', field ? { text, field } : { text });
export const postTranslateEvent = (id, eventId, ref) => post('/api/cases/' + encodeURIComponent(id) + '/events/' + encodeURIComponent(eventId) + '/translate', ref ? { expected_ref: ref } : {});
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
export const postDraftApprove = (id, text) => post('/api/cases/' + encodeURIComponent(id) + '/draft/approve', text != null && typeof text !== 'object' ? { text } : (text || {}));
export const postDraftDiscard = (id) => post('/api/cases/' + encodeURIComponent(id) + '/draft/discard', {});
export const postInstruct = (id, instruction, expectedRef) => post('/api/cases/' + encodeURIComponent(id) + '/instruct', expectedRef ? { instruction, expected_ref: expectedRef } : { instruction });
export const postCaseRemind = (id, text) => post('/api/cases/' + encodeURIComponent(id) + '/remind', text != null && String(text).trim() ? { text } : {});
export const fetchSuggestions = (id) => json('/api/cases/' + encodeURIComponent(id) + '/suggestions');
export const fetchSiteHistory = (id) => json('/api/cases/' + encodeURIComponent(id) + '/site-history');
export const postBulk = (ids, action, extra) => post('/api/cases/bulk', Object.assign({ ids, action }, extra || {}));
export const createCase = (body) => post('/api/cases', body);
export const postClaim = (id) => post('/api/cases/bulk', { ids: [id], action: 'claim' });
export const postDispatch = (id, body) => post('/api/cases/' + encodeURIComponent(id) + '/dispatch', body);

export const fetchAttention = (params) => json('/api/attention' + qs(params));
export const pollAttention = (params) => conditional('/api/attention' + qs(params));
export const fetchStats = () => json('/api/stats');
export const fetchThresholds = () => json('/api/thresholds');
export const putThresholds = (body) => put('/api/thresholds', body);

export const fetchOverview = (days) => json('/api/overview' + qs({ days }));
export const fetchReportJson = (days) => json('/api/report.json' + (days ? ('?days=' + days) : ''));
export const fetchSlaAtRiskByType = () => json('/api/sla-at-risk/by-type');
export const fetchClusters = () => json('/api/clusters');
export const fetchGeo = () => json('/api/geo');
export const fetchDistribution = () => json('/api/distribution');
export const fetchFieldValues = (field) => json('/api/field-values?field=' + encodeURIComponent(field));
export const postCanonicalizeValue = (field, value) => post('/api/field-values/canonicalize', { field, value });
export const fetchActivity = (params) => json('/api/activity' + qs(params));
export const fetchHandover = () => json('/api/handover');
export const postStartShift = () => post('/api/handover/start-shift', {});

export const fetchExternalLinks = (status) => json('/api/external-links' + (status ? '?status=' + encodeURIComponent(status) : ''));
export const postExternalLinkConfirm = (id) => post('/api/external-links/' + encodeURIComponent(id) + '/confirm', {});
export const postExternalLinkReject = (id) => post('/api/external-links/' + encodeURIComponent(id) + '/reject', {});
export const fetchUnreplied = () => json('/api/unreplied');
export const fetchOperatorWorkload = () => json('/api/operators/workload');
export const fetchSecretaryQueue = (params) => json('/api/secretary/queue' + qs(params));

export const fetchMapCases = (params) => condBody('/api/map/cases' + qs(params));
export const pollMapCases = (params) => conditional('/api/map/cases' + qs(params));
export const fetchMapWorkers = () => json('/api/map/workers');
export const fetchMapLastReports = () => json('/api/map/last-reports');
export const fetchOperatorIdentities = () => json('/api/operators/identities');

export const fetchContacts = (params) => json('/api/contacts' + qs(params));
export const postContactTier = (id, tier) => post('/api/contacts/' + encodeURIComponent(id) + '/tier', { tier });
export const postContactErase = (id, reason) => post('/api/contacts/' + encodeURIComponent(id) + '/erase', { reason });

export const fetchPersons = (contactId) => json('/api/contacts/' + encodeURIComponent(contactId) + '/persons');
export const postPersonRename = (contactId, body) => post('/api/contacts/' + encodeURIComponent(contactId) + '/persons/rename', body);
export const postPersonMerge = (contactId, body) => post('/api/contacts/' + encodeURIComponent(contactId) + '/persons/merge', body);
export const postPersonErase = (contactId, body) => post('/api/contacts/' + encodeURIComponent(contactId) + '/persons/erase', body);

export const fetchDegradedTurns = (params) => json('/api/turns/degraded' + qs(params));
export const pollDegradedTurns = (params) => conditional('/api/turns/degraded' + qs(params));
export const postContactRegister = (phone, name, tier) => post('/api/contacts/register', { phone, name, tier });

export const fetchRoleInvites = () => json('/api/role-invites');
export const postRoleInvite = (body) => post('/api/role-invites', body);
export const deleteRoleInvite = (id) => del('/api/role-invites/' + encodeURIComponent(id));
