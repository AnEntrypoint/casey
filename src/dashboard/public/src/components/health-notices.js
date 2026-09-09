// EXCEPTION-ONLY health notices, rendered as plain sentences in the banner
// stack above the app -- not as chrome in the titlebar. A system with nothing
// wrong renders nothing here at all. Polling lives in main.js; this module
// renders state.health as written by refreshHealth() there.
//
// WHY THESE ARE NOT PILLS. They used to be: a coloured dot, a rounded pill, and
// a disclosure button per notice, wedged into the appbar beside the account
// menu. Three things were wrong with that, and only the third is cosmetic.
//
// 1. A pill is a LABEL, and every one of these is a SENTENCE. "AI helper: not
//    visible in dashboard-only mode" is not a status value; it is an
//    explanation that has to be read to be acted on. Compressing it into a
//    label meant the actionable half lived behind a toggle nobody opens, so the
//    surface that existed to make a problem unmissable made it one click away.
// 2. The dot carried the whole severity signal in hue alone, at 8px, in the
//    densest corner of the frame -- on a phone, in the field, in sunlight.
// 3. The vocabulary read as machine status rather than as one person telling
//    another what is wrong. An operational console for field officers should
//    say "casey is not hearing the field", not render a taxonomy.
//
// The banner stack is where "something is wrong with the system itself"
// already speaks (connection-banner.js), so these join it rather than opening
// a second grammar for the same class of fact. Same tinted band, same Alert,
// same plain sentences.
//
// Three earlier surfaces were deleted outright rather than moved:
//
// - The RUNTIME pill. /api/runtime reports supervised:false on an unsupervised
//   boot, so it rendered nothing at all there; under `casey up` it rendered a
//   standing green "Runtime: healthy". Neither state changes what an operator
//   does: a genuinely dead runtime is not serving the page they are reading it
//   on, and 'restarting'/'booting' resolve themselves in seconds.
// - The guardrails SPARKLINE. A 36x12 aria-hidden polyline of flagged counts:
//   unreadable at that size, invisible to a screen reader, and no decision
//   hangs on its slope.
// - Every standing GREEN. /api/health's degraded flag deliberately never flips
//   on a single failed turn (llm.js's MIN_SAMPLES_FOR_DEGRADED), so "AI helper:
//   online" could stand green while a real contact got fallback text instead of
//   an answer. The quiet standing version lives in the status line, and the
//   honest per-turn signal reaches the operator through the alerts menu
//   (notifications-center.js).

import * as webjsx from 'webjsx';
import { Alert } from 'ds/components/content.js';
import { state } from '../state.js';
const h = webjsx.createElement;

// Same band treatment connection-banner.js uses, for the same reason stated
// there: the kit's Alert tints only its icon, which would leave a real fault
// looking like an ordinary grey note. Error and warning differ by tint, never
// by tint alone -- the title says which it is in words.
const band = (token) => `background: color-mix(in oklab, var(${token}) 18%, var(--bg)); padding: var(--space-1, 4px);`;

function notice(key, kind, title, body) {
  return h('div', { class: 'ds-health-notice', key, 'data-notice': key, style: band(kind === 'error' ? '--danger' : '--warn') },
    Alert({ kind, title, children: h('div', {}, body) }));
}

// Receive-liveness: casey is not hearing the field. In a disease-surveillance
// deployment this is the single most consequential thing the frame can say --
// nothing looks broken, reports simply stop arriving, and without this the
// dashboard reads normal all the way through the outage. It is first, and it is
// the ONE place this fact appears: when the channel is healthy the status line
// carries the quiet standing version instead (app-view.js's StatusBar), so the
// two can never both be on screen.
function receivingNotice() {
  const gw = state.health.ai && state.health.ai.gateway;
  if (!gw || gw.ok !== false) return null;
  return notice('rx', 'error', 'casey is not receiving reports',
    gw.detail || 'A message channel is not receiving. Contacts may be sending with no reply.');
}

// The AI-helper side only (the gateway half is receivingNotice above). Renders
// when auto-replies are off or slow, or when messages are backed up behind an
// outage, or when the alert webhook is failing to send.
//
// NOT rendered for dashboard-only mode. `casey dashboard` passes no llmStatus,
// so the helper is not broken -- this console simply has no wire to ask down.
// That is a property of how the operator started the process, true for the
// whole session, and unchanged by anything they can do on this screen. Raising
// it as a standing fault put a permanent red exception on a healthy system,
// which is exactly the "learn to stop looking at that corner" failure the
// standing green pills caused. The mode is stated once, quietly, in the status
// line instead (app-view.js's StatusBar).
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
  // The title names WHICH of the three conditions fired, not just "the helper
  // is unhappy". Live-witnessed before this: a failing alert webhook on an
  // otherwise-healthy system rendered "Messages are backing up" with a body
  // that said nothing about a queue, because the title was chosen from hl.ok
  // alone and the webhook was the only thing wrong.
  //
  // A missing label is a hole in THIS RESPONSE, not a state the helper is in.
  // "AI helper: unknown" rendered that hole as a word and an operator read it as
  // a diagnosis. The server owns the real wording (operations.js's
  // LLM_HEALTH_VIEWS); the fallback below only covers a response that carried no
  // label at all, so it says exactly that and claims nothing about the helper.
  const title = !hl.ok ? (hl.label || 'The AI helper reported no state')
    : queued ? 'Messages are backing up'
      : 'Nothing is paging anyone';
  return notice('ai', hl.ok ? 'warn' : 'error', title, parts.join(' ').trim());
}

// Cases the sweep flagged as going wrong. The count is the decision ("go look
// at these"), so the title says the count in words and the body says where they
// are -- the previous warn state rendered a bare number with no detail at all,
// which named a problem and then declined to say anything about it.
function guardrailsNotice() {
  const fh = state.health.guardrails;
  if (!fh || !fh.latest) return null;
  const flagged = fh.latest.flagged || 0;
  if (!fh.degraded && flagged === 0) return null;
  if (fh.degraded) {
    return notice('gr', 'error', 'Reports are not being checked',
      `The last sweep scanned ${fh.latest.scanned || 0} and flagged ${flagged}. Reports are not being checked for going stale or stuck.`);
  }
  return notice('gr', 'warn', `${flagged} report(s) going wrong`,
    'The last check flagged them as stale, stuck or waiting too long for a person. They are at the top of the queue.');
}

// Reports that never became records. These messages were turned away above
// recordInbound, so they exist in no case, on no timeline and in no queue --
// there is nothing for an operator to go and look at, which is exactly why the
// count has to be said out loud. It sits beside the receiving notice because it
// is the same fact from the other end: one is casey not hearing, this is casey
// hearing and discarding.
//
// The count is since this process started and names no contact, because
// hooks/dropped-intake.js records an aggregate rather than a row per message --
// its header says why, and the honest consequence is stated here rather than
// implied: an operator learns how many and why, never which.
function droppedIntakeNotice() {
  const d = state.health.ai && state.health.ai.dropped_inbound;
  if (!d || !d.total) return null;
  const reasons = Object.values(d.reasons || {}).map(r => `${r.count} because ${r.detail}`);
  return notice('drop', 'error', `${d.total} incoming message(s) were discarded without being recorded`,
    reasons.join('; ') + '. Counted since this console started; no case or timeline holds them, and the count names no contact.');
}

export function HealthNotices() {
  return [receivingNotice(), droppedIntakeNotice(), aiNotice(), guardrailsNotice()].filter(Boolean);
}
