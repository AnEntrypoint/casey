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

// The map filter's default shape, defined ONCE, here.
//
// It used to exist twice: as an inline object literal in the state below, and
// again as map-model.js's own exported defaultMapFilter(). That is the exact
// duplication map-model.js's header forbids in its own words ("Neither is
// allowed a local copy; that is the whole point"), and the copy in map-model
// was dead -- nothing imported it -- so the two could have drifted silently
// with only the unused one being wrong.
//
// It lives in state.js rather than map-model.js because of a real constraint,
// not preference: map-model.js already imports `state` from here, so having
// state.js import the default back from map-model.js would close an import
// cycle and evaluate this initializer before map-model's export existed.
// Owning it where the state is owned keeps one definition and no cycle.
export function defaultMapFilter() {
  return { species: '', type: '', status: '', days: '0', band: null, inView: false };
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
  // The one filter object the map markers AND the rail queue both read (see
  // map-model.js). Two independently-derived filters were how the two halves
  // of this view came to disagree about the same cases.
  mapFilter: defaultMapFilter(),
  // Live Leaflet bounds, republished on moveend so the rail can narrow to what
  // is actually on screen. Null until the map has loaded.
  mapExtent: null,
  // What the rail shows when no case is open: the worst-first queue, or one of
  // the two spatial rollups that used to unmount the map to show a table.
  railMode: 'queue',
  // Phone only: which of the two panes is showing. Above the breakpoint both
  // are visible and this is ignored. Not persisted -- an operator who opens
  // the dashboard is asking "what is going on where", so a phone starts on the
  // map every time rather than resuming yesterday's list.
  mobilePane: 'map',
  // pagination
  page: 1, pageSize: 50,
  bulkSelected: new Set(),
  // 'metrics'|'clusters'|'distribution'|'geo'|'map'|'activity'|'handover'|'offline'|'team'|'contacts'|'secretary'|null
  activePanel: null,
  // 'settings'|'stats'|'help'|'onboarding'|'skills'|null
  activeModal: null,
  toasts: [],
  // "The dashboard cannot be reached." Set by api.js on a rejected fetch AND
  // on the service worker's 503 {"error":"offline"} envelope -- the latter is
  // a RESOLVED fetch, which is why this used to read false for the entire
  // duration of an outage on a device with a warm shell cache.
  connLost: false,
  // When the link dropped, so the banner can say how long the screen has been
  // showing last-known data instead of leaving the operator to guess.
  connLostSince: null,
  // True when state.authed was assumed from the last session the server
  // confirmed, rather than confirmed by this page load. The operator is still
  // signed in as far as anything on screen goes; what is unverified is
  // whether the server still agrees, and that is re-checked the moment the
  // link returns (auth.js's onConnectionRestored subscription).
  sessionRestored: false,
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
// "A case became active" has exactly one owner, here. Before this, six call
// sites each remembered (or forgot) to also move the map: the attention feed
// called setActiveId AND focusCaseOnMap, while the pin popup, the unresolved
// list, the last-reports overlay, the case list and a hash deep link all set
// the id alone and left the map wherever it was -- so on most of the ways a
// selection actually happens, the view stopped answering "where". Subscribers
// register once; no caller has to remember anything.
const activeIdListeners = new Set();
export function onActiveIdChange(fn) {
  activeIdListeners.add(fn);
  return () => activeIdListeners.delete(fn);
}
export function setActiveId(id) {
  state.activeId = id;
  state.focusedIndex = -1;
  // Listeners run before schedule() so the map has already been told where to
  // go by the time the re-render paints the rail beside it.
  for (const fn of activeIdListeners) {
    try { fn(id); } catch { /* a listener must never break selection itself */ }
  }
  schedule();
}
export function setMapFilter(partial) { Object.assign(state.mapFilter, partial); schedule(); }
export function clearMapFilter() {
  Object.assign(state.mapFilter, { species: '', type: '', status: '', band: null, inView: false });
  schedule();
}
// Bounds change on every frame of a drag; the caller debounces, and this
// no-ops an identical box so a settle-time duplicate does not re-render.
//
// The re-render is NOT conditional on the inView filter being on, and that is
// the whole point. The rail's "in this view" chip states a COUNT derived from
// the live bounds whether or not the filter is applied (map-panel.js's
// filterChips), so gating the re-render on `inView` meant that with the filter
// off -- its default -- panning the map left that number frozen at whatever the
// last unrelated render happened to compute. The chip then read "in this view
// 12" over a viewport holding three, which is precisely the map-and-rail-
// disagree failure map-model.js exists to prevent, arriving through a missed
// notification instead of a duplicated derivation.
//
// The cost is one rail re-render per SETTLED pan (the caller debounces at
// 150ms and an identical box no-ops above), not one per drag frame.
export function setMapExtent(bounds) {
  const prev = state.mapExtent;
  if (prev && bounds && prev.equals && prev.equals(bounds)) return;
  state.mapExtent = bounds;
  schedule();
}
export function setRailMode(mode) { state.railMode = mode || 'queue'; schedule(); }
// Listeners fire BEFORE schedule() on purpose: the map pane is about to be
// shown or hidden with display:none, and the map has to read its own centre
// and zoom while the container still has a real size. Reading them afterwards
// gets a view Leaflet has already recomputed against a 0x0 box.
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
    try { fn(next); } catch { /* a listener must never break the toggle */ }
  }
  schedule();
}
export function setCases(rows, total) {
  state.allCases = rows;
  state.allCasesTotal = total != null ? total : rows.length;
  schedule();
}
// Attention is the source of the map's urgency channel as well as the rail's
// queue, and the two are refreshed by different mechanisms: the rail is
// re-rendered by schedule() on every change, while the map's markers are
// imperative Leaflet objects built once and left alone. So a change here has
// to be PUBLISHED, not just written -- witnessed live, without this the map
// built its markers before the first /api/attention response arrived and every
// pin stayed at urgency 0 forever, while the rail beside it correctly showed
// 16 cases needing a person. Exactly the map-and-rail-disagree failure the
// shared model exists to prevent, arriving through timing instead of through
// duplicated logic.
const attentionListeners = new Set();
export function onAttentionChange(fn) {
  attentionListeners.add(fn);
  return () => attentionListeners.delete(fn);
}
export function setAttention(rows) {
  state.attention = rows;
  for (const fn of attentionListeners) {
    try { fn(rows); } catch { /* a listener must never break the refresh */ }
  }
  schedule();
}
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

export function removeToast(id) {
  const i = state.toasts.findIndex((t) => t.id === id);
  if (i !== -1) state.toasts.splice(i, 1);
  schedule();
}
export function setConnLost(v) {
  if (state.connLost === !!v) return;
  state.connLost = !!v;
  state.connLostSince = state.connLost ? Date.now() : null;
  // sessionRestored is deliberately NOT cleared here. This function is what
  // fires api.js's connection-restored listeners, and auth.js's listener reads
  // sessionRestored to decide whether the session still needs re-verifying --
  // clearing it here ran BEFORE that listener and made the re-check a no-op,
  // so a session that had actually expired during the outage would never have
  // been caught. checkSession() owns the flag in both directions.
  schedule();
}
export function setSessionRestored(v) { state.sessionRestored = !!v; schedule(); }
export function setHealth(patch) { Object.assign(state.health, patch); schedule(); }
export function setRecentSearches(arr) { state.recentSearches = arr; schedule(); }
export function setHandoffQueue(q) { state.handoffQueue = q; schedule(); }
export function setDegradedTurns(rows) { state.degradedTurns = rows; schedule(); }
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
