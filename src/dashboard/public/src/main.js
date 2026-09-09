// Bootstrap only. Imports mountKit, state, App view; calls checkSession()
// then mountKit({root, view: App, screen:'dashboard'}); wires the one global
// keydown listener (delegates into keyboard.js) and popstate/hashchange ->
// route.js. Nothing else lives here.

import { mountKit } from 'ds/bootstrap.js';
import { state, setSchedule, setConfig, setHealth, setDegradedTurns, openModal, closeModal, openPanel, setHomeView, setActiveId, setAttention } from './state.js';
import { App, registerModalBody, registerPanelBody } from './views/app-view.js';
import { checkSession } from './auth.js';
import { installGlobalKeyboard, registerKeyboardHandlers } from './keyboard.js';
import { initRouteSync, applyRouteToState, currentRoute, closeCaseRoute } from './route.js';
import { applyView, decodeView } from './saved-views.js';
import { initTheme } from './components/account-menu.js';
import * as api from './api.js';
import { checkHandoffs, setInboxBadge, setBaseTitle } from './components/handoff-banner.js';
import { registerRefreshAll, registerOpenIntakeNew } from './views/nav-config.js';
import { openCase, closeCase, reloadCases as reloadCaseListRows, promptNewCase } from './views/case-list-detail-layout.js';

import { StatsPanel } from './panels/stats-panel.js';
import { SettingsPanel } from './panels/settings-panel.js';
import { MetricsPanel } from './panels/metrics-panel.js';
import { ClustersPanel } from './panels/clusters-panel.js';
import { DistributionPanel } from './panels/distribution-panel.js';
import { GeoPanel } from './panels/geo-panel.js';
import { visibleQueueRows, mapDebugSnapshot, refreshMapData } from './panels/map-panel.js';
import { ActivityPanel } from './panels/activity-panel.js';
import { HandoverPanel } from './panels/handover-panel.js';
import { OfflinePanel } from './panels/offline-panel.js';
import { TeamPanel } from './panels/team-panel.js';
import { ContactsPanel } from './panels/contacts-panel.js';
import { SecretaryPanel } from './panels/secretary-panel.js';

import { OnboardingOverlay, onboarded, markOnboarded } from './components/onboarding-overlay.js';
import { SkillsOverlay, skillsDismissed } from './components/skills-overlay.js';
import { HelpOverlay, helpSeen, markHelpSeen } from './components/help-overlay.js';

const root = document.getElementById('app');
const { render, schedule } = mountKit({ root, view: App, screen: 'dashboard' });
setSchedule(schedule);

initTheme();

// Content-swap panels -- each is a working surface an operator reads/acts on
// for a stretch; registered once here per architecture spec section 4.
//
// 'map' is deliberately NOT among them any more. It used to be, and boot()
// below routed the map-first deployment into it, which meant a real uhh
// operator's landing page was the legacy stacked map panel rather than the
// map-first command centre -- the whole restructure was shipped and then
// bypassed. The map is a home view now (state.homeView), not a panel.
//
// 'clusters' and 'geo' are the two SPATIAL rollups and they render in the map
// rail with the map still mounted beside them (map-panel.js's RAIL_MODES), so
// the map is never unmounted to answer a question about where something is.
// They stay registered here even though no control currently opens either as a
// full page -- both nav items go through openOnMap() -- so that anything that
// does set activePanel to one of them gets the real body rather than the
// "not available in this deployment" page.
registerPanelBody('metrics', MetricsPanel);
registerPanelBody('clusters', ClustersPanel);
registerPanelBody('distribution', DistributionPanel);
registerPanelBody('geo', GeoPanel);
registerPanelBody('activity', ActivityPanel);
registerPanelBody('handover', HandoverPanel);
registerPanelBody('offline', OfflinePanel);
registerPanelBody('team', TeamPanel);
registerPanelBody('contacts', ContactsPanel);
registerPanelBody('secretary', SecretaryPanel);

// Dialog-shaped modals (settings/stats are quick-glance overlays that never
// displace the case queue; help/onboarding/skills share the same Dialog
// primitive) -- one modal-rendering code path in app-view.js.
registerModalBody('stats', StatsPanel);
registerModalBody('settings', SettingsPanel);
registerModalBody('help', () => HelpOverlay({ open: true, onClose: closeModal, onShowOnboarding: () => openModal('onboarding') }));
registerModalBody('onboarding', () => OnboardingOverlay({ open: true, onClose: () => { markOnboarded(); closeModal(); } }));
registerModalBody('skills', () => SkillsOverlay({
  open: true,
  // Same key as maybeShowOnboarding's gate below -- these two must agree or the
  // overlay opens against one localStorage key and dismisses under another.
  operatorId: state.currentUser && state.currentUser.username,
  onClose: closeModal,
  onAllDone: closeModal,
}));

registerOpenIntakeNew(promptNewCase);

// Real case-list/case-detail keyboard actions (moveDown/moveUp/
// openHighlighted/claim/newCase), wired against the shared state + the
// list/detail layout's own open/close helpers -- j/k walk the currently
// visible (filtered) case list, matching the legacy app.js triage flow.
// j/k walk whatever list is actually on screen. Bound unconditionally to
// state.allCases, they walked the case list even when the operator was looking
// at the map's worst-first queue -- so on the default landing view the triage
// keys moved a highlight nobody could see.
function visibleRows() {
  const onMapHome = !state.activePanel && state.homeView === 'map';
  return (onMapHome ? visibleQueueRows() : state.allCases) || [];
}
function moveFocus(delta) {
  const rows = visibleRows();
  if (!rows.length) return;
  // Anchor off the currently keyboard-highlighted row first (_focusRowId),
  // falling back to the open case (activeId) only when nothing is
  // highlighted yet -- anchoring off activeId alone meant a second/third 'j'
  // press with no case opened in between kept recomputing curIdx as -1 and
  // landing back on row 0 every time, so j/k could never walk past the
  // first row without an Enter in between (live-witnessed: two 'j' presses
  // in a row both highlighted CASE-1268, the top row, instead of advancing).
  const anchorId = state._focusRowId || state.activeId;
  const curIdx = anchorId ? rows.findIndex((c) => c.id === anchorId) : -1;
  const next = Math.min(rows.length - 1, Math.max(0, curIdx + delta));
  state._focusRowId = rows[next].id;
  schedule();
}
registerKeyboardHandlers({
  focusSearch: () => { const el = document.querySelector('.ds-search-input, input[type=search]'); if (el) el.focus(); },
  back: () => { if (state.activeId) { closeCase(); closeCaseRoute(); } },
  moveDown: () => moveFocus(1),
  moveUp: () => moveFocus(-1),
  openHighlighted: () => { if (state._focusRowId) openCase(state._focusRowId); },
  claim: async () => {
    const id = state.activeId || state._focusRowId;
    if (!id) return;
    try { await api.postBulk([id], 'claim'); await reloadCaseListRows(); } catch { /* best-effort */ }
  },
  focusReply: () => { const el = document.querySelector('.casey-reply-box textarea, textarea[name=reply]'); if (el) el.focus(); },
  newCase: () => promptNewCase(),
});
installGlobalKeyboard();

// First-run onboarding + reopenable help (`?`), and a per-operator skills
// checklist once logged in -- all localStorage-gated, shown at most once
// unless the operator explicitly reopens via the Topbar help button.
function maybeShowOnboarding() {
  if (!onboarded()) { openModal('onboarding'); return; }
  if (!helpSeen()) markHelpSeen();
  // username, not id: /api/whoami returns { authed, username, display_name,
  // role, must_change_password } and has no id field at all, so the previous
  // `state.currentUser.id` was permanently undefined and this overlay could
  // never open -- witnessed by clearing localStorage and reloading twice.
  // username is also the operator key everywhere else in this system (getRoster
  // maps accounts to { id: username }, case.assignee holds it, and the three
  // ownership checks compare against it), so keying per-operator state on it
  // keeps one identifier rather than introducing a second.
  const opId = state.currentUser && state.currentUser.username;
  if (opId && !skillsDismissed(opId)) openModal('skills');
}

async function loadCaseyConfig() {
  try {
    const cfg = await api.fetchConfig();
    setConfig(cfg);
    // index.html's <title>/manifest are static (served before any JS runs,
    // no server-side templating) -- update the live tab title here so a
    // deployer's dashboard_ui.brand (e.g. serpent's research-run branding)
    // shows in the browser tab too, not just the in-app Topbar/Crumb.
    // Absent dashboard_ui -- leaves the static "casey - cases" title alone.
    // MUST go through handoff-banner.js's setBaseTitle(), never a direct
    // document.title= here -- that module captures document.title into its
    // own frozen baseTitle constant at ITS OWN module-eval time (page load,
    // before this async fetch resolves) and its inbox-badge/title-flash
    // logic overwrites document.title from that frozen value on every
    // refresh, silently reverting any direct assignment made here. Live-
    // witnessed: a direct document.title= here appeared to work for one
    // instant then reverted to "casey - cases" on the next badge/poll tick.
    const brand = cfg?.dashboard_ui?.brand;
    const leaf = cfg?.dashboard_ui?.leaf;
    if (brand || leaf) setBaseTitle(`${brand || 'casey'} - ${(leaf || 'cases').toLowerCase()}`);
  } catch { /* fall back to shipped defaults already in state */ }
}

// Resolves true only when the server answered 304 -- i.e. it asserted the list
// is byte-identical to the one already on screen. Anything else (a real body, a
// dropped link, a 401) resolves false, so the caller's poll ladder below stays
// at its floor rather than backing off on a failure.
async function loadCases() {
  try {
    const { body, unchanged } = await api.pollCases();
    if (unchanged) return true;
    const list = Array.isArray(body) ? body : (body && body.cases) || [];
    state.allCases = list;
    checkHandoffs(list);
    schedule();
    return false;
  } catch { /* connection banner already surfaces the failure via api.js */ }
  return false;
}

async function refreshAttention() {
  try {
    const a = await api.fetchAttention();
    // /api/attention's real response shape is {count,total,...,cases:[...]}
    // (routes/operations.js) -- this previously read a.rows, a field that
    // route never returns, so state.attention silently stayed [] forever and
    // the inbox badge/map attention feed never populated from a live fetch.
    const rows = Array.isArray(a) ? a : (a && a.cases) || [];
    // setAttention, not a direct assignment: the map subscribes to this to pick
    // up the urgency channel (state.js's onAttentionChange). Writing the field
    // here bypassed that and left every pin at urgency 0.
    setAttention(rows);
    setInboxBadge(rows.length);
  } catch { /* best-effort */ }
}

async function refreshHealth() {
  try { setHealth({ ai: await api.fetchHealth() }); } catch { setHealth({ ai: { ok: false, label: 'AI helper: cannot be checked', detail: 'This browser could not reach the server to ask about the AI helper. Auto-replies may still be running.' } }); }
  try { setHealth({ runtime: await api.fetchRuntime() }); } catch { /* best-effort */ }
  try { setHealth({ guardrails: await api.fetchFleetHealth() }); } catch { /* best-effort */ }
}

async function refreshDegradedTurns() {
  try {
    const rows = await api.fetchDegradedTurns();
    setDegradedTurns(Array.isArray(rows) ? rows : (rows && rows.rows) || []);
  } catch { /* best-effort, feeds notifications-center only */ }
}

export async function refreshAll() {
  // loadCaseyConfig() runs here too, not just in boot() -- a login that
  // happens after the pre-login boot attempt's own /api/config call failed
  // (401/403, e.g. the bootstrap-admin must-change-password gate) left
  // state.config stuck at its pre-login value (null/shipped defaults)
  // forever, since login-gate.js's post-login refresh only ever called this
  // function, never loadCaseyConfig() directly -- so dashboard_ui/
  // report_sections/entity_label never repopulated after a login that
  // followed a failed pre-login config fetch. Live-witnessed: a fresh
  // bootstrap-admin session showed casey's raw hardcoded nav/branding even
  // with a real dashboard_ui config, until this ran again post-login.
  await Promise.all([loadCaseyConfig(), loadCases(), refreshAttention(), refreshHealth(), refreshDegradedTurns()]);
}
registerRefreshAll(refreshAll);

async function boot() {
  await loadCaseyConfig();
  const hv = currentRoute();
  if (hv.view) {
    const decoded = decodeView(hv.view);
    if (decoded) applyView(decoded);
  }
  applyRouteToState();
  // hv.home belongs in this list and was missing from it. `home` is a real
  // route token -- pushHash writes it and initRouteSync reads it back -- so on a
  // deployment configuring default_view:'map' (uhh does) a #home=cases link was
  // applied by applyRouteToState above and then immediately overwritten by the
  // default below, because noDeepLink did not count it as a deep link. Live
  // effect: the case-list home view was reachable only by clicking the nav item,
  // and a bookmark or a shared link to it silently landed on the map instead.
  const noDeepLink = !hv.caseId && !hv.view && !hv.inbox && !hv.home && !state.activePanel;
  // The secretary role exists to work the follow-up queue -- land them there
  // by default, ahead of the deployment-wide dashboard_ui.default_view, since
  // it is more specific to what this role actually needs to know every time
  // they open the dashboard.
  // Never overrides an explicit deep link. No-op for every other role.
  if (state.currentUser?.role === 'secretary' && noDeepLink) {
    openPanel('secretary');
  } else if (state.config?.dashboard_ui?.default_view === 'map' && noDeepLink) {
    // dashboard_ui.default_view:'map' lands the operator on the map instead of
    // the case list. This sets the HOME VIEW; it used to call openPanel('map'),
    // which set state.activePanel and therefore rendered PanelSwap -- the
    // legacy stacked map page -- so on the one deployment that actually
    // configures this (uhh), the map-first command centre was never what an
    // operator landed on. The map-first layout existed and was unreachable by
    // default.
    setHomeView('map');
  }
  if (!state.inboxMode) await loadCases();
  await refreshHealth();
  await refreshAttention();
  await refreshDegradedTurns();
}

// setActiveId, not a direct field assignment: a hash change is one of the six
// ways a case becomes active, and it has to publish that like the other five
// so the map follows a back/forward navigation instead of staying put.
initRouteSync((r) => {
  if (r.home) setHomeView(r.home);
  if (r.caseId) setActiveId(r.caseId);
  if (r.inbox !== undefined) state.inboxMode = r.inbox;
  schedule();
});

(async () => {
  await checkSession();
  if (!state.authed) {
    // Pre-login branding: state.config is otherwise only populated post-
    // login (loadCaseyConfig(), which needs an authed /api/config call) --
    // fetch the small ungated subset so login-gate.js can show a deployment's
    // real brand/leaf instead of the literal 'casey' fallback. Overwritten
    // in full by loadCaseyConfig() once a real session exists; never blocks
    // rendering the login form.
    const b = await api.fetchBranding();
    if (b && (b.brand || b.leaf)) setConfig({ dashboard_ui: b });
    render();
    return;
  }
  await boot();
  render();
  maybeShowOnboarding();
})();

// Background polls: the case list from 5s (see the ladder below), 15s health,
// 30s attention + map pins, 60s degraded-turns (feeds notifications-center
// only, cheap and infrequent). Focus mode suppresses the expensive list poll
// (a phone runs the cheap attention + health polls only).
//
// Every one of these now revalidates rather than re-downloads: api.js sends
// If-None-Match and the server answers an unchanged body with a 304 (see its
// conditional-GET header comment). The intervals below therefore describe how
// often a surface is CHECKED, not how many kilobytes it costs -- an idle check
// is request and response headers, no body.
//
// The list poll is ALSO suppressed while the map home view is showing, for a
// list state.allCases that the map view never reads -- only the case-list side
// does. That suppression was worth far more before revalidation than it is
// now: an unchanged /api/cases poll costs 929 wire bytes rather than 3839, so
// the saving is a poll's worth of headers, not a poll's worth of case rows.
// It stays because the cheapest request is still the one not made, and because
// re-reading a list nothing on screen consumes was never defensible on a
// metered link.
//
// The pins take its place on a 30s tick, matching attention (the two feed the
// same rail and drifting them apart is how the map and the queue come to
// disagree). They were previously never refreshed at all -- fetched once by
// loadMap() and then left, so on a surveillance map a new report could stay
// unplotted for an entire shift while a list nobody was reading refreshed 720
// times an hour. Net effect is still far less traffic, spent on the surface
// actually in front of the operator.
//
// Measured end to end at the socket, same 240s idle window on the case list,
// service worker live, before and after this file's ladder plus api.js's
// conditional GET: 48 requests / 51,749 bytes became 30 requests / 34,273
// bytes -- 0.740 MB/hour down to 0.490, a third of an 8-hour shift's cost
// (5.9 MB down to 3.9 MB). /api/cases itself fell from 190,410 to 41,805
// bytes an hour. What is left is dominated by REQUEST headers (327,015 of the
// remaining 514,095 bytes an hour), so the only lever left on this surface is
// making fewer requests, not smaller ones.
const onMapHome = () => !state.activePanel && state.homeView === 'map';
// The polling cadence, named rather than left as five bare numbers inline.
// This is not housekeeping: every one of these is traffic on what AGENTS.md
// describes as a metered, intermittent rural link, so how often each surface
// refreshes is an operational decision someone should be able to read off
// and change, not a literal to be found by grepping for a number. The
// relationships matter too -- attention and the map pins share a tick on
// purpose, because they feed the same rail and drifting them apart is how the
// map and the queue come to disagree.
const CASES_POLL_MS = 5000;
const HEALTH_POLL_MS = 15000;
const ATTENTION_POLL_MS = 30000;
const MAP_POLL_MS = ATTENTION_POLL_MS;
const DEGRADED_POLL_MS = 60000;

// The case list is the one poll whose interval is not a fixed number, and the
// evidence for that is this deployment's own event log rather than a guess:
// 136 events across 322 hours (0.42 an hour), with 313 of those hours holding
// no event at all and every event that did happen falling inside 9 clock
// hours. A flat 5s tick spends 720 requests an hour to observe nothing in 97
// percent of hours, and 5s is still exactly the right cadence in the hour
// where 56 things happen at once.
//
// So the interval is a ladder, not a constant. It sits at CASES_POLL_MS and
// DOUBLES on each poll the server answers 304 to, up to CASES_POLL_MAX_MS; the
// first poll that carries a real body drops it straight back to the floor, so
// a burst is tracked at 5s from its second event onward. Coming back to a
// hidden tab resets it too -- an operator returning to the screen must not
// wait out a ladder that grew while nobody was looking.
//
// The ceiling is ATTENTION_POLL_MS, deliberately equal rather than merely
// similar: the worst-first queue an operator actually triages from already
// refreshes at 30s, and on the map home view this poll is suppressed
// completely, so a full case list at most 30s behind cannot be less current
// than the surface in front of the operator. It is also only ever 30s behind
// having been TOLD nothing changed -- a 304 is the server's own assertion, not
// an assumption made here.
const CASES_POLL_MAX_MS = ATTENTION_POLL_MS;
let casesPollMs = CASES_POLL_MS;
let _casesTimer = null;
function scheduleCasesPoll() {
  _casesTimer = setTimeout(async () => {
    if (state.inboxMode || onMapHome()) casesPollMs = CASES_POLL_MS;
    else {
      const unchanged = await loadCases();
      casesPollMs = unchanged ? Math.min(CASES_POLL_MAX_MS, casesPollMs * 2) : CASES_POLL_MS;
    }
    scheduleCasesPoll();
  }, casesPollMs);
}
scheduleCasesPoll();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') casesPollMs = CASES_POLL_MS;
});
const _healthIv = setInterval(refreshHealth, HEALTH_POLL_MS);
const _attnIv = setInterval(refreshAttention, ATTENTION_POLL_MS);
const _mapIv = setInterval(() => { if (onMapHome()) refreshMapData(); }, MAP_POLL_MS);
const _degradedIv = setInterval(refreshDegradedTurns, DEGRADED_POLL_MS);
// Not one of the polls above: it fetches no data and exists only so that
// "Connected" cannot outlive the last response that reached the origin. The
// polls are a side-effect detector with a 15s floor on this view and no floor
// at all in a throttled tab -- see api.js's startConnectionWatch.
const _stopConnWatch = api.startConnectionWatch();
window.addEventListener('beforeunload', () => {
  clearTimeout(_casesTimer); clearInterval(_healthIv); clearInterval(_attnIv);
  clearInterval(_mapIv); clearInterval(_degradedIv); _stopConnWatch();
});

// Read-only diagnostic hook. The bug class this layout keeps producing is the
// two halves of the view disagreeing about the same cases -- the chip says 14,
// the list shows 5; the queue selects a case, the map stays put -- and none of
// it is answerable from a screenshot. Counts and view state only, never a ref,
// subject or contact identifier, so it stays inside the same PII-free
// projection discipline as every other operator-facing surface.
window.__caseyDebug = () => ({
  ...mapDebugSnapshot(),
  authed: state.authed,
  role: state.currentUser?.role || null,
  casesLoaded: (state.allCases || []).length,
  inboxMode: state.inboxMode,
  activeModal: state.activeModal,
  // Shape only, never the hash itself: a #case=<id> token would put a real
  // case identifier into a diagnostic blob that gets pasted into bug reports.
  // Whether a deep link is present is the diagnostic value; which case it names
  // is not.
  routeTokens: (location.hash || '').replace(/^#/, '').split('&').filter(Boolean)
    .map((t) => t.split('=')[0]),
});
