import { state, setFilt, setInboxMode } from './state.js';

function fvOf(raw) {
  const out = {};
  for (const [k, v] of Object.entries((raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {})) {
    if (typeof v === 'string' && v) out[k] = v;
  }
  return out;
}

export function currentView() {
  const f = state.filt;
  return { q: f.q || '', status: f.status || '', channel: f.channel || '', source: f.source || '', fv: fvOf(f.fv), mine: !!f.mine, focus: !!state.inboxMode };
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
  setFilt({ q: String(v.q || ''), status: String(v.status || ''), channel: String(v.channel || ''), source: String(v.source || ''), fv: fvOf(v.fv), mine: !!v.mine });
  setInboxMode(!!v.focus);
}


function loadNamedViews() {
  try { const o = JSON.parse(localStorage.casey_views || '{}'); return (o && typeof o === 'object') ? o : {}; }
  catch { return {}; }
}
function saveNamedViews(m) { try { localStorage.casey_views = JSON.stringify(m); } catch {  } }

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
export function listNamedViews() {
  return Object.keys(loadNamedViews()).sort();
}

export function saveCurrentView(name) {
  if (!name || !name.trim()) return { ok: false, error: 'Name is required.' };
  const ok = saveNamedView(name.trim(), currentView());
  return ok ? { ok: true } : { ok: false, error: 'Could not save that view (name too long?).' };
}
export function applyNamedView(name) {
  const v = getNamedView(name);
  if (v) applyView(v);
}

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
  try { localStorage.casey_recent_searches = JSON.stringify(arr); } catch {  }
}
