import * as webjsx from 'webjsx';
import { Alert } from 'ds/components/content.js';
import { state } from '../state.js';
import { brandName, countOf } from '../vocabulary.js';
import { word } from '../words.js';
const h = webjsx.createElement;

const band = (token) => `background: color-mix(in oklab, var(${token}) 18%, var(--bg)); padding: var(--space-1, 4px);`;

function notice(key, kind, title, body) {
  return h('div', { class: 'ds-health-notice', key, 'data-notice': key, style: band(kind === 'error' ? '--danger' : '--warn') },
    Alert({ kind, title, children: h('div', {}, body) }));
}

function receivingNotice() {
  const gw = state.health.ai && state.health.ai.gateway;
  if (!gw || gw.ok !== false) return null;
  return notice('rx', 'error', word('ui.health_notices_not_receiving', { brand: brandName() }),
    gw.detail || word('ui.health_notices_channel_detail'));
}

function aiNotice() {
  const hl = state.health.ai;
  if (!hl) return null;
  if (hl.source === 'unwired') return null;
  const queued = hl.queue && (hl.queue.pending > 0 || hl.queue.dead_lettered > 0);
  const webhookFailing = hl.alert_webhook && hl.alert_webhook.configured && hl.alert_webhook.ok === false;
  if (hl.ok && !queued && !webhookFailing) return null;
  const parts = [];
  if (!hl.ok) parts.push((hl.detail || '') + (hl.model ? ` (${hl.model})` : ''));
  if (queued) {
    parts.push(word('ui.health_notices_queued', { pending: hl.queue.pending }));
    if (hl.queue.dead_lettered > 0) parts.push(word('ui.health_notices_gave_up', { dead_lettered: hl.queue.dead_lettered }));
  }
  if (webhookFailing) parts.push(word('ui.health_notices_webhook_failed'));
  const title = !hl.ok ? (hl.label || word('ui.health_notices_ai_no_state'))
    : queued ? word('ui.health_notices_backing_up')
      : word('ui.health_notices_alerts_no_one');
  return notice('ai', hl.ok ? 'warn' : 'error', title, parts.join(' ').trim());
}

function guardrailsNotice() {
  const fh = state.health.guardrails;
  if (!fh || !fh.latest) return null;
  const flagged = fh.latest.flagged || 0;
  if (!fh.degraded && flagged === 0) return null;
  if (fh.degraded) {
    return notice('gr', 'error', word('ui.health_notices_not_checked'),
      word('ui.health_notices_sweep_degraded', { scanned: fh.latest.scanned || 0, flagged }));
  }
  return notice('gr', 'warn', word('ui.health_notices_going_wrong', { count: countOf(flagged) }),
    word('ui.health_notices_flagged_body'));
}

function droppedIntakeNotice() {
  const d = state.health.ai && state.health.ai.dropped_inbound;
  if (!d || !d.total) return null;
  const reasons = Object.values(d.reasons || {}).map(r => word('ui.health_notices_because', { count: r.count, detail: r.detail }));
  const discarded = countOf(d.total, word('ui.health_notices_incoming_message'));
  return notice('drop', 'error', word(d.total === 1 ? 'ui.health_notices_discarded_one' : 'ui.health_notices_discarded_many', { count: discarded }),
    reasons.join('; ') + word('ui.health_notices_counted_note'));
}

export function HealthNotices() {
  return [receivingNotice(), droppedIntakeNotice(), aiNotice(), guardrailsNotice()].filter(Boolean);
}
