// AI-helper / Runtime / Guardrails Status-footer pills. Each degraded state
// renders an attached Alert with explicit guidance text (ux-health-pill-
// states-guidance) instead of just a color. Polling lives in main.js; this
// module renders state.health as written by refreshHealth() there.

import * as webjsx from 'webjsx';
import { Pill, Dot } from 'ds/components/shell.js';
import { Alert } from 'ds/components/content.js';
import { state } from '../state.js';
const h = webjsx.createElement;

function sparkline(vals, w, h2) {
  if (!vals || vals.length < 2) return null;
  const max = Math.max(1, ...vals);
  const step = vals.length > 1 ? w / (vals.length - 1) : 0;
  const pts = vals.map((v, i) => i * step + ',' + (h2 - (v / max) * h2)).join(' ');
  return h('svg', { class: 'ds-sparkline', width: String(w), height: String(h2), 'aria-hidden': 'true' },
    h('polyline', { points: pts, fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }));
}

function aiPill() {
  const hl = state.health.ai;
  if (!hl) return null;
  const gw = hl.gateway;
  const deaf = gw && gw.ok === false;
  const label = deaf ? (gw.label || 'Messages: not connected') : hl.label;
  const ok = deaf ? false : !!hl.ok;
  let extra = '';
  if (hl.queue && (hl.queue.pending > 0 || hl.queue.dead_lettered > 0)) {
    extra += ' Queued messages waiting to retry: ' + hl.queue.pending;
    if (hl.queue.dead_lettered > 0) extra += ' (' + hl.queue.dead_lettered + ' gave up after repeated failures).';
  }
  if (hl.alert_webhook && hl.alert_webhook.configured && hl.alert_webhook.ok === false) extra += ' Alert webhook is failing to send.';
  const detail = (deaf ? gw.detail : hl.detail) + (hl.model ? (' (' + hl.model + ')') : '') + extra;
  return h('div', { class: 'ds-health-pill', key: 'ai' },
    Pill({ tone: ok ? 'accent' : '', children: [Dot({ tone: ok ? 'on' : 'off' }), ' ', label] }),
    !ok ? Alert({ kind: deaf ? 'error' : 'warn', children: detail }) : null
  );
}

function runtimePill() {
  const r = state.health.runtime;
  if (!r || r.supervised === false) return null;
  const ok = r.state === 'healthy' || r.state === 'standalone';
  const warn = r.state === 'restarting' || r.state === 'booting';
  return h('div', { class: 'ds-health-pill', key: 'rt' },
    Pill({ tone: ok ? 'accent' : '', children: [Dot({ tone: ok ? 'on' : (warn ? 'warn' : 'off') }), ' ', r.label || ('Runtime: ' + (r.state || 'unknown'))] }),
    !ok && !warn ? Alert({ kind: 'error', children: 'Restarts since boot: ' + (r.restarts || 0) + (r.lastCrashReason ? (' - last: ' + r.lastCrashReason) : '') }) : null
  );
}

function guardrailsPill() {
  const fh = state.health.guardrails;
  if (!fh || !fh.latest) return null;
  const flagged = fh.latest.flagged || 0;
  const label = fh.degraded ? 'Guardrails: degraded' : (flagged > 0 ? ('Guardrails: ' + flagged + ' flagged') : 'Guardrails: clean');
  const ok = !fh.degraded && flagged === 0;
  const warn = !fh.degraded && flagged > 0;
  return h('div', { class: 'ds-health-pill', key: 'gr' },
    Pill({ tone: ok ? 'accent' : '', children: [Dot({ tone: ok ? 'on' : (warn ? 'warn' : 'off') }), ' ', label, sparkline((fh.history || []).map(p => (p.flagged != null ? p.flagged : (p.data && p.data.flagged) || 0)), 36, 12)].filter(Boolean) }),
    !ok && !warn ? Alert({ kind: 'error', children: 'Last sweep scanned ' + (fh.latest.scanned || 0) + ', flagged ' + flagged + '. Investigate stuck/stale cases.' }) : null
  );
}

export function HealthPills() {
  return [aiPill(), runtimePill(), guardrailsPill()].filter(Boolean);
}
