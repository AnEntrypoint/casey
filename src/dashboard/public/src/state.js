function readHomeView() {
  try { return localStorage.casey_home_view === 'cases' ? 'cases' : 'map'; } catch { return 'map'; }
}

export function defaultMapFilter() {
  return { species: '', type: '', status: '', days: '0', band: null, inView: false };
}

export const state = {
  authed: false, currentUser: null, config: null,
  allCases: [], allCasesTotal: 0, attention: [], activeId: null,
  filt: { q: '', status: '', channel: '', source: '', mine: false, fv: {} },
  mineOnly: false, inboxMode: false, theme: 'dark',
  homeView: readHomeView(),
  mapFilter: defaultMapFilter(),
  mapExtent: null,
  railMode: 'queue',
  mobilePane: 'map',
  page: 1, pageSize: 50,
  bulkSelected: new Set(),
  activePanel: null,
  activeModal: null,
  toasts: [],
  connLost: false,
  connLostSince: null,
  sessionRestored: false,
  health: { ai: null, runtime: null, guardrails: null },
  handoffDismissed: new Set(),
  handoffQueue: [],
  degradedTurns: [],
  loading: false,
  loadingCases: false,
  focusedIndex: -1,
  _focusRowId: null,
  offlineQueueCount: 0,
  editing: false,

  caseDetail: null,
  runConfig: null,
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
const activeIdListeners = new Set();
export function onActiveIdChange(fn) {
  activeIdListeners.add(fn);
  return () => activeIdListeners.delete(fn);
}
export function setActiveId(id) {
  state.activeId = id;
  state.focusedIndex = -1;
  for (const fn of activeIdListeners) {
    try { fn(id); } catch {  }
  }
  schedule();
}
export function setMapFilter(partial) { Object.assign(state.mapFilter, partial); schedule(); }
export function clearMapFilter() {
  Object.assign(state.mapFilter, { species: '', type: '', status: '', band: null, inView: false });
  schedule();
}
export function setMapExtent(bounds) {
  const prev = state.mapExtent;
  if (prev && bounds && prev.equals && prev.equals(bounds)) return;
  state.mapExtent = bounds;
  schedule();
}
export function setRailMode(mode) { state.railMode = mode || 'queue'; schedule(); }
const mobilePaneListeners = new Set();
export function onMobilePaneChange(fn) {
  mobilePaneListeners.add(fn);
  return () => mobilePaneListeners.delete(fn);
}
export function setMobilePane(p) {
  const next = p === 'list' ? 'list' : 'map';
  if (state.mobilePane === next) return;
  state.mobilePane = next;
  for (const fn of mobilePaneListeners) {
    try { fn(next); } catch {  }
  }
  schedule();
}
export function setCases(rows, total) {
  state.allCases = rows;
  state.allCasesTotal = total != null ? total : rows.length;
  schedule();
}
const attentionListeners = new Set();
export function onAttentionChange(fn) {
  attentionListeners.add(fn);
  return () => attentionListeners.delete(fn);
}
export function setAttention(rows) {
  const same = JSON.stringify(rows) === JSON.stringify(state.attention);
  state.attention = rows;
  for (const fn of attentionListeners) {
    try { fn(rows); } catch {  }
  }
  if (!same) schedule();
}
export function setFilt(partial) { Object.assign(state.filt, partial); state.page = 1; schedule(); }
export function setMineOnly(v) { state.mineOnly = !!v; state.filt.mine = !!v; state.page = 1; schedule(); }
export function setInboxMode(v) { state.inboxMode = !!v; schedule(); }
export function setHomeView(v) {
  state.homeView = v === 'cases' ? 'cases' : 'map';
  state.activePanel = null; state.activeModal = null;
  try { localStorage.casey_home_view = state.homeView; } catch {  }
  schedule();
}
export function setTheme(t) { state.theme = t; schedule(); }

export function toggleBulkSelect(id, on) {
  const shouldAdd = on !== undefined ? !!on : !state.bulkSelected.has(id);
  if (shouldAdd) state.bulkSelected.add(id); else state.bulkSelected.delete(id);
  schedule();
}
export function clearBulkSelect() { state.bulkSelected.clear(); schedule(); }

export function openPanel(name) { state.activePanel = name; state.activeModal = null; schedule(); }
export function closePanel() { state.activePanel = null; schedule(); }
export function openModal(name) { state.activeModal = name; schedule(); }
export function closeModal() { state.activeModal = null; schedule(); }

export function setConnLost(v) {
  if (state.connLost === !!v) return;
  state.connLost = !!v;
  state.connLostSince = state.connLost ? Date.now() : null;
  schedule();
}
export function setSessionRestored(v) { state.sessionRestored = !!v; schedule(); }
export function setHealth(patch) { Object.assign(state.health, patch); schedule(); }
export function setHandoffQueue(q) { state.handoffQueue = q; schedule(); }
export function setDegradedTurns(rows) {
  const same = JSON.stringify(rows) === JSON.stringify(state.degradedTurns);
  state.degradedTurns = rows;
  if (!same) schedule();
}
export function setOfflineQueueCount(n) { state.offlineQueueCount = n; schedule(); }

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
export function appendTimelineEvents(events) {
  if (state.caseDetail) state.caseDetail.events = (state.caseDetail.events || []).concat(events);
  schedule();
}
export function setTimelineSearch(q) { state.timelineSearch = q; schedule(); }
export function setEditing(v) { state.editing = v; schedule(); }
export function setDuplicateSuggestions(rows) { state.duplicateSuggestions = rows; schedule(); }
export function setSiteHistory(rows) { state.siteHistory = rows; schedule(); }

export function isMine(c) {
  const me = state.currentUser && state.currentUser.username;
  return !!me && c && c.assignee === me;
}
