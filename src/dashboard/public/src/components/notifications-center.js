// Bell IconButton in Topbar opening a Dropdown listing recent handoff/
// degraded-turn alerts. Aggregates existing signals (state.handoffQueue,
// degraded turns fetched separately) rather than a new backend surface.
// Each entry supports per-alert snooze (localStorage-remembered mute window,
// generalizing handoff-banner's per-case-dismiss pattern to per-alert-id).

import * as webjsx from 'webjsx';
import { Dropdown } from 'ds/components/overlay-primitives.js';
import { Icon } from 'ds/components/shell.js';
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

// EVERY LINE IN THIS MENU IS A THING THAT HAPPENED TO A REPORT, so each one
// names the report and says what happened, as a sentence.
//
// It used to read "Turn failed: <reason>" -- "turn" is what the LLM loop calls
// one exchange, "failed" is its return status, and the case it happened to was
// nowhere in the line. When the store had no reason recorded it read "Turn
// failed: unknown reason", which is a machine admitting to itself that a field
// was null. An operator reading that learns nothing and cannot act on it; what
// they need to know is that a specific farmer asked something and did not get
// an answer.
function degradedTurnAlerts() {
  return (state.degradedTurns || []).map(t => ({
    id: 'degraded-' + t.case_id + '-' + t.at,
    caseId: t.case_id, ref: t.ref,
    label: (t.ref || t.case_id) + ' got no answer'
      + (t.reason ? ' -- ' + t.reason : '') + '. Reply to them yourself.',
  }));
}

function handoffAlerts() {
  return state.handoffQueue.map(c => ({
    id: 'handoff-' + c.id, caseId: c.id, ref: c.ref,
    label: (c.ref || c.id) + ' asked for a real person',
  }));
}

export function activeAlerts() {
  return [...handoffAlerts(), ...degradedTurnAlerts()].filter(a => !isSnoozed(a.id));
}

export function NotificationsCenter() {
  const alerts = activeAlerts();
  const items = alerts.length
    ? alerts.map(a => ({ id: a.id, label: a.label }))
    // Deliberately a flat statement of fact, not reassurance. "Nothing needs
    // you right now" is the kind of standing green health-notices.js took out
    // of the appbar: it is a promise this menu cannot keep, since it only sees
    // handoffs and failed turns.
    : [{ id: 'none', label: 'No alerts', disabled: true }];
  items.push({ separator: true });
  if (alerts.length) items.push({ id: 'snooze-all', label: 'Snooze all for 1 hour' });
  return Dropdown({
    ariaLabel: 'Alerts',
    // A megaphone glyph with a red number beside it named itself only in a
    // `title` attribute, and a title is a hover affordance -- it does not
    // exist on the phones this deployment's field and secretarial staff work
    // from, so on the screen that matters the control was an unlabelled
    // picture. The word rides in the trigger now.
    //
    // Returns an ARRAY, not a vnode with children: Dropdown's own
    // trigger-rewrap reads children back via `child.children`, which webjsx
    // never populates (it stores them under `child.props.children`), so any
    // trigger vnode carrying real children renders as an empty button. The
    // array branch wraps the content into Dropdown's own
    // `.ds-dropdown-trigger` and never hits that path -- the identical fix
    // account-menu.js already carries, with the identical reason.
    trigger: () => [
      Icon('megaphone', { size: 16 }),
      h('span', { class: alerts.length ? 'ds-notif-count is-active' : 'ds-notif-count' },
        alerts.length ? ('Alerts (' + alerts.length + ')') : 'Alerts'),
    ],
    items,
    onSelect: (id) => {
      if (id === 'snooze-all') { alerts.forEach(a => snoozeAlert(a.id)); return; }
      if (id === 'none') return;
      const found = alerts.find(a => a.id === id);
      if (found && found.caseId) openCaseRoute(found.caseId);
    },
  });
}
