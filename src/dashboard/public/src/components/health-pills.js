// EXCEPTION-ONLY health chrome. A pill renders here only when it has
// something an operator can act on; a system with nothing wrong renders
// nothing in this slot at all. Polling lives in main.js; this module renders
// state.health as written by refreshHealth() there.
//
// Why nothing renders when everything is fine. This slot used to hold three
// permanently-green pills (AI helper / Runtime / Guardrails) on every screen,
// every day. A row of standing green in the top-right of an operational
// console is how an operator learns to stop looking at the exact region where
// the one red thing will eventually appear -- and this deployment's audience
// reads that region on a phone, in the field, in a hurry. The standing
// "everything is working" reassurance now lives in the status line, which is
// where "can I trust what I am looking at" already belonged (app-view.js's
// StatusBar); this slot is reserved for the exceptions, so a pill appearing
// here at all is itself the signal.
//
// Two pills were deleted outright rather than made exception-only:
//
// - The RUNTIME pill. /api/runtime reports supervised:false on an unsupervised
//   boot, so it rendered nothing at all there; under `casey up` it rendered a
//   standing green "Runtime: healthy". Neither state changes what an operator
//   does: a genuinely dead runtime is not serving the page they are reading
//   it on, and 'restarting'/'booting' resolve themselves in seconds. It is
//   supervisor telemetry, shown to a field officer.
//
// - The guardrails SPARKLINE. A 36x12 aria-hidden polyline of flagged counts
//   across sweeps: unreadable at that size, invisible to a screen reader, and
//   no decision hangs on its slope. The number it sat beside carries the whole
//   signal.
//
// The AI-helper pill's own GREEN was the most expensive of the three, because
// it was a documented half-truth: /api/health's degraded flag deliberately
// never flips on a single failed turn (llm.js's MIN_SAMPLES_FOR_DEGRADED, and
// the comment above /api/turns/degraded in routes/operations.js names the
// observability cost outright) -- so "AI helper: online" could stand green
// while a real contact got the fallback text instead of an answer. The honest
// per-turn signal already exists and is already surfaced: degraded turns reach
// the operator through the alerts menu (notifications-center.js). Removing the
// green removes a reassurance the data could not support.

import * as webjsx from 'webjsx';
import { Pill, Dot } from 'ds/components/shell.js';
import { Alert } from 'ds/components/content.js';
import { state, schedule } from '../state.js';
const h = webjsx.createElement;

// Detail is DISCLOSED, not permanent -- the pill states the problem in words,
// the detail says what to do about it.
const expandedDetail = new Set();

// Every pill that reaches this function has something to say, so every one of
// them gets the disclosure button; there is no bare-pill branch any more.
function pill(key, tone, label, kind, detail) {
  const open = expandedDetail.has(key);
  return h('div', { class: 'ds-health-pill ds-health-pill-has-detail', key },
    h('button', {
      type: 'button', class: 'ds-health-pill-trigger',
      'aria-expanded': String(open),
      title: open ? 'Hide details' : 'Show details',
      onclick: () => { if (open) expandedDetail.delete(key); else expandedDetail.add(key); schedule(); },
    }, Pill({ tone: '', children: [Dot({ tone }), ' ', label] })),
    open ? h('div', { class: 'ds-health-pill-detail' }, Alert({ kind, children: detail })) : null);
}

// Receive-liveness: casey is not hearing the field. In a disease-surveillance
// deployment this is the single most consequential thing the frame can say --
// nothing looks broken, reports simply stop arriving, and without this the
// dashboard reads normal all the way through the outage. It is red, it is
// first, and it is the ONE place this fact appears: when the channel is
// healthy the status line carries the quiet standing version instead
// (app-view.js's StatusBar), so the two can never both be on screen.
function receivingPill() {
  const gw = state.health.ai && state.health.ai.gateway;
  if (!gw || gw.ok !== false) return null;
  return pill('rx', 'off', 'Not receiving reports', 'error',
    gw.detail || 'A message channel is not receiving. Contacts may be sending with no reply.');
}

// The AI-helper side only (the gateway half is receivingPill above). Renders
// when auto-replies are off/slow/unknown, when messages are backed up behind
// an outage, or when the alert webhook is failing to send.
function aiPill() {
  const hl = state.health.ai;
  if (!hl) return null;
  const queued = hl.queue && (hl.queue.pending > 0 || hl.queue.dead_lettered > 0);
  const webhookFailing = hl.alert_webhook && hl.alert_webhook.configured && hl.alert_webhook.ok === false;
  if (hl.ok && !queued && !webhookFailing) return null;
  let detail = hl.ok ? '' : ((hl.detail || '') + (hl.model ? (' (' + hl.model + ')') : ''));
  if (queued) {
    detail += ' Queued messages waiting to retry: ' + hl.queue.pending;
    if (hl.queue.dead_lettered > 0) detail += ' (' + hl.queue.dead_lettered + ' gave up after repeated failures).';
  }
  if (webhookFailing) detail += ' Alert webhook is failing to send.';
  const label = hl.ok ? 'Messages are backing up' : (hl.label || 'AI helper: unknown');
  return pill('ai', hl.ok ? 'warn' : 'off', label, hl.ok ? 'warn' : 'error', detail.trim());
}

// Cases the sweep flagged as going wrong. The count is the decision ("go look
// at these"), so the pill says the count in words and the detail says where
// they are -- the previous warn state rendered a bare number with no detail at
// all, which named a problem and then declined to say anything about it.
function guardrailsPill() {
  const fh = state.health.guardrails;
  if (!fh || !fh.latest) return null;
  const flagged = fh.latest.flagged || 0;
  if (!fh.degraded && flagged === 0) return null;
  if (fh.degraded) {
    return pill('gr', 'off', 'Checks are not running', 'error',
      'The last sweep scanned ' + (fh.latest.scanned || 0) + ' and flagged ' + flagged
      + '. Reports are not being checked for going stale or stuck.');
  }
  return pill('gr', 'warn', flagged + ' report(s) going wrong', 'warn',
    'The last check flagged ' + flagged + ' report(s) as stale, stuck or waiting too long for a person. They are at the top of the queue.');
}

export function HealthPills() {
  return [receivingPill(), aiPill(), guardrailsPill()].filter(Boolean);
}
