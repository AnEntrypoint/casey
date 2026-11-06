import { state, setActiveId, setInboxMode, setHomeView, openPanel, closePanel } from './state.js';

function parseHash() {
  const raw = (location.hash || '').replace(/^#/, '');
  const parts = raw.split('&').filter(Boolean);
  const out = { caseId: null, ref: null, inbox: false, view: null, home: null, panel: null };
  for (const p of parts) {
    if (p === 'inbox') out.inbox = true;
    else if (p.startsWith('case=')) out.caseId = decodeURIComponent(p.slice(5));
    else if (p.startsWith('ref=')) out.ref = decodeURIComponent(p.slice(4));
    else if (p.startsWith('view=')) out.view = p.slice(5);
    else if (p.startsWith('home=')) out.home = p.slice(5) === 'cases' ? 'cases' : 'map';
    else if (p.startsWith('panel=')) out.panel = decodeURIComponent(p.slice(6));
  }
  return out;
}

export function currentRoute() { return parseHash(); }

export function pushHash(partial) {
  const cur = parseHash();
  const next = Object.assign({}, cur, partial);
  const tokens = [];
  if (next.home) tokens.push('home=' + next.home);
  if (next.inbox) tokens.push('inbox');
  if (next.caseId) tokens.push('case=' + encodeURIComponent(next.caseId));
  if (next.ref) tokens.push('ref=' + encodeURIComponent(next.ref));
  if (next.view) tokens.push('view=' + next.view);
  if (next.panel) tokens.push('panel=' + encodeURIComponent(next.panel));
  const want = tokens.length ? '#' + tokens.join('&') : location.pathname + location.search;
  if (location.hash !== (tokens.length ? '#' + tokens.join('&') : '')) {
    const navigated = next.caseId !== cur.caseId || next.panel !== cur.panel || next.home !== cur.home || !!next.inbox !== !!cur.inbox;
    history[navigated ? 'pushState' : 'replaceState'](null, '', want);
  }
}

export function applyRouteToState() {
  const r = parseHash();
  if (r.home) setHomeView(r.home);
  if (r.caseId) setActiveId(r.caseId);
  if (r.inbox) setInboxMode(true);
  if (r.panel) openPanel(r.panel);
  return r;
}

export function initRouteSync(onChange) {
  window.addEventListener('hashchange', () => {
    const r = parseHash();
    if (r.panel) openPanel(r.panel);
    else closePanel();
    if (onChange) onChange(r);
  });
}

export function openCaseRoute(id) { pushHash({ caseId: id }); setActiveId(id); }
export function closeCaseRoute() { pushHash({ caseId: null }); setActiveId(null); }
export function setHomeViewRoute(v) {
  const home = v === 'cases' ? 'cases' : 'map';
  pushHash({ home });
  setHomeView(home);
}

export function openPanelRoute(name) { pushHash({ panel: name }); openPanel(name); }
export function closePanelRoute() { pushHash({ panel: null }); closePanel(); }
