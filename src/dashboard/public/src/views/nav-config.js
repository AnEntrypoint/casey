// Pure data: builds the Side `sections` array and any Topbar-adjacent action
// list from current state. No rendering logic beyond prop-shape construction
// -- consumed by app-view.js.

import { Icon } from 'ds/components/shell.js';
import { state, setInboxMode } from '../state.js';
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

export function buildSideSections({ clustersCount = 0, offlineCount = 0, refreshAll } = {}) {
  return [
    {
      group: 'Primary',
      items: [
        { glyph: Icon('plus', { size: 15 }), label: 'New case', onClick: openIntakeNew, ariaLabel: 'Add a case manually' },
        { glyph: Icon('download', { size: 15 }), label: 'Export', href: '/api/cases/export.csv' },
        { glyph: Icon('refresh', { size: 15 }), label: 'Sweep now', onClick: runSweep, ariaLabel: 'Run health-guardrail sweep now' },
        { glyph: Icon('activity', { size: 15 }), label: 'Focus', onClick: toggleInboxMode, active: state.inboxMode },
        { glyph: Icon('refresh', { size: 15 }), label: 'Refresh', onClick: refreshAll || _refreshAll },
      ],
    },
    {
      group: 'Reports & Admin',
      items: [
        { glyph: Icon('activity', { size: 15 }), label: 'Stats', onClick: () => openModal('stats') },
        { glyph: Icon('settings', { size: 15 }), label: 'Settings', onClick: () => openModal('settings') },
        { glyph: Icon('page', { size: 15 }), label: 'Metrics', onClick: () => openPanel('metrics'), active: state.activePanel === 'metrics' },
        { glyph: Icon('link', { size: 15 }), label: 'Related reports', onClick: () => openPanel('clusters'), active: state.activePanel === 'clusters', count: clustersCount },
        { glyph: Icon('grid', { size: 15 }), label: 'Distribution', onClick: () => openPanel('distribution'), active: state.activePanel === 'distribution' },
        { glyph: Icon('hash', { size: 15 }), label: 'Hotspots', onClick: () => openPanel('geo'), active: state.activePanel === 'geo' },
        { glyph: Icon('folder', { size: 15 }), label: 'Map', onClick: () => openPanel('map'), active: state.activePanel === 'map' },
        { glyph: Icon('thread', { size: 15 }), label: 'Activity', onClick: () => openPanel('activity'), active: state.activePanel === 'activity' },
        { glyph: Icon('external-link', { size: 15 }), label: 'Shift handover', onClick: () => openPanel('handover'), active: state.activePanel === 'handover' },
        { glyph: Icon('warn', { size: 15 }), label: 'Missed while offline', onClick: () => openPanel('offline'), active: state.activePanel === 'offline', count: offlineCount, color: offlineCount ? 'var(--warn, #d98a00)' : undefined },
      ],
    },
    {
      group: 'Team',
      items: [
        { glyph: Icon('members', { size: 15 }), label: 'Team workload', onClick: () => openPanel('team'), active: state.activePanel === 'team' },
        { glyph: Icon('members', { size: 15 }), label: 'Reporters', onClick: () => openPanel('contacts'), active: state.activePanel === 'contacts' },
        { glyph: Icon('external-link', { size: 15 }), label: 'Follow-up calls', onClick: () => openPanel('secretary'), active: state.activePanel === 'secretary' },
      ],
    },
    {
      group: 'Account',
      items: [],
    },
  ];
}

export function backToCases() { closePanel(); }
