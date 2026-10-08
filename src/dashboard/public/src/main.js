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
import { brandName, entityLabelPlural } from './vocabulary.js';

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
import { ExternalLinksPanel } from './panels/external-links-panel.js';
import { NudgesPanel } from './panels/nudges-panel.js';
import { AreasPanel } from './panels/areas-panel.js';
import { ViewAsPanel } from './panels/view-as-panel.js';
import { FeedbackPanel } from './panels/feedback-panel.js';
import { isFieldRole, isViewerRole } from './api-roles.js';
import { ResolvedMapPanel } from './panels/resolved-map-panel.js';
import { DiseaseReportsPanel } from './panels/disease-reports-panel.js';
import { refreshFieldLists, fieldMapShown } from './views/field-app.js';
import { resetFieldCase } from './views/field-case.js';

import { OnboardingOverlay, onboarded, markOnboarded } from './components/onboarding-overlay.js';
import { SkillsOverlay, skillsDismissed } from './components/skills-overlay.js';
import { HelpOverlay, helpSeen, markHelpSeen } from './components/help-overlay.js';

const root = document.getElementById('app');
const { render, schedule } = mountKit({ root, view: App, screen: 'dashboard' });
let focusedRowId = null;
document.addEventListener('focusin', (e) => { const row = e.target.closest && e.target.closest('.case-row-main'); if (row) focusedRowId = row.dataset.id || null; });
document.addEventListener('pointerdown', (e) => { if (!(e.target.closest && e.target.closest('.case-row-main'))) focusedRowId = null; }, true);
function keepRowFocus() {
  if (!focusedRowId || (document.activeElement && document.activeElement !== document.body)) return;
  const row = document.querySelector('.case-row-main[data-id="' + CSS.escape(focusedRowId) + '"]');
  if (row) row.focus({ preventScroll: true });
}
setSchedule(() => { schedule(); setTimeout(keepRowFocus, 0); });

initTheme();

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
registerPanelBody('external_links', ExternalLinksPanel);
registerPanelBody('nudges', NudgesPanel);
registerPanelBody('areas', AreasPanel);
registerPanelBody('view_as', ViewAsPanel);
registerPanelBody('feedback', FeedbackPanel);
registerPanelBody('resolved_map', ResolvedMapPanel);
registerPanelBody('disease_reports', DiseaseReportsPanel);

registerModalBody('stats', StatsPanel);
registerModalBody('settings', SettingsPanel);
registerModalBody('help', () => HelpOverlay({ open: true, onClose: closeModal, onShowOnboarding: () => openModal('onboarding') }));
registerModalBody('onboarding', () => OnboardingOverlay({ open: true, onClose: () => { markOnboarded(); closeModal(); } }));
registerModalBody('skills', () => SkillsOverlay({
  open: true,
  operatorId: state.currentUser && state.currentUser.username,
  onClose: closeModal,
  onAllDone: closeModal,
}));

registerOpenIntakeNew(promptNewCase);

function visibleRows() {
  const onMapHome = !state.activePanel && state.homeView === 'map';
  return (onMapHome ? visibleQueueRows() : state.allCases) || [];
}
function moveFocus(delta) {
  const rows = visibleRows();
  if (!rows.length) return;
  const anchorId = state._focusRowId || state.activeId;
  const curIdx = anchorId ? rows.findIndex((c) => c.id === anchorId) : -1;
  const next = Math.min(rows.length - 1, Math.max(0, curIdx + delta));
  state._focusRowId = rows[next].id;
  schedule();
  setTimeout(() => {
    const el = document.querySelector('[data-id="' + CSS.escape(String(state._focusRowId)) + '"]');
    if (el) { el.focus(); el.scrollIntoView({ block: 'nearest' }); }
  }, 0);
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
    try { await api.postBulk([id], 'claim'); await reloadCaseListRows(); } catch {  }
  },
  focusReply: () => { const el = document.querySelector('.casey-reply-box textarea, textarea[name=reply]'); if (el) el.focus(); },
  newCase: () => promptNewCase(),
});
installGlobalKeyboard();

function maybeShowOnboarding() {
  if (isFieldRole() || isViewerRole()) return;
  if (!onboarded()) { openModal('onboarding'); return; }
  if (!helpSeen()) markHelpSeen();
  const opId = state.currentUser && state.currentUser.username;
  if (opId && !skillsDismissed(opId)) openModal('skills');
}

async function loadCaseyConfig() {
  try {
    const cfg = await api.fetchConfig();
    setConfig(cfg);
    const brand = cfg?.dashboard_ui?.brand;
    const leaf = cfg?.dashboard_ui?.leaf;
    if (brand || leaf) setBaseTitle(`${brand || brandName()} - ${(leaf || entityLabelPlural()).toLowerCase()}`);
  } catch {  }
}

async function loadCases() {
  try {
    const { body, unchanged } = await api.pollCases();
    if (unchanged) return true;
    const list = Array.isArray(body) ? body : (body && body.cases) || [];
    state.allCases = list;
    checkHandoffs(list);
    schedule();
    return false;
  } catch {  }
  return false;
}

async function refreshAttention() {
  try {
    const { body: a, unchanged } = await api.pollAttention();
    if (unchanged) return;
    const rows = Array.isArray(a) ? a : (a && a.cases) || [];
    setAttention(rows);
    setInboxBadge(a && typeof a.total === 'number' ? a.total : rows.length);
  } catch {  }
}

const settled = (p) => p.then((value) => ({ value }), () => ({ failed: true }));
async function refreshHealth() {
  const [ai, runtime, guardrails] = await Promise.all([api.fetchHealth(), api.fetchRuntime(), api.fetchFleetHealth()].map(settled));
  const patch = { ai: ai.failed ? { ok: false, label: 'AI helper: cannot be checked', detail: 'This browser could not reach the server to ask about the AI helper. Auto-replies may still be running.' } : ai.value };
  if (!runtime.failed) patch.runtime = runtime.value;
  if (!guardrails.failed) patch.guardrails = guardrails.value;
  setHealth(patch);
}

async function refreshDegradedTurns() {
  try {
    const { body: rows, unchanged } = await api.pollDegradedTurns();
    if (unchanged) return;
    setDegradedTurns(Array.isArray(rows) ? rows : (rows && rows.rows) || []);
  } catch {  }
}

export async function refreshAll() {
  resetCasesPoll();
  if (isViewerRole()) { await loadCaseyConfig(); return; }
  if (isFieldRole()) { await Promise.all([loadCaseyConfig(), refreshFieldLists()]); return; }
  await Promise.all([loadCaseyConfig(), loadCases(), refreshAttention(), refreshHealth(), refreshDegradedTurns()]);
}
registerRefreshAll(refreshAll);

async function boot() {
  await loadCaseyConfig();
  if (isViewerRole()) return;
  if (isFieldRole()) {
    applyRouteToState();
    await refreshFieldLists();
    return;
  }
  const hv = currentRoute();
  if (hv.view) {
    const decoded = decodeView(hv.view);
    if (decoded) applyView(decoded);
  }
  applyRouteToState();
  const noDeepLink = !hv.caseId && !hv.view && !hv.inbox && !hv.home && !state.activePanel;
  if (state.currentUser?.role === 'secretary' && noDeepLink) {
    openPanel('secretary');
  } else if (state.config?.dashboard_ui?.default_view === 'map' && noDeepLink) {
    setHomeView('map');
  }
  if (!state.inboxMode) await loadCases();
  await refreshHealth();
  await refreshAttention();
  await refreshDegradedTurns();
}

initRouteSync((r) => {
  if (r.home) setHomeView(r.home);
  if (r.caseId) setActiveId(r.caseId);
  else if (state.activeId != null) {
    setActiveId(null);
    if (isFieldRole()) { resetFieldCase(); refreshFieldLists(); }
  }
  if (r.inbox !== undefined) state.inboxMode = r.inbox;
  schedule();
});

(async () => {
  await checkSession();
  if (!state.authed) {
    const b = await api.fetchBranding();
    if (b && (b.brand || b.leaf)) setConfig({ dashboard_ui: b });
    render();
    return;
  }
  await boot();
  render();
  maybeShowOnboarding();
})();

const onMapHome = () => !state.activePanel && state.homeView === 'map';
const polling = () => state.authed && !isFieldRole() && !isViewerRole() && document.visibilityState === 'visible';
const CASES_POLL_MS = 5000;
const HEALTH_POLL_MS = 15000;
const ATTENTION_POLL_MS = 30000;
const MAP_POLL_MS = ATTENTION_POLL_MS;
const DEGRADED_POLL_MS = 60000;

const CASES_POLL_MAX_MS = ATTENTION_POLL_MS;
let casesPollMs = CASES_POLL_MS;
let casesPollGen = 0;
let casesPollBusy = false;
let _casesTimer = null;
function scheduleCasesPoll() {
  _casesTimer = setTimeout(async () => {
    const gen = casesPollGen;
    casesPollBusy = true;
    if (!polling() || state.inboxMode || onMapHome()) casesPollMs = CASES_POLL_MS;
    else {
      const unchanged = await loadCases();
      casesPollMs = unchanged && gen === casesPollGen ? Math.min(CASES_POLL_MAX_MS, casesPollMs * 2) : CASES_POLL_MS;
    }
    casesPollBusy = false;
    scheduleCasesPoll();
  }, casesPollMs);
}
function resetCasesPoll() {
  casesPollGen++;
  casesPollMs = CASES_POLL_MS;
  if (casesPollBusy) return;
  clearTimeout(_casesTimer);
  scheduleCasesPoll();
}
scheduleCasesPoll();
const fieldPollable = () => state.authed && isFieldRole() && !state.activeId;
function refreshFieldPolls() {
  refreshFieldLists();
  if (fieldMapShown()) refreshMapData();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  resetCasesPoll();
  if (fieldPollable()) refreshFieldPolls();
  if (!polling()) return;
  refreshHealth();
  refreshAttention();
  refreshDegradedTurns();
  if (onMapHome()) refreshMapData();
});
const _healthIv = setInterval(() => { if (polling()) refreshHealth(); }, HEALTH_POLL_MS);
const _attnIv = setInterval(() => { if (polling()) refreshAttention(); }, ATTENTION_POLL_MS);
const _mapIv = setInterval(() => { if (polling() && onMapHome()) refreshMapData(); }, MAP_POLL_MS);
const _degradedIv = setInterval(() => { if (polling()) refreshDegradedTurns(); }, DEGRADED_POLL_MS);
const FIELD_POLL_MS = 30000;
const _fieldIv = setInterval(() => { if (fieldPollable() && document.visibilityState === 'visible') refreshFieldPolls(); }, FIELD_POLL_MS);
const _stopConnWatch = api.startConnectionWatch();
window.addEventListener('beforeunload', () => {
  clearTimeout(_casesTimer); clearInterval(_healthIv); clearInterval(_attnIv);
  clearInterval(_mapIv); clearInterval(_degradedIv); clearInterval(_fieldIv); _stopConnWatch();
});

window.__caseyDebug = () => ({
  ...mapDebugSnapshot(),
  authed: state.authed,
  role: state.currentUser?.role || null,
  casesLoaded: (state.allCases || []).length,
  inboxMode: state.inboxMode,
  activeModal: state.activeModal,
  routeTokens: (location.hash || '').replace(/^#/, '').split('&').filter(Boolean)
    .map((t) => t.split('=')[0]),
});
