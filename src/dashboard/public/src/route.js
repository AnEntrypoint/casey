// Deep-link + hash-state sync: #case=<id>, #ref=<ref>, #inbox, #view=<b64>.
// pushHash(partial) writes back without a full reload, preserving whichever
// other hash tokens are already present. No secrets ever ride the hash --
// auth is the session cookie.

import { state, setActiveId, setInboxMode } from './state.js';

function parseHash() {
  const raw = (location.hash || '').replace(/^#/, '');
  const parts = raw.split('&').filter(Boolean);
  const out = { caseId: null, ref: null, inbox: false, view: null };
  for (const p of parts) {
    if (p === 'inbox') out.inbox = true;
    else if (p.startsWith('case=')) out.caseId = decodeURIComponent(p.slice(5));
    else if (p.startsWith('ref=')) out.ref = decodeURIComponent(p.slice(4));
    else if (p.startsWith('view=')) out.view = p.slice(5);
  }
  return out;
}

export function currentRoute() { return parseHash(); }

// Writes a partial route back into the hash, preserving other tokens. Pass
// `null` for a key to remove that token.
export function pushHash(partial) {
  const cur = parseHash();
  const next = Object.assign({}, cur, partial);
  const tokens = [];
  if (next.inbox) tokens.push('inbox');
  if (next.caseId) tokens.push('case=' + encodeURIComponent(next.caseId));
  if (next.ref) tokens.push('ref=' + encodeURIComponent(next.ref));
  if (next.view) tokens.push('view=' + next.view);
  const want = tokens.length ? '#' + tokens.join('&') : location.pathname + location.search;
  if (location.hash !== (tokens.length ? '#' + tokens.join('&') : '')) {
    history.replaceState(null, '', want);
  }
}

export function applyRouteToState() {
  const r = parseHash();
  if (r.caseId) setActiveId(r.caseId);
  if (r.inbox) setInboxMode(true);
  return r;
}

export function initRouteSync(onChange) {
  window.addEventListener('hashchange', () => {
    const r = parseHash();
    if (onChange) onChange(r);
  });
}

export function openCaseRoute(id) { pushHash({ caseId: id }); setActiveId(id); }
export function closeCaseRoute() { pushHash({ caseId: null }); setActiveId(null); }
