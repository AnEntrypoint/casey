import * as webjsx from 'webjsx';
import { Alert } from 'ds/components/content.js';
import { state } from '../state.js';
import { brandName, countOf } from '../vocabulary.js';
const h = webjsx.createElement;

const band = (token) => `background: color-mix(in oklab, var(${token}) 18%, var(--bg)); padding: var(--space-1, 4px);`;

function notice(key, kind, title, body) {
  return h('div', { class: 'ds-health-notice', key, 'data-notice': key, style: band(kind === 'error' ? '--danger' : '--warn') },
    Alert({ kind, title, children: h('div', {}, body) }));
}

function receivingNotice() {
  const gw = state.health.ai && state.health.ai.gateway;
  if (!gw || gw.ok !== false) return null;
  return notice('rx', 'error', brandName() + ' is not receiving reports',
    gw.detail || 'A message channel is not receiving. Contacts may be sending with no reply.');
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
    parts.push(`Queued messages waiting to retry: ${hl.queue.pending}.`);
    if (hl.queue.dead_lettered > 0) parts.push(`${hl.queue.dead_lettered} gave up after repeated failures.`);
  }
  if (webhookFailing) parts.push('The alert webhook is configured but its last send failed, so a system alert raised right now would reach no one.');
  const title = !hl.ok ? (hl.label || 'The AI helper reported no state')
    : queued ? 'Messages are backing up'
      : 'System alerts are reaching no one';
  return notice('ai', hl.ok ? 'warn' : 'error', title, parts.join(' ').trim());
}

function guardrailsNotice() {
  const fh = state.health.guardrails;
  if (!fh || !fh.latest) return null;
  const flagged = fh.latest.flagged || 0;
  if (!fh.degraded && flagged === 0) return null;
  if (fh.degraded) {
    return notice('gr', 'error', 'Reports are not being checked',
      `The last sweep scanned ${fh.latest.scanned || 0} and flagged ${flagged}. Reports are not being checked for going stale or stuck.`);
  }
  return notice('gr', 'warn', `${countOf(flagged)} going wrong`,
    'The last check flagged them as stale, stuck or waiting too long for a person. They are at the top of the queue.');
}

function droppedIntakeNotice() {
  const d = state.health.ai && state.health.ai.dropped_inbound;
  if (!d || !d.total) return null;
  const reasons = Object.values(d.reasons || {}).map(r => `${r.count} because ${r.detail}`);
  return notice('drop', 'error', `${countOf(d.total, 'incoming message')} ${d.total === 1 ? 'was' : 'were'} discarded without being recorded`,
    reasons.join('; ') + '. Counted since this console started; no case or timeline holds them, and the count names no contact.');
}

export function HealthNotices() {
  return [receivingNotice(), droppedIntakeNotice(), aiNotice(), guardrailsNotice()].filter(Boolean);
}
