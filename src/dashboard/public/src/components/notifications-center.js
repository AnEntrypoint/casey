// Bell IconButton in Topbar opening a Dropdown listing recent handoff/
// degraded-turn alerts. Aggregates existing signals (state.handoffQueue,
// degraded turns fetched separately) rather than a new backend surface.
// Each entry supports per-alert snooze (localStorage-remembered mute window,
// generalizing handoff-banner's per-case-dismiss pattern to per-alert-id).

import * as webjsx from 'webjsx';
import { Dropdown } from 'ds/components/overlay-primitives.js';
import { IconButton, Badge, Icon } from 'ds/components/shell.js';
import { state } from '../state.js';
import { openCaseRoute } from '../route.js';
const h = webjsx.createElement;

const SNOOZE_KEY = 'casey_alert_snoozes';
function loadSnoozes() {
  try { const o = JSON.parse(localStorage[SNOOZE_KEY] || '{}'); return (o && typeof o === 'object') ? o : {}; }
  catch { return {}; }
}
function saveSnoozes(m) { try { localStorage[SNOOZE_KEY] = JSON.stringify(m); } catch { /* storage unavailable */ } }

export function snoozeAlert(id, minutes = 60) {
  const m = loadSnoozes();
  m[id] = Date.now() + minutes * 60000;
  saveSnoozes(m);
}
function isSnoozed(id) {
  const m = loadSnoozes();
  return m[id] && m[id] > Date.now();
}

function degradedTurnAlerts() {
  return (state.degradedTurns || []).map(t => ({
    id: 'degraded-' + t.case_id + '-' + t.at,
    caseId: t.case_id, ref: t.ref,
    label: 'Turn failed: ' + (t.reason || 'unknown reason'),
  }));
}

function handoffAlerts() {
  return state.handoffQueue.map(c => ({ id: 'handoff-' + c.id, caseId: c.id, ref: c.ref, label: 'Needs a person: ' + (c.ref || c.id) }));
}

export function activeAlerts() {
  return [...handoffAlerts(), ...degradedTurnAlerts()].filter(a => !isSnoozed(a.id));
}

export function NotificationsCenter() {
  const alerts = activeAlerts();
  const items = alerts.length
    ? alerts.map(a => ({ id: a.id, label: a.label }))
    : [{ id: 'none', label: 'No active alerts', disabled: true }];
  items.push({ separator: true });
  if (alerts.length) items.push({ id: 'snooze-all', label: 'Snooze all for 1 hour' });
  return Dropdown({
    ariaLabel: 'Notifications',
    trigger: () => h('span', { class: 'ds-notif-trigger' },
      IconButton({ icon: Icon('megaphone'), title: 'Notifications' }),
      alerts.length ? Badge({ tone: 'danger', size: 'sm', children: String(alerts.length) }) : null
    ),
    items,
    onSelect: (id) => {
      if (id === 'snooze-all') { alerts.forEach(a => snoozeAlert(a.id)); return; }
      if (id === 'none') return;
      const found = alerts.find(a => a.id === id);
      if (found && found.caseId) openCaseRoute(found.caseId);
    },
  });
}
