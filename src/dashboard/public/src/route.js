// Deep-link + hash-state sync: #home=<map|cases>, #case=<id>, #ref=<ref>,
// #inbox, #view=<b64>.
// pushHash(partial) writes back without a full reload, preserving whichever
// other hash tokens are already present. No secrets ever ride the hash --
// auth is the session cookie, so a shared link grants nothing on its own: the
// recipient still has to be a logged-in operator, and sees exactly the cases
// their own session is entitled to.
//
// `home` is here because the home view became the primary axis of the UI when
// the map became the landing surface. It was persisted to localStorage only,
// which meant the one thing this dashboard exists to do -- hand a situation to
// another person, the same job its Shift handover panel does -- could not be
// done with a link: "look at the map" was not expressible in a URL, and the
// browser back button could not undo a view switch.

import { state, setActiveId, setInboxMode, setHomeView } from './state.js';

function parseHash() {
  const raw = (location.hash || '').replace(/^#/, '');
  const parts = raw.split('&').filter(Boolean);
  const out = { caseId: null, ref: null, inbox: false, view: null, home: null };
  for (const p of parts) {
    if (p === 'inbox') out.inbox = true;
    else if (p.startsWith('case=')) out.caseId = decodeURIComponent(p.slice(5));
    else if (p.startsWith('ref=')) out.ref = decodeURIComponent(p.slice(4));
    else if (p.startsWith('view=')) out.view = p.slice(5);
    else if (p.startsWith('home=')) out.home = p.slice(5) === 'cases' ? 'cases' : 'map';
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
  if (next.home) tokens.push('home=' + next.home);
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
  // home first: setHomeView clears activePanel/activeModal, so applying it
  // after the case id would be harmless today but is exactly the ordering trap
  // that makes a later addition to setHomeView silently clobber a deep link.
  if (r.home) setHomeView(r.home);
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
// The routed way to switch home view -- same shape as openCaseRoute above.
// Every nav/UI caller uses this; setHomeView() alone remains the unrouted
// primitive the route layer itself calls when APPLYING a hash.
export function setHomeViewRoute(v) {
  const home = v === 'cases' ? 'cases' : 'map';
  pushHash({ home });
  setHomeView(home);
}
