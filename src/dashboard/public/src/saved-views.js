// Saved-view CRUD (localStorage) + base64url URL-hash encode/decode. A view
// is filter knobs only -- never external_id. Also owns the recent-search
// ring buffer (ux-search-hint-and-history).

import { state, setFilt, setInboxMode } from './state.js';
import { pushHash } from './route.js';

export function currentView() {
  const f = state.filt;
  return { q: f.q || '', status: f.status || '', channel: f.channel || '', source: f.source || '', mine: !!f.mine, focus: !!state.inboxMode };
}

export function encodeView(v) {
  try { return btoa(unescape(encodeURIComponent(JSON.stringify(v)))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
  catch { return ''; }
}
export function decodeView(s) {
  try {
    const b = s.replace(/-/g, '+').replace(/_/g, '/');
    const o = JSON.parse(decodeURIComponent(escape(atob(b))));
    return (o && typeof o === 'object') ? o : null;
  } catch { return null; }
}

export function applyView(v) {
  if (!v || typeof v !== 'object') return;
  setFilt({ q: String(v.q || ''), status: String(v.status || ''), channel: String(v.channel || ''), source: String(v.source || ''), mine: !!v.mine });
  setInboxMode(!!v.focus);
}

export function writeViewToHash(v) {
  const enc = encodeView(v);
  if (enc) pushHash({ view: enc });
}

function loadNamedViews() {
  try { const o = JSON.parse(localStorage.casey_views || '{}'); return (o && typeof o === 'object') ? o : {}; }
  catch { return {}; }
}
function saveNamedViews(m) { try { localStorage.casey_views = JSON.stringify(m); } catch { /* storage unavailable */ } }

export function listNamedViews() {
  const m = loadNamedViews();
  return Object.keys(m).sort().map(name => ({ name, view: m[name] }));
}
export function saveNamedView(name, view) {
  if (!name || name.length > 60) return false;
  const m = loadNamedViews();
  m[name] = view;
  saveNamedViews(m);
  return true;
}
export function deleteNamedView(name) {
  const m = loadNamedViews();
  delete m[name];
  saveNamedViews(m);
}
export function getNamedView(name) {
  const m = loadNamedViews();
  return m[name] || null;
}

// saveCurrentView/applyNamedView -- thin convenience wrappers over the
// primitives above, matching the case-list-view.js call shape
// ({ok,error}-returning save; apply-by-name reading straight from state).
export function saveCurrentView(name) {
  if (!name || !name.trim()) return { ok: false, error: 'Name is required.' };
  const ok = saveNamedView(name.trim(), currentView());
  return ok ? { ok: true } : { ok: false, error: 'Could not save that view (name too long?).' };
}
export function applyNamedView(name) {
  const v = getNamedView(name);
  if (v) applyView(v);
}

// --- recent search history (last 8), ux-search-hint-and-history ---
export function loadRecentSearches() {
  try { const a = JSON.parse(localStorage.casey_recent_searches || '[]'); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
export function pushRecentSearch(q) {
  q = String(q || '').trim();
  if (!q) return;
  let arr = loadRecentSearches().filter(s => s !== q);
  arr.unshift(q);
  arr = arr.slice(0, 8);
  try { localStorage.casey_recent_searches = JSON.stringify(arr); } catch { /* storage unavailable */ }
}
