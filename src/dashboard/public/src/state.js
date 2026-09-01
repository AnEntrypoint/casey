// Single module-level mutable state object + tiny pub-sub. Every view/
// component imports `state` (read) and the relevant mutator (write) from
// here -- no module keeps its own copy of shared data (SSOT). main.js wires
// `setSchedule` to mountKit's own schedule() once, at boot; every mutator
// below ends by calling schedule() so a state change always re-renders.
//
// This is the merged superset of the per-worktree state.js variants written
// by the shell/case-list/case-detail/panels builders -- every field and
// mutator any of those consumer modules imports is present here so no
// downstream view breaks on integration.

// BLUF: where things are happening is the single most operationally
// important fact, so the map -- not the case list -- is the default home
// view (see views/map-command-center.js). Persisted per-viewer, same
// try/catch-localStorage shape as setTheme/setSimpleMode below, so an
// operator who prefers the list-first workflow keeps that choice.
function readHomeView() {
  try { return localStorage.casey_home_view === 'cases' ? 'cases' : 'map'; } catch { return 'map'; }
}

export const state = {
  // auth / config
  authed: false, currentUser: null, config: null,
  // core data
  allCases: [], allCasesTotal: 0, attention: [], activeId: null,
  // filters
  filt: { q: '', status: '', channel: '', source: '', mine: false },
  mineOnly: false, inboxMode: false, simpleMode: false, theme: 'dark',
  // 'map'|'cases' -- which view MainContent() renders when no panel is open
  homeView: readHomeView(),
  // pagination
  page: 1, pageSize: 50,
  bulkSelected: new Set(),
  // 'metrics'|'clusters'|'distribution'|'geo'|'map'|'activity'|'handover'|'offline'|'team'|'contacts'|'secretary'|null
  activePanel: null,
  // 'settings'|'stats'|'help'|'onboarding'|'skills'|null
  activeModal: null,
  toasts: [],
  connLost: false,
  health: { ai: null, runtime: null, guardrails: null },
  savedViews: [],
  recentSearches: [],
  handoffDismissed: new Set(),
  handoffQueue: [],
  degradedTurns: [],
  loading: false,
  loadingCases: false,
  focusedIndex: -1,
  _focusRowId: null,
  offlineQueueCount: 0,
  editing: false,

  // Per-case-detail transient UI state (not persisted, reset on case switch)
  caseDetail: null,          // { case, events, transitions, events_total, report_fill_rate, suggested_assignee }
  runConfig: null,           // per-case config override (entity_label/report_sections/visit_critical), null on a plain casey/uhh deployment or when the current case has no override -- see fetchRunConfig
  caseDetailLoading: false,
  caseDetailError: null,
  caseDetailEditingReport: false,
  timelineSearch: '',
  duplicateSuggestions: null,
  siteHistory: null,
  _headerDisclosed: null,
};

let _schedule = () => {};
export function setSchedule(fn) { _schedule = fn; }
export function schedule() { _schedule(); }

export function setAuthed(authed, user) { state.authed = !!authed; state.currentUser = user || null; schedule(); }
export function setConfig(cfg) { state.config = cfg; schedule(); }
export function setActiveId(id) { state.activeId = id; state.focusedIndex = -1; schedule(); }
export function setCases(rows, total) {
  state.allCases = rows;
  state.allCasesTotal = total != null ? total : rows.length;
  schedule();
}
export function patchCase(id, patch) {
  const i = state.allCases.findIndex((c) => c.id === id);
  if (i !== -1) Object.assign(state.allCases[i], patch);
  schedule();
}
export function setAttention(rows) { state.attention = rows; schedule(); }
export function setFilt(partial) { Object.assign(state.filt, partial); state.page = 1; schedule(); }
export function setMineOnly(v) { state.mineOnly = !!v; state.filt.mine = !!v; state.page = 1; schedule(); }
export function setInboxMode(v) { state.inboxMode = !!v; schedule(); }
export function setHomeView(v) {
  state.homeView = v === 'cases' ? 'cases' : 'map';
  state.activePanel = null; state.activeModal = null;
  try { localStorage.casey_home_view = state.homeView; } catch { /* localStorage unavailable */ }
  schedule();
}
export function setSimpleMode(v) { state.simpleMode = !!v; try { localStorage.casey_simple = v ? '1' : ''; } catch { /* localStorage unavailable */ } schedule(); }
export function setTheme(t) { state.theme = t; try { localStorage.casey_theme = t; } catch { /* localStorage unavailable */ } schedule(); }
export function setPage(p) { state.page = Math.max(1, p | 0); schedule(); }
export function setPageSize(n) { state.pageSize = Math.max(10, n | 0); state.page = 1; schedule(); }

export function toggleBulkSelect(id, on) {
  const shouldAdd = on !== undefined ? !!on : !state.bulkSelected.has(id);
  if (shouldAdd) state.bulkSelected.add(id); else state.bulkSelected.delete(id);
  schedule();
}
export function clearBulkSelect() { state.bulkSelected.clear(); schedule(); }
export function setBulkSelected(ids) { state.bulkSelected = new Set(ids); schedule(); }
export function setBulkSelectMany(ids, on) {
  for (const id of ids) { if (on) state.bulkSelected.add(id); else state.bulkSelected.delete(id); }
  schedule();
}

export function openPanel(name) { state.activePanel = name; state.activeModal = null; schedule(); }
export function closePanel() { state.activePanel = null; schedule(); }
export function openModal(name) { state.activeModal = name; schedule(); }
export function closeModal() { state.activeModal = null; schedule(); }

export function pushToast(t) { state.toasts.push(t); schedule(); }
export function removeToast(id) {
  const i = state.toasts.findIndex((t) => t.id === id);
  if (i !== -1) state.toasts.splice(i, 1);
  schedule();
}
export function setConnLost(v) { if (state.connLost !== !!v) { state.connLost = !!v; schedule(); } }
export function setHealth(patch) { Object.assign(state.health, patch); schedule(); }
export function setSavedViews(v) { state.savedViews = v; schedule(); }
export function setRecentSearches(arr) { state.recentSearches = arr; schedule(); }
export function dismissHandoff(id) { state.handoffDismissed.add(id); schedule(); }
export function setHandoffQueue(q) { state.handoffQueue = q; schedule(); }
export function pushHandoff(c) { state.handoffQueue.push(c); schedule(); }
export function clearHandoff(id) { state.handoffQueue = state.handoffQueue.filter((q) => q.id !== id); schedule(); }
export function setDegradedTurns(rows) { state.degradedTurns = rows; schedule(); }
export function setLoading(v) { state.loading = !!v; schedule(); }
export function setLoadingCases(v) { state.loadingCases = !!v; schedule(); }
export function setFocusedIndex(i) { state.focusedIndex = i; schedule(); }
export function setOfflineQueueCount(n) { state.offlineQueueCount = n; schedule(); }

// -- case-detail transient state (used by case-detail-view.js and children) --
export function setCaseDetailLoading(v) { state.caseDetailLoading = v; schedule(); }
export function setCaseDetail(data) {
  state.caseDetail = data;
  state.runConfig = null;
  state.caseDetailLoading = false;
  state.caseDetailError = null;
  state.caseDetailEditingReport = false;
  state.timelineSearch = '';
  schedule();
}
export function setCaseDetailError(err) {
  state.caseDetailError = err;
  state.caseDetailLoading = false;
  schedule();
}
export function setRunConfig(cfg) { state.runConfig = cfg; schedule(); }
export function patchCaseDetailCase(patch) {
  if (state.caseDetail && state.caseDetail.case) Object.assign(state.caseDetail.case, patch);
  schedule();
}
export function appendTimelineEvents(events) {
  if (state.caseDetail) state.caseDetail.events = (state.caseDetail.events || []).concat(events);
  schedule();
}
export function setTimelineSearch(q) { state.timelineSearch = q; schedule(); }
export function setEditingReport(v) { state.caseDetailEditingReport = v; schedule(); }
export function setEditing(v) { state.editing = v; schedule(); }
export function setDuplicateSuggestions(rows) { state.duplicateSuggestions = rows; schedule(); }
export function setSiteHistory(rows) { state.siteHistory = rows; schedule(); }

export function isMine(c) {
  const me = state.currentUser && state.currentUser.username;
  return !!me && c && c.assignee === me;
}
