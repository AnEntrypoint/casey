// Saved-view CRUD (localStorage) + base64url URL-hash encode/decode. A view
// is filter knobs only -- never external_id. Also owns the recent-search
// ring buffer (ux-search-hint-and-history).

import { state, setFilt, setInboxMode } from './state.js';

export function currentView() {
  const f = state.filt;
  return { q: f.q || '', status: f.status || '', channel: f.channel || '', source: f.source || '', mine: !!f.mine, focus: !!state.inboxMode };
}

// Reader only. There was an encodeView() beside this, exported and called by
// nothing anywhere in the tree (checked against every js/html/json file under
// deps/casey, freddie-bundle included, plus every dynamic-import and
// string-keyed reach in the SPA) -- so no surface ever produced a #view= link
// and the encoder was one half of a feature that was never wired up. The
// decoder stays: main.js reads the token on boot, so a link that does exist
// still opens the view it names.
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


function loadNamedViews() {
  try { const o = JSON.parse(localStorage.casey_views || '{}'); return (o && typeof o === 'object') ? o : {}; }
  catch { return {}; }
}
function saveNamedViews(m) { try { localStorage.casey_views = JSON.stringify(m); } catch { /* storage unavailable */ } }

export function saveNamedView(name, view) {
  if (!name || name.length > 60) return false;
  const m = loadNamedViews();
  m[name] = view;
  saveNamedViews(m);
  return true;
}
export function getNamedView(name) {
  const m = loadNamedViews();
  return m[name] || null;
}
// The names to offer in the Saved views menu, read from the store that
// saveNamedView actually writes. The menu used to list Object.keys of
// state.savedViews -- a field state.js initialised to [] and NOTHING in the
// SPA ever wrote -- so saving a view popped a toast saying it was saved and
// the view then never appeared in the list it was saved into. Same shape of
// write-only feature as the recent-search buffer that filters-bar.js already
// had to repoint at this module.
export function listNamedViews() {
  return Object.keys(loadNamedViews()).sort();
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
