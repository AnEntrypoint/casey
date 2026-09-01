// Pure data: builds the Side `sections` array and any Topbar-adjacent action
// list from current state. No rendering logic beyond prop-shape construction
// -- consumed by app-view.js.

import { Icon } from 'ds/components/shell.js';
import { state, setInboxMode, setHomeView } from '../state.js';
import { openPanel, openModal, closePanel } from '../state.js';
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
function rawSideSections({ clustersCount = 0, offlineCount = 0, refreshAll } = {}) {
  return [
    {
      group: 'Primary',
      items: [
        // BLUF home-view switch: where things are happening (the map) is
        // the default landing view, not buried in Reports & Admin -- see
        // state.js's homeView/setHomeView and views/map-command-center.js.
        { key: 'home_map', glyph: Icon('globe', { size: 15 }), label: 'Map', onClick: () => setHomeView('map'), active: state.homeView === 'map' && !state.activePanel, ariaLabel: 'Map view (home)' },
        { key: 'home_cases', glyph: Icon('rows', { size: 15 }), label: 'Cases', onClick: () => setHomeView('cases'), active: state.homeView === 'cases' && !state.activePanel, ariaLabel: 'Case list view' },
        { key: 'new_case', glyph: Icon('plus', { size: 15 }), label: 'New case', onClick: openIntakeNew, ariaLabel: 'Add a case manually' },
        { key: 'export', glyph: Icon('download', { size: 15 }), label: 'Export', href: '/api/cases/export.csv' },
        { key: 'sweep', glyph: Icon('refresh', { size: 15 }), label: 'Sweep now', onClick: runSweep, ariaLabel: 'Run health-guardrail sweep now' },
        { key: 'focus', glyph: Icon('activity', { size: 15 }), label: 'Focus', onClick: toggleInboxMode, active: state.inboxMode },
        { key: 'refresh', glyph: Icon('refresh', { size: 15 }), label: 'Refresh', onClick: refreshAll || _refreshAll },
      ],
    },
    {
      group: 'Reports & Admin',
      items: [
        { key: 'stats', glyph: Icon('activity', { size: 15 }), label: 'Stats', onClick: () => openModal('stats') },
        { key: 'settings', glyph: Icon('settings', { size: 15 }), label: 'Settings', onClick: () => openModal('settings') },
        { key: 'metrics', glyph: Icon('page', { size: 15 }), label: 'Metrics', onClick: () => openPanel('metrics'), active: state.activePanel === 'metrics' },
        { key: 'clusters', glyph: Icon('link', { size: 15 }), label: 'Related reports', onClick: () => openPanel('clusters'), active: state.activePanel === 'clusters', count: clustersCount },
        { key: 'distribution', glyph: Icon('grid', { size: 15 }), label: 'Distribution', onClick: () => openPanel('distribution'), active: state.activePanel === 'distribution' },
        { key: 'geo', glyph: Icon('hash', { size: 15 }), label: 'Hotspots', onClick: () => openPanel('geo'), active: state.activePanel === 'geo' },
        { key: 'activity', glyph: Icon('thread', { size: 15 }), label: 'Activity', onClick: () => openPanel('activity'), active: state.activePanel === 'activity' },
        { key: 'handover', glyph: Icon('external-link', { size: 15 }), label: 'Shift handover', onClick: () => openPanel('handover'), active: state.activePanel === 'handover' },
        { key: 'offline', glyph: Icon('warn', { size: 15 }), label: 'Missed while offline', onClick: () => openPanel('offline'), active: state.activePanel === 'offline', count: offlineCount, color: offlineCount ? 'var(--warn)' : undefined },
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
    {
      group: 'Account',
      items: [],
    },
  ];
}

// Applies dashboard_ui.nav's hide/relabel/group_labels (see /api/config's
// nav field) over the raw hardcoded sections above. `hide` is a flat array
// of item keys to drop (an emptied group is dropped too, so a config that
// hides every item in "Team" doesn't leave a headerless empty group).
// `relabel` is {key: newLabel}. `group_labels` is {oldGroupName: newGroupName}.
// Absent config (casey's own default, uhh) -- returns the raw sections
// unchanged.
function applyNavConfig(sections, navConfig) {
  if (!navConfig) return sections;
  const hide = new Set(navConfig.hide || []);
  const relabel = navConfig.relabel || {};
  const groupLabels = navConfig.group_labels || {};
  return sections
    // The 'Account' survivor check (below) must match rawSideSections()'s
    // own ORIGINAL group name, not a config-relabeled one -- an adversarial
    // review caught that filtering on the already-renamed `sec.group` meant
    // a group_labels entry targeting 'Account' (e.g. {Account: 'Profile'})
    // would make the check `sec.group === 'Account'` false and silently
    // drop the permanent placeholder group. Filter BEFORE renaming so the
    // survivor check always sees the true original name.
    .filter(sec => sec.items.filter(it => !hide.has(it.key)).length > 0 || sec.group === 'Account')
    .map(sec => ({
      group: groupLabels[sec.group] || sec.group,
      items: sec.items.filter(it => !hide.has(it.key)).map(it => relabel[it.key] ? { ...it, label: relabel[it.key] } : it),
    }));
}

export function buildSideSections(opts = {}) {
  return applyNavConfig(rawSideSections(opts), state.config?.dashboard_ui?.nav);
}

export function backToCases() { closePanel(); }
