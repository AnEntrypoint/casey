// fetch wrapper + the named endpoint functions used across the app. Thin
// one-line-per-endpoint wrappers around the shared api() call, no logic.
// Every request carries credentials:'include' (session cookie), throws a
// typed ApiError on non-2xx, and toggles the connection-lost banner via
// state.js on network failure vs success.
//
// Every endpoint function any consumer module imports must be present here and
// must name a route that really exists in src/dashboard/routes/*.js.

import { state, setConnLost } from './state.js';

export class ApiError extends Error {
  constructor(status, body) {
    super((body && (body.error || body.message)) || ('request failed: ' + status));
    this.status = status;
    this.body = body;
  }
}

// ---- offline vs unauthorized -------------------------------------------
//
// These are two different facts and the SPA used to render both as a login
// form. The service worker (src/dashboard/server.js's /sw.js route) already
// tells them apart: an /api/ request it cannot put on the wire is answered
// with 503 {"error":"offline"}, while a real server that is reachable and
// says no answers 401 {"error":"unauthorized"}. The SPA simply never looked.
//
// The subtle half is that the 503 comes back as a RESOLVED fetch. The naive
// reading -- "fetch resolved, therefore we are connected" -- is exactly
// backwards under a warm service worker: the request never left the device.
// So `api()` cannot decide connection health from the promise settling; it
// has to read the envelope.
const OFFLINE_ENVELOPE = /"error"\s*:\s*"offline"/;

async function isOfflineResponse(res) {
  if (!res || res.status !== 503) return false;
  try { return OFFLINE_ENVELOPE.test(await res.clone().text()); } catch { return false; }
}

// True when a thrown error means "this request never reached the origin",
// false when it means "the origin answered and said no". An ApiError carries
// the server's own status/body, so 401/403 are decided on evidence and never
// mistaken for a dropped link. Anything that is NOT an ApiError came out of
// `api()`'s own fetch rejection, which by definition never reached anyone.
export function isOfflineError(e) {
  if (e instanceof ApiError) return e.status === 503 && !!(e.body && e.body.error === 'offline');
  return true;
}

// Fires on the connLost true -> false EDGE, so a session restored from the
// last-known cache can re-verify itself against the real server the moment
// the link comes back, with no page reload. auth.js is the only subscriber.
const restoredListeners = new Set();
export function onConnectionRestored(fn) {
  restoredListeners.add(fn);
  return () => restoredListeners.delete(fn);
}

export async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, Object.assign({ credentials: 'include' }, opts));
  } catch (e) {
    setConnLost(true);
    throw e;
  }
  if (await isOfflineResponse(res)) {
    setConnLost(true);
    return res;
  }
  // Stamped only here, on a response that provably came from the origin: the
  // rejection above never left the device and the 503 envelope never left the
  // service worker, so neither is evidence of contact.
  lastContactAt = Date.now();
  const wasLost = state.connLost;
  setConnLost(false);
  if (wasLost) {
    for (const fn of restoredListeners) {
      try { fn(); } catch { /* a listener must never break a live request */ }
    }
  }
  return res;
}

// ---- connection watch ---------------------------------------------------
//
// "Connected" is only as true as the last response that actually reached the
// origin. Failure is otherwise noticed as a SIDE EFFECT of a scheduled data
// poll, so between polls the status bar keeps asserting a link nothing has
// tested -- on the map home view the 5s case poll is suppressed and the
// fastest detector is the 15s health poll, and a tab whose timers the browser
// has coalesced or suspended has no detector at all. This bounds that window;
// it fetches no data of its own.
//
// Three inputs, cheapest first:
//   1. The browser's own offline/online events -- free, instant, and the right
//      signal for the interface-level drop this deployment's link produces.
//      They do NOT fire when the interface is up and the server is
//      unreachable, which is why the other two exist.
//   2. Becoming visible again. A backgrounded tab (a phone in a pocket) has
//      its timers throttled, so the polls that would have caught the outage
//      may simply not have run; an operator waking the screen must never be
//      greeted by a "Connected" nothing has re-tested.
//   3. A quiet-link probe. /api/ready is ungated and 39 bytes of body, and
//      fires only after QUIET_MS with nothing reaching the origin, so the
//      app's own polls keep it silent on a healthy link -- about one probe per
//      health-poll cycle, against the several MB/hour that polling already
//      costs on this metered link. While the link is down it is also the
//      recovery detector, which is why PROBE_MIN_GAP_MS is short: the banner
//      clears within seconds of the link returning instead of within a poll.
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
  // api() owns both edges: a rejection or the worker's 503 envelope raises the
  // banner, a real response clears it and fires the restored listeners.
  try { await api('/api/ready', { cache: 'no-store' }); } catch { /* api() recorded it */ }
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

// ---- last-known values --------------------------------------------------
//
// Only the two things an operator's screen is a lie without when the link is
// down: WHO they are, and WHOSE deployment this is. Case data is deliberately
// NOT cached here -- it stays in memory for the life of the page (the panels
// keep their last successful load and the status bar says so), and persisting
// live case rows to localStorage on a shared field device is a different
// decision with its own retention argument, not a side effect of this fix.
const LAST_KNOWN_PREFIX = 'casey_last_known_';

function readLastKnown(key) {
  try {
    const raw = localStorage.getItem(LAST_KNOWN_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function writeLastKnown(key, value) {
  try { localStorage.setItem(LAST_KNOWN_PREFIX + key, JSON.stringify(value)); } catch { /* private mode / quota */ }
}
function clearLastKnown(key) {
  try { localStorage.removeItem(LAST_KNOWN_PREFIX + key); } catch { /* private mode */ }
}

// The last session the SERVER confirmed. auth.js assumes it only when the
// failure is specifically offline, never on a 401 -- see checkSession().
export function lastKnownSession() { return readLastKnown('whoami'); }
export function forgetLastKnownSession() { clearLastKnown('whoami'); }

async function json(path, opts) {
  const r = await api(path, opts);
  let body = null;
  try { body = await r.json(); } catch { /* no body */ }
  if (!r.ok) throw new ApiError(r.status, body);
  return body;
}

// ---- conditional GET ----------------------------------------------------
//
// The polled read endpoints ARE the standing cost of leaving this dashboard
// open on the metered rural link AGENTS.md says this deployment targets, and
// almost none of that traffic carries news: this deployment's own event log
// holds 136 events across 322 hours, and 313 of those hours contain no event
// at all.
//
// The server has always answered a conditional GET correctly. Express stamps a
// weak ETag on every res.json body and answers a matching If-None-Match with a
// bodyless 304, and server.js's gzip middleware skips a 304 deliberately since
// there is no body to compress. Measured at the socket with a counting proxy
// in front of the real dashboard: /api/cases costs 3839 wire bytes as a 200
// (2890 gzipped body + 659 request headers + 290 response headers) and 929 as
// a 304.
//
// What is NOT true is that a browser would never do this by itself. Chrome
// does: it revalidates these responses heuristically and was already getting
// 304s back. It is just not a contract. Which polls reach the network at all
// is browser-internal -- in the measured window roughly one in three did, the
// rest absorbed by Chrome's own in-memory cache -- it differs between
// browsers, and none of it is observable from here. This module needs the
// answer itself, because main.js's poll ladder is driven by whether the list
// changed. So the revalidation is explicit: keep the ETag and the parsed body
// of the last 200, send If-None-Match on the next poll, and resolve a 304 to
// the remembered body.
//
// A 304 is the server ASSERTING that the representation is unchanged, so a
// caller rendering the remembered body is exactly as current as it would have
// been with a 200 -- this cannot make a stale list look fresh. What it cannot
// do is survive a shape change: the entry is dropped on any non-2xx, on a
// response with no ETag, and on logout (clearConditionalCache).
const condCache = new Map();
export function clearConditionalCache() { condCache.clear(); }

async function conditional(path) {
  const prev = condCache.get(path);
  const r = await api(path, prev ? { headers: { 'if-none-match': prev.etag } } : {});
  if (r.status === 304 && prev) return { body: prev.body, unchanged: true };
  let body = null;
  try { body = await r.json(); } catch { /* no body */ }
  if (!r.ok) { condCache.delete(path); throw new ApiError(r.status, body); }
  const etag = r.headers.get('etag');
  if (etag) condCache.set(path, { etag, body }); else condCache.delete(path);
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

// --- auth ---
// The one endpoint whose answer has to survive a dropped link: a confirmed
// session is remembered so `auth.js` can keep an operator signed in through
// an outage instead of showing them a login form they have no network to
// complete. A server that ANSWERS and says "not authed" clears it -- the
// cache only ever survives a failure to reach the server at all.
export const whoami = async () => {
  const j = await json('/api/whoami');
  if (j && j.authed) writeLastKnown('whoami', j); else clearLastKnown('whoami');
  return j;
};
// Both ends of a session drop the conditional-GET entries: what one operator's
// session revalidated against must never be handed to the next one's as a
// remembered body, and a fresh login must re-fetch rather than 304 against
// whatever the previous session last saw.
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

// --- config / health ---
// Cached last-known, for the same reason whoami is: with the link down this
// throws, main.js's loadCaseyConfig() swallows it, and state.config stays
// null -- which renders the deployment's own dashboard under casey's literal
// 'casey' branding. A deployment reverting to another product's name is not a
// cosmetic degradation; it is the screen telling the operator they are
// somewhere else.
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
// Ungated (unlike fetchConfig) -- see routes/auth.js's /api/branding header
// comment. Called pre-login so login-gate.js can show a deployment's real
// brand/leaf instead of the literal 'casey' fallback. Never throws: a
// network failure now falls back to the last branding this device actually
// saw, and only to casey's own literals when it has never seen any.
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
// Per-run config override -- only reachable on a deployment that mounted
// CASEY_EXTRA_DASHBOARD_ROUTES (e.g. serpent). A plain casey/uhh deployment
// has no /api/runs/:id/config route, so this always resolves null there
// (never throws) -- report-sections.js falls back to the global fetchConfig()
// result exactly as before. See AGENTS.md's CASEY_EXTRA_DASHBOARD_ROUTES entry.
export const fetchRunConfig = async (id) => {
  try {
    const r = await api('/api/runs/' + encodeURIComponent(id) + '/config');
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
};
// Per-run research notes -- same degrade discipline as fetchRunConfig above:
// only reachable on a deployment that mounted CASEY_EXTRA_DASHBOARD_ROUTES
// (e.g. serpent). Resolves null on a plain casey/uhh deployment (no
// /api/runs/:id/notes route) or a network failure, never throws --
// research-notes.js's panel renders nothing in that case.
export const fetchRunNotes = async (id) => {
  try {
    const r = await api('/api/runs/' + encodeURIComponent(id) + '/notes');
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
};
// All three are polled every 15s and all three have byte-stable bodies on an
// unchanged deployment (measured: 965 B, 78 B and 241 B on the wire, same ETag
// across polls), so they revalidate rather than re-download. Same shape out as
// before -- a 304 resolves to the remembered body.
export const fetchHealth = () => condBody('/api/health');
export const fetchRuntime = () => condBody('/api/runtime');
export const fetchFleetHealth = () => condBody('/api/fleet-health');
export const runSweepApi = () => post('/api/sweep', {});
export const runSweep = runSweepApi;

// --- cases ---
const casesPath = (params) => '/api/cases' + (typeof params === 'string' ? params : qs(params));
export const fetchCases = (params) => condBody(casesPath(params));
// The polling form. Same request as fetchCases -- it shares the same ETag
// entry -- but it also reports whether the server answered 304, which is the
// only honest signal available for "nothing has happened since last time".
// main.js uses it to widen the poll interval while nothing is changing.
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
export const fetchSecretaryQueue = (params) => json('/api/secretary/queue' + qs(params));

// --- map ---
// Polled every 30s while the map home view is showing, and byte-stable
// between polls (measured 1717 B on the wire, same ETag), so it revalidates.
export const fetchMapCases = (params) => condBody('/api/map/cases' + qs(params));
export const fetchMapWorkers = () => json('/api/map/workers');
export const fetchMapLastReports = () => json('/api/map/last-reports');
export const fetchOperatorIdentities = () => json('/api/operators/identities');

// --- contacts / reporters ---
export const fetchContacts = () => json('/api/contacts');
export const postContactTier = (id, tier) => post('/api/contacts/' + encodeURIComponent(id) + '/tier', { tier });
export const postContactErase = (id, reason) => post('/api/contacts/' + encodeURIComponent(id) + '/erase', { reason });

// --- degraded turns ---
export const fetchDegradedTurns = (params) => json('/api/turns/degraded' + qs(params));
