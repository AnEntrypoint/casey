// Bootstrap only. Imports mountKit, state, App view; calls checkSession()
// then mountKit({root, view: App, screen:'dashboard'}); wires the one global
// keydown listener (delegates into keyboard.js) and popstate/hashchange ->
// route.js. Nothing else lives here.

import { mountKit } from 'ds/bootstrap.js';
import { state, setSchedule, setConfig, setHealth, setDegradedTurns, openModal, closeModal, openPanel } from './state.js';
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
import { MapPanel } from './panels/map-panel.js';
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

// Content-swap panels (11) -- each is a working surface an operator reads/
// acts on for a stretch; registered once here per architecture spec section 4.
registerPanelBody('metrics', MetricsPanel);
registerPanelBody('clusters', ClustersPanel);
registerPanelBody('distribution', DistributionPanel);
registerPanelBody('geo', GeoPanel);
registerPanelBody('map', MapPanel);
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
  operatorId: state.currentUser && state.currentUser.id,
  onClose: closeModal,
  onAllDone: closeModal,
}));

registerOpenIntakeNew(promptNewCase);

// Real case-list/case-detail keyboard actions (moveDown/moveUp/
// openHighlighted/claim/newCase), wired against the shared state + the
// list/detail layout's own open/close helpers -- j/k walk the currently
// visible (filtered) case list, matching the legacy app.js triage flow.
function visibleRows() {
  return state.allCases || [];
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
  const opId = state.currentUser && state.currentUser.id;
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

async function loadCases() {
  try {
    const rows = await api.fetchCases();
    const list = Array.isArray(rows) ? rows : (rows && rows.cases) || [];
    state.allCases = list;
    checkHandoffs(list);
    schedule();
  } catch { /* connection banner already surfaces the failure via api.js */ }
}

async function refreshAttention() {
  try {
    const a = await api.fetchAttention();
    // /api/attention's real response shape is {count,total,...,cases:[...]}
    // (routes/operations.js) -- this previously read a.rows, a field that
    // route never returns, so state.attention silently stayed [] forever and
    // the inbox badge/map attention feed never populated from a live fetch.
    const rows = Array.isArray(a) ? a : (a && a.cases) || [];
    state.attention = rows;
    setInboxBadge(rows.length);
    schedule();
  } catch { /* best-effort */ }
}

async function refreshHealth() {
  try { setHealth({ ai: await api.fetchHealth() }); } catch { setHealth({ ai: { ok: false, label: 'AI helper: unknown', detail: 'Cannot reach the server to check the AI helper.' } }); }
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
  const noDeepLink = !hv.caseId && !hv.view && !hv.inbox && !state.activePanel;
  // A secretary's job is the follow-up queue (HERD-HEALTH-ROADMAP.md Phase
  // 2) -- land them there by default, ahead of the deployment-wide
  // dashboard_ui.default_view, since it is more specific to what this role
  // actually needs "need to know" every time they open the dashboard.
  // Never overrides an explicit deep link. No-op for every other role.
  if (state.currentUser?.role === 'secretary' && noDeepLink) {
    openPanel('secretary');
  } else if (state.config?.dashboard_ui?.default_view === 'map' && noDeepLink) {
    // dashboard_ui.default_view:'map' lands the operator on the map instead
    // of the case list -- additive and config-gated (absent -- today's
    // exact case-list-first landing).
    openPanel('map');
  }
  if (!state.inboxMode) await loadCases();
  await refreshHealth();
  await refreshAttention();
  await refreshDegradedTurns();
}

initRouteSync((r) => { if (r.caseId) state.activeId = r.caseId; if (r.inbox !== undefined) state.inboxMode = r.inbox; schedule(); });

(async () => {
  await checkSession();
  if (!state.authed) { render(); return; }
  await boot();
  render();
  maybeShowOnboarding();
})();

// Background polls: 5s full-list, 15s health, 30s attention, 60s degraded-
// turns (feeds notifications-center only, cheap and infrequent). Focus mode
// suppresses the expensive 5s list poll (a phone runs the cheap attention +
// health polls only).
const _casesIv = setInterval(() => { if (!state.inboxMode) loadCases(); }, 5000);
const _healthIv = setInterval(refreshHealth, 15000);
const _attnIv = setInterval(refreshAttention, 30000);
const _degradedIv = setInterval(refreshDegradedTurns, 60000);
window.addEventListener('beforeunload', () => {
  clearInterval(_casesIv); clearInterval(_healthIv); clearInterval(_attnIv); clearInterval(_degradedIv);
});
