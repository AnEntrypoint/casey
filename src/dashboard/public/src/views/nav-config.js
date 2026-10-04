import { Icon } from 'ds/components/shell.js';
import { state, setInboxMode, setRailMode } from '../state.js';
import { openModal } from '../state.js';
import { setHomeViewRoute, openPanelRoute, closePanelRoute } from '../route.js';
import * as api from '../api.js';
import { toast, failMsg } from '../toasts.js';
import { entityLabel, EntityLabel, EntityLabelPlural } from '../vocabulary.js';

let _openIntakeNew = () => toast('The dashboard is still starting up. Try New ' + entityLabel() + ' again in a moment.', 'err');
export function registerOpenIntakeNew(fn) { _openIntakeNew = fn; }
function openIntakeNew() { _openIntakeNew(); }

let _refreshAll = () => {};
export function registerRefreshAll(fn) { _refreshAll = fn; }
export function runRefreshAll() { return _refreshAll(); }

export async function runSweep() {
  try { await api.runSweepApi(); toast('Sweep started.'); }
  catch (e) { toast(await failMsg(e, 'The sweep did not run, so nothing was re-checked. The flags on screen are unchanged. Try again in a moment.'), 'err'); }
}

export function toggleInboxMode() { setInboxMode(!state.inboxMode); }

function navClick(e, fn) {
  if (e && typeof e.preventDefault === 'function') e.preventDefault();
  fn();
}

function openOnMap(mode) {
  closePanelRoute();
  setHomeViewRoute('map');
  setRailMode(mode);
}

export function openQueue() { openOnMap('queue'); }

function rawSideSections({ clustersCount = 0, offlineCount = 0 } = {}) {
  const onMapHome = state.homeView === 'map' && !state.activePanel;
  return [
    {
      group: 'Day-to-day',
      items: [
        { key: 'home_map', glyph: Icon('globe', { size: 15 }), label: 'Map', onClick: (e) => navClick(e, openQueue), active: onMapHome && state.railMode === 'queue', ariaLabel: 'Map view (home)' },
        { key: 'geo', glyph: Icon('hash', { size: 15 }), label: 'Hotspots', onClick: (e) => navClick(e, () => openOnMap('geo')), active: onMapHome && state.railMode === 'geo', indent: true },
        { key: 'clusters', glyph: Icon('link', { size: 15 }), label: 'Related reports', onClick: (e) => navClick(e, () => openOnMap('clusters')), active: onMapHome && state.railMode === 'clusters', count: clustersCount, indent: true },
        { key: 'home_cases', glyph: Icon('rows', { size: 15 }), label: EntityLabelPlural(), onClick: (e) => navClick(e, () => { closePanelRoute(); setHomeViewRoute('cases'); }), active: state.homeView === 'cases' && !state.activePanel, ariaLabel: EntityLabel() + ' list view' },
      ],
    },
    {
      group: 'Reports & Admin',
      items: [
        { key: 'stats', glyph: Icon('activity', { size: 15 }), label: 'Stats', onClick: () => openModal('stats') },
        { key: 'metrics', glyph: Icon('page', { size: 15 }), label: 'Metrics', onClick: (e) => navClick(e, () => openPanelRoute('metrics')), active: state.activePanel === 'metrics' },
        { key: 'resolved_map', glyph: Icon('globe', { size: 15 }), label: 'Resolved map', onClick: (e) => navClick(e, () => openPanelRoute('resolved_map')), active: state.activePanel === 'resolved_map' },
        { key: 'disease_reports', glyph: Icon('page', { size: 15 }), label: 'Disease reports', onClick: (e) => navClick(e, () => openPanelRoute('disease_reports')), active: state.activePanel === 'disease_reports' },
        { key: 'distribution', glyph: Icon('grid', { size: 15 }), label: 'Distribution', onClick: (e) => navClick(e, () => openPanelRoute('distribution')), active: state.activePanel === 'distribution' },
        { key: 'activity', glyph: Icon('thread', { size: 15 }), label: 'Activity', onClick: (e) => navClick(e, () => openPanelRoute('activity')), active: state.activePanel === 'activity' },
        { key: 'handover', glyph: Icon('external-link', { size: 15 }), label: 'Shift handover', onClick: (e) => navClick(e, () => openPanelRoute('handover')), active: state.activePanel === 'handover' },
        { key: 'offline', glyph: Icon('warn', { size: 15 }), label: 'Missed while offline', onClick: (e) => navClick(e, () => openPanelRoute('offline')), active: state.activePanel === 'offline', count: offlineCount, color: offlineCount ? 'var(--warn)' : undefined },
        { key: 'settings', glyph: Icon('settings', { size: 15 }), label: 'Settings', onClick: () => openModal('settings') },
      ],
    },
    {
      group: 'Team',
      items: [
        { key: 'team', glyph: Icon('members', { size: 15 }), label: 'Team workload', onClick: (e) => navClick(e, () => openPanelRoute('team')), active: state.activePanel === 'team' },
        { key: 'contacts', glyph: Icon('members', { size: 15 }), label: 'People and codes', onClick: (e) => navClick(e, () => openPanelRoute('contacts')), active: state.activePanel === 'contacts' },
        ...(state.currentUser && state.currentUser.role === 'admin' ? [{ key: 'view_as', glyph: Icon('members', { size: 15 }), label: 'View as...', onClick: (e) => navClick(e, () => openPanelRoute('view_as')), active: state.activePanel === 'view_as' }] : []),
        { key: 'areas', glyph: Icon('globe', { size: 15 }), label: 'Areas', onClick: (e) => navClick(e, () => openPanelRoute('areas')), active: state.activePanel === 'areas' },
        { key: 'nudges', glyph: Icon('activity', { size: 15 }), label: 'Who needs a nudge', onClick: (e) => navClick(e, () => openPanelRoute('nudges')), active: state.activePanel === 'nudges' },
        { key: 'secretary', glyph: Icon('external-link', { size: 15 }), label: 'Follow-up calls', onClick: (e) => navClick(e, () => openPanelRoute('secretary')), active: state.activePanel === 'secretary' },
        { key: 'feedback', glyph: Icon('thread', { size: 15 }), label: 'Feedback', onClick: (e) => navClick(e, () => openPanelRoute('feedback')), active: state.activePanel === 'feedback' },
        { key: 'external_links', glyph: Icon('link', { size: 15 }), label: 'Cross-system links', onClick: (e) => navClick(e, () => openPanelRoute('external_links')), active: state.activePanel === 'external_links' },
      ],
    },
  ];
}

function rawActionItems({ refreshAll } = {}) {
  return [
    { key: 'new_case', glyph: Icon('plus', { size: 15 }), label: 'New ' + entityLabel(), onClick: openIntakeNew, ariaLabel: 'Add a ' + entityLabel() + ' by hand', primary: true },
    { key: 'focus', glyph: Icon('activity', { size: 15 }), label: 'Focus', onClick: toggleInboxMode, active: state.inboxMode, ariaLabel: 'Show only what needs attention' },
    { key: 'export', glyph: Icon('download', { size: 15 }), label: 'Export', href: '/api/cases/export.csv' },
    { key: 'sweep', glyph: Icon('refresh', { size: 15 }), label: 'Sweep now', onClick: runSweep, ariaLabel: 'Run health-guardrail sweep now' },
    { key: 'refresh', glyph: Icon('refresh', { size: 15 }), label: 'Refresh', onClick: refreshAll || _refreshAll },
  ];
}

const ROLE_HIDE = {
  secretary: ['sweep', 'settings', 'metrics', 'distribution', 'team', 'areas'],
  operator: ['sweep', 'areas'],
};
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
    .filter(sec => sec.items.filter(it => !hide.has(it.key)).length > 0)
    .map(sec => ({
      group: groupLabels[sec.group] || sec.group,
      items: sec.items.filter(it => !hide.has(it.key)).map(it => relabel[it.key] ? { ...it, label: relabel[it.key] } : it),
    }));
}

const ITEM_CAPABILITY = { sweep: 'sweep' };

function applyCapabilityScope(items) {
  const caps = (state.health && state.health.ai && state.health.ai.capabilities) || null;
  if (!caps) return items;
  return items.filter(it => {
    const need = ITEM_CAPABILITY[it.key];
    return !need || caps[need] !== false;
  });
}

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
  return applyItemConfig(applyCapabilityScope(rawActionItems(opts)), state.currentUser?.role, state.config?.dashboard_ui?.nav);
}

export function backToCases() { closePanelRoute(); }

export function panelTitle(name) {
  if (!name) return null;
  const relabel = state.config?.dashboard_ui?.nav?.relabel || {};
  for (const sec of rawSideSections()) {
    for (const it of sec.items) {
      if (it.key === name) return relabel[name] || it.label;
    }
  }
  return null;
}
