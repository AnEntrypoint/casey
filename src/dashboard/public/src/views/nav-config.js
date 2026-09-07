// Pure data: builds the Side `sections` array and any Topbar-adjacent action
// list from current state. No rendering logic beyond prop-shape construction
// -- consumed by app-view.js.

import { Icon } from 'ds/components/shell.js';
import { state, setInboxMode, setRailMode } from '../state.js';
import { openPanel, openModal, closePanel } from '../state.js';
import { setHomeViewRoute } from '../route.js';
import * as api from '../api.js';
import { toast } from '../toasts.js';

// intake-form-view.js is owned by a different builder (case-list/case-detail/
// intake are explicitly out of scope for this shell build) -- this shell
// wires the nav slot to a stable exported hook other agents' view module can
// override once it lands, so the "New case" nav item is never a dead click.
let _openIntakeNew = () => toast('New-case intake is not wired up yet.', 'err');
export function registerOpenIntakeNew(fn) { _openIntakeNew = fn; }
function openIntakeNew() { _openIntakeNew(); }

// main.js registers its own refreshAll() here at boot -- avoids a circular
// import (nav-config -> main -> app-view -> nav-config). Exported so a fresh
// login (login-gate.js) can force an immediate refresh instead of waiting out
// the up-to-15s background poll interval, which otherwise left the health
// pills showing the pre-login "cannot reach the server" fallback for a beat
// right after a successful log in.
let _refreshAll = () => {};
export function registerRefreshAll(fn) { _refreshAll = fn; }
export function runRefreshAll() { return _refreshAll(); }

export async function runSweep() {
  try { await api.runSweepApi(); toast('Sweep started.'); }
  catch (e) { toast('Sweep failed: ' + e.message, 'err'); }
}

export function toggleInboxMode() { setInboxMode(!state.inboxMode); }

// Every item carries a stable `key` (independent of its display `label`) so
// dashboard_ui.nav config (see report-shape.js's DASHBOARD_UI, threaded
// through /api/config) can hide/relabel specific items without the config
// package needing to match against a label string that might itself be
// relabeled. Casey's own default/uhh declare no dashboard_ui, so
// applyNavConfig (below) is a no-op and every item/group renders exactly as
// before this existed.
// Opens one of the two spatial rollups ON the map rather than instead of it.
// Both answer a WHERE question, and both used to be full-page swaps that
// unmounted the map to show a table -- so the operator asked "where are the
// hotspots" and the UI removed the only thing that can show where. These land
// on the map home view with the rollup docked in the rail beside it.
// The design SDK renders every nav item as <a href="#">, so the anchor's
// DEFAULT action runs after our handler and rewrites the URL to bare "#" --
// which wiped the #home=... token setHomeViewRoute had just written, measured
// live: the view changed but location.hash came back empty, so the one thing
// this routing exists for (sending a colleague a link to what you are looking
// at) silently did nothing. Every handler that touches the route has to stop
// the anchor first. It also stops the page jumping to the top on each click.
function navClick(e, fn) {
  if (e && typeof e.preventDefault === 'function') e.preventDefault();
  fn();
}

function openOnMap(mode) {
  closePanel();
  setHomeViewRoute('map');
  setRailMode(mode);
}

// DESTINATIONS ONLY. Five verbs (New case, Export, Sweep now, Focus, Refresh)
// used to sit in this list above the fold, which made the two actual
// destinations impossible to pick out at a glance -- a verb in a list of
// places is a category error, and three of those five are rare admin actions
// holding the most valuable nav real estate. They now live in the topbar
// action row (buildActionItems below), keeping their keys so a deployer's
// dashboard_ui.nav hide/relabel and the per-role floor still bind to them.
//
// Grouping follows Esri's own guidance for operational dashboards (keep the
// element count low, most essential first): the map and the things you reach
// ON the map lead, the list view sits with them, and everything analytical is
// one group below.
function rawSideSections({ clustersCount = 0, offlineCount = 0 } = {}) {
  const onMapHome = state.homeView === 'map' && !state.activePanel;
  return [
    {
      group: 'Primary',
      items: [
        { key: 'home_map', glyph: Icon('globe', { size: 15 }), label: 'Map', onClick: (e) => navClick(e, () => { closePanel(); setHomeViewRoute('map'); setRailMode('queue'); }), active: onMapHome && state.railMode === 'queue', ariaLabel: 'Map view (home)' },
        { key: 'geo', glyph: Icon('hash', { size: 15 }), label: 'Hotspots', onClick: (e) => navClick(e, () => openOnMap('geo')), active: onMapHome && state.railMode === 'geo' },
        { key: 'clusters', glyph: Icon('link', { size: 15 }), label: 'Related reports', onClick: (e) => navClick(e, () => openOnMap('clusters')), active: onMapHome && state.railMode === 'clusters', count: clustersCount },
        { key: 'home_cases', glyph: Icon('rows', { size: 15 }), label: 'Cases', onClick: (e) => navClick(e, () => { closePanel(); setHomeViewRoute('cases'); }), active: state.homeView === 'cases' && !state.activePanel, ariaLabel: 'Case list view' },
      ],
    },
    {
      group: 'Reports & Admin',
      items: [
        { key: 'stats', glyph: Icon('activity', { size: 15 }), label: 'Stats', onClick: () => openModal('stats') },
        { key: 'metrics', glyph: Icon('page', { size: 15 }), label: 'Metrics', onClick: () => openPanel('metrics'), active: state.activePanel === 'metrics' },
        { key: 'distribution', glyph: Icon('grid', { size: 15 }), label: 'Distribution', onClick: () => openPanel('distribution'), active: state.activePanel === 'distribution' },
        { key: 'activity', glyph: Icon('thread', { size: 15 }), label: 'Activity', onClick: () => openPanel('activity'), active: state.activePanel === 'activity' },
        { key: 'handover', glyph: Icon('external-link', { size: 15 }), label: 'Shift handover', onClick: () => openPanel('handover'), active: state.activePanel === 'handover' },
        { key: 'offline', glyph: Icon('warn', { size: 15 }), label: 'Missed while offline', onClick: () => openPanel('offline'), active: state.activePanel === 'offline', count: offlineCount, color: offlineCount ? 'var(--warn)' : undefined },
        { key: 'settings', glyph: Icon('settings', { size: 15 }), label: 'Settings', onClick: () => openModal('settings') },
      ],
    },
    {
      group: 'Team',
      items: [
        { key: 'team', glyph: Icon('members', { size: 15 }), label: 'Team workload', onClick: () => openPanel('team'), active: state.activePanel === 'team' },
        { key: 'contacts', glyph: Icon('members', { size: 15 }), label: 'Reporters', onClick: () => openPanel('contacts'), active: state.activePanel === 'contacts' },
        { key: 'secretary', glyph: Icon('external-link', { size: 15 }), label: 'Follow-up calls', onClick: () => openPanel('secretary'), active: state.activePanel === 'secretary' },
      ],
    },
  ];
}

// The five verbs, as an ordered list for the topbar. `primary: true` marks the
// one that gets a real button; the rest are overflow-menu candidates. Same
// keys as before, run through the same role floor and the same deployer
// config, so nothing a deployer configured stops working because a control
// moved house.
function rawActionItems({ refreshAll } = {}) {
  return [
    { key: 'new_case', glyph: Icon('plus', { size: 15 }), label: 'New case', onClick: openIntakeNew, ariaLabel: 'Add a case manually', primary: true },
    { key: 'focus', glyph: Icon('activity', { size: 15 }), label: 'Focus', onClick: toggleInboxMode, active: state.inboxMode, ariaLabel: 'Show only what needs attention' },
    { key: 'export', glyph: Icon('download', { size: 15 }), label: 'Export', href: '/api/cases/export.csv' },
    { key: 'sweep', glyph: Icon('refresh', { size: 15 }), label: 'Sweep now', onClick: runSweep, ariaLabel: 'Run health-guardrail sweep now' },
    { key: 'refresh', glyph: Icon('refresh', { size: 15 }), label: 'Refresh', onClick: refreshAll || _refreshAll },
  ];
}

// Applies dashboard_ui.nav's hide/relabel/group_labels (see /api/config's
// nav field) over the raw hardcoded sections above. `hide` is a flat array
// of item keys to drop (an emptied group is dropped too, so a config that
// hides every item in "Team" doesn't leave a headerless empty group).
// `relabel` is {key: newLabel}. `group_labels` is {oldGroupName: newGroupName}.
// Absent config (casey's own default, uhh) -- returns the raw sections
// unchanged.
// Role-scoped nav: a secretary's job is the follow-up queue (2a/2b, see
// HERD-HEALTH-ROADMAP.md Phase 2), not admin/analyst-grade tooling --
// "need to know on every page" per the redesign request. Hidden items are
// still reachable to an admin/operator; this is a per-role floor, applied
// BEFORE the deployer's own dashboard_ui.nav hide/relabel (so a deployer
// can hide further, never un-hide a role-level restriction by relabeling
// around it). Absent role (no login yet, or a role this map doesn't name)
// -- no-op, byte-identical to before this existed.
const ROLE_HIDE = {
  secretary: ['sweep', 'settings', 'metrics', 'distribution', 'team'],
};
// The 'Account' survivor special-case that used to live in both filters below
// is gone with the always-empty 'Account' group it existed to protect: a group
// that never had an item still rendered its header, and both filters then
// carried branch logic to keep that emptiness alive. The account controls have
// always actually lived in the topbar's AccountMenu.
function applyRoleScope(sections, role) {
  const hide = new Set(ROLE_HIDE[role] || []);
  if (!hide.size) return sections;
  return sections
    .filter(sec => sec.items.filter(it => !hide.has(it.key)).length > 0)
    .map(sec => ({ ...sec, items: sec.items.filter(it => !hide.has(it.key)) }));
}

function applyNavConfig(sections, navConfig) {
  if (!navConfig) return sections;
  const hide = new Set(navConfig.hide || []);
  const relabel = navConfig.relabel || {};
  const groupLabels = navConfig.group_labels || {};
  return sections
    // Filter BEFORE renaming, so a group_labels entry can never change which
    // groups survive -- an emptied group is dropped on its item count alone.
    .filter(sec => sec.items.filter(it => !hide.has(it.key)).length > 0)
    .map(sec => ({
      group: groupLabels[sec.group] || sec.group,
      items: sec.items.filter(it => !hide.has(it.key)).map(it => relabel[it.key] ? { ...it, label: relabel[it.key] } : it),
    }));
}

// Actions run through the identical hide/relabel pass as the nav items did
// when they lived there. A control that moved from the nav to the topbar must
// not quietly escape a deployer's config or a role's floor -- the secretary
// floor hides 'sweep', and it still does.
function applyItemConfig(items, role, navConfig) {
  const roleHide = new Set(ROLE_HIDE[role] || []);
  const hide = new Set((navConfig && navConfig.hide) || []);
  const relabel = (navConfig && navConfig.relabel) || {};
  return items
    .filter(it => !roleHide.has(it.key) && !hide.has(it.key))
    .map(it => (relabel[it.key] ? { ...it, label: relabel[it.key] } : it));
}

export function buildSideSections(opts = {}) {
  const roleScoped = applyRoleScope(rawSideSections(opts), state.currentUser?.role);
  return applyNavConfig(roleScoped, state.config?.dashboard_ui?.nav);
}

export function buildActionItems(opts = {}) {
  return applyItemConfig(rawActionItems(opts), state.currentUser?.role, state.config?.dashboard_ui?.nav);
}

export function backToCases() { closePanel(); }
