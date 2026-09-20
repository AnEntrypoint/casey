// Shared SAST timestamp + duration + phone formatters, ported byte-for-byte
// from the legacy app.js and parameterized by state.config.tz/tz_label/
// country_code (see dashboard/format.js on the server side -- this is the
// client mirror; CLI and this SPA render the same way).
//
// Merged superset of the per-worktree format.js variants -- every helper any
// consumer view/panel module imports is present here.

import { state } from './state.js';
import { brandName } from './vocabulary.js';

function tz() { return (state.config && state.config.tz) || 'Africa/Johannesburg'; }
function tzLabel() { return (state.config && state.config.tz_label != null) ? state.config.tz_label : 'SAST'; }
function countryCode() { return (state.config && state.config.country_code) || '27'; }

// Row timestamps may arrive as numeric-seconds STRINGS from busybase
// ("1782977388"). Never bare Date.parse -- accept a unix-seconds number/
// string or an ISO string and normalize to a JS Date.
// A bare digit value above this can only be milliseconds: as SECONDS it is the
// year 5138. Kept byte-identical in meaning to src/format.js's own toDate --
// the CLI and this SPA must render the same stored timestamp the same way.
const MS_NOT_SECONDS = 1e11;

export function toDate(v) {
  if (v == null || v === '') return null;
  if (!(typeof v === 'number' || /^\d+$/.test(String(v)))) {
    const d = new Date(v);
    return isNaN(d) ? null : d;
  }
  // Seconds is the convention; the guard is here because nothing enforces it and
  // the failure renders rather than throwing -- a millisecond value multiplied
  // again showed an operator the year 58656.
  const n = Number(v);
  const d = new Date(n >= MS_NOT_SECONDS ? n : n * 1000);
  return isNaN(d) ? null : d;
}

export function rel(v) {
  const d = toDate(v);
  if (!d) return '';
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 90) return '1m ago';
  const m = Math.round(s / 60);
  if (m < 45) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 36) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

// Elapsed duration from a since_ms span -> 'Xh Ym' / 'Xm' / 'Xd Yh', for the
// inbox waiting timer. Distinct from rel() ("time ago" off a timestamp).
export function waitFmt(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return rm ? h + 'h ' + rm + 'm' : h + 'h';
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? d + 'd ' + rh + 'h' : d + 'd';
}

// Generic duration formatter (fmtDur), used by metrics/handover panels for a
// bare ms span (SLA windows etc) -- coarser-grained than waitFmt.
export function fmtDur(ms) {
  if (ms == null || !Number.isFinite(ms)) return '--';
  const s = Math.round(ms / 1000);
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.round(m / 60);
  if (h < 48) return h + 'h';
  return Math.round(h / 24) + 'd';
}

export function fmtTime(v) {
  const d = toDate(v);
  if (!d) return '';
  const suffix = tzLabel() ? ' ' + tzLabel() : '';
  try {
    return d.toLocaleString('en-ZA', {
      timeZone: tz(), year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }) + suffix;
  } catch { return d.toLocaleString() + suffix; }
}

// Show a phone number the way an operator expects: a WhatsApp MSISDN like
// 27821234567 becomes +27 82 123 4567; a local 0821234567 stays 082 123 4567.
// Non-phone external_ids (discord/sim ids) pass through unchanged.
export function fmtPhone(v) {
  const s = String(v || '');
  const digits = s.replace(/[^0-9]/g, '');
  const cc = countryCode();
  if (new RegExp('^' + cc + '[0-9]{9}$').test(digits)) {
    const n = digits.slice(cc.length);
    return '+' + cc + ' ' + n.slice(0, 2) + ' ' + n.slice(2, 5) + ' ' + n.slice(5);
  }
  if (/^0[0-9]{9}$/.test(digits)) return digits.slice(0, 3) + ' ' + digits.slice(3, 6) + ' ' + digits.slice(6);
  return s;
}

const STAGE_LABEL = {
  new: 'New', triaging: 'Looking into it', in_progress: 'Working on it',
  waiting: 'Waiting', resolved: 'Done', closed: 'Closed',
};
// The only stage name an operator ever reads. It used to be gated behind a
// "plain-language mode" flag that defaulted off, so the raw thatcher enum
// (in_progress, triaging) was what actually shipped on screen. A workflow
// stage with no entry here (a deployment-added stage) still degrades to its
// raw name -- that is a missing label, not a mode.
export function stageLabel(s) { return STAGE_LABEL[s] || s; }

// Plain-English label for a health:* guardrail tag -- shared between the
// case-list's collapsed/expanded guardrail chips and the case-detail
// header's health badges so a raw underscore-separated enum key
// (e.g. "health:unanswered_handoff") never renders directly in
// user-facing chip copy in either surface.
const HEALTH_LABEL = {
  'health:stale': 'Going cold (no recent activity)',
  'health:stuck': 'Stuck in this stage too long',
  'health:unanswered_handoff': 'A person was asked for and not yet answered',
  'health:abandoned_intake': 'Intake left with on-site facts missing',
  'health:incomplete_critical': 'Working but visit-critical facts still missing',
  'health:never_closed': 'Resolved but never closed',
  'health:timestamp_corrupt': 'Case time data looks wrong',
  // These three were missing while the sweep emitted all ten, so healthLabel
  // fell through to its raw-key branch and an operator read
  // "health:premature_complete." as a sentence on a real case. inbox-panel.js
  // has always carried all ten; two tables for one vocabulary is how they came
  // to disagree. Keep this table equal to case-health.js's ALL_HEALTH_TAGS.
  'health:unanswered_handoff_escalated': 'Still waiting for a person, well past the first deadline',
  'health:unsent_draft': 'A reply is written but nobody has sent it',
  'health:premature_complete': 'Marked done with facts a field visit needs still blank',
};
// The fallback returns the raw tag deliberately -- a tag with no entry here has
// to be VISIBLE so it gets a label, rather than disappearing into a blank cell
// and taking its case's problem with it. It is a bug when it fires, not a
// design; the comment above says how to stop it firing.
export function healthLabel(t) { return HEALTH_LABEL[t] || t; }

// ---- the enums an operator reads -------------------------------------------
//
// A stored key is not a word. stageLabel and healthLabel above already hold
// that line for two vocabularies; these three hold it for the rest, and they
// are here rather than beside each caller because every one of them had
// already been mapped SOMEWHERE and left raw somewhere else:
//
//   channel   -- mapped nowhere, rendered raw in eight places, including a
//                reply box whose label read "Reply to contact on whatsapp"
//                and, on a case taken by hand or through the public form,
//                "Reply to contact on manual" / "on form" -- naming a channel
//                that does not exist and cannot be replied on.
//   priority  -- mapped in fields-editor.js's dropdown, raw in the case row's
//                chip, so one screen showed "Urgent" and "urgent".
//   case_type -- mapped in metrics-panel.js, raw in the clusters tooltip.
//
// An unmapped value falls through to a de-snaked form of its own key rather
// than vanishing: a deployment-added channel or type must show as itself.

function deSnake(s) { return String(s || '').replace(/_/g, ' '); }

// 'manual' and 'form' are not apps and have no inbound channel -- they are how
// a record came to exist. Naming them as places to reply is the bug this map
// closes; callers that need the "reply on X" phrasing ask replyChannelLabel
// below, which answers null for exactly those two.
const CHANNEL_LABEL = {
  whatsapp: 'WhatsApp',
  discord: 'Discord',
  manual: 'entered by hand',
  form: 'the public form',
  web: 'the public form',
};
export function channelLabel(c) { return CHANNEL_LABEL[c] || deSnake(c); }

// The app to reply ON, or null when there is no such app. A case opened by an
// operator or through the public web form has no channel back to the person.
const REPLYABLE = { whatsapp: 'WhatsApp', discord: 'Discord' };
export function replyChannelLabel(c) { return REPLYABLE[c] || null; }

const PRIORITY_LABEL = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
export function priorityLabel(p) { return PRIORITY_LABEL[p] || deSnake(p); }

// Kept equal to fields-editor.js's own OPTION_LABEL for these five keys and to
// metrics-panel.js's CASE_TYPE_LABEL -- 'unset' included, since a tooltip or a
// table cell has to say something for a type nobody has set.
const CASE_TYPE_LABEL = {
  unset: 'Not set yet',
  outbreak: 'Symptom cluster',
  follow_up: 'Follow-up',
  lab_sample: 'Lab sample',
  import_alert: 'Import alert',
};
export function caseTypeLabel(t) { return CASE_TYPE_LABEL[t] || deSnake(t); }

// Event kind and actor. These two lived in activity-panel.js, which is a panel
// -- so handover-panel.js, rendering the same two vocabularies in its "Changed
// this shift" rows, could not reach them and printed the raw keys instead
// ("autonomy_change by agent"). They are labels, so they live with the labels
// and the panel imports them like everyone else.
//
// The store carries kinds this map does not name (degraded_turn reaches the
// screen today), so an unmapped kind reads as a WORD rather than as snake_case
// sitting beside humanised labels in the same column.
const EVENT_KIND_LABEL = {
  inbound: 'Inbound', outbound: 'Reply', transition: 'Stage change',
  note: 'Note', observation: 'Note', action: 'Action', autonomy_change: 'Autonomy',
};
export function eventKindLabel(kind) {
  if (EVENT_KIND_LABEL[kind]) return EVENT_KIND_LABEL[kind];
  const words = deSnake(String(kind || '').replace(/-+/g, ' ')).trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Event';
}
// The kinds a filter control can offer. Only the named ones: an unmapped kind
// is something the store happens to hold, not a choice to put in a dropdown.
export function eventKindOptions() {
  return Object.entries(EVENT_KIND_LABEL).map(([id, label]) => ({ id, label }));
}

// 'agent' is the product, so it is named the way every other surface names it.
// A function rather than a constant: state.config is not populated at module
// eval time.
export function actorLabel(actor) {
  if (actor === 'agent') return brandName();
  const known = { operator: 'Operator', contact: 'Contact', system: 'System' };
  return known[actor] || deSnake(actor);
}

// Stage tone for the quick-filter pill strip -- stages are config-driven
// (thatcher.config.yml), not a fixed enum, so this maps common stage name
// shapes to a distinct tone each rather than an exhaustive per-stage table;
// an unrecognized stage name degrades to the neutral default tone.
const STAGE_TONE_MAP = {
  new: 'accent', triaging: 'warn', in_progress: 'live', waiting: 'sun',
  resolved: 'success', closed: 'dim',
};
export function stageTone(s) { return STAGE_TONE_MAP[s] || ''; }

export function tagList(c) { return String((c && c.tags) || '').split(',').map((t) => t.trim()).filter(Boolean); }

// A case needs a human's attention right now (drives the attn dot + counts).
export function attn(c) {
  return c.autonomy === 'observe' || c.autonomy === 'assisted' || tagList(c).includes('needs-human');
}

export function isMine(c) {
  return !!(state.currentUser && state.currentUser.username) && c && c.assignee === state.currentUser.username;
}

export function ageHoursOf(c) {
  const d = toDate(c.updated_at || c.created_at);
  return d ? (Date.now() - d.getTime()) / 3600000 : 0;
}

// ---- headline text: bounded, so one malformed record cannot take the screen
//      down -----------------------------------------------------------------
//
// A subject is written by the agent from what a reporter said, so its length is
// contact-influenced and nothing upstream bounds it. Rendered as the bare text
// child of a WRAPPING FLEX container -- which is what both the case-detail
// heading (h2.casey-case-ref, subject plus its action buttons on one line) and
// the map rail's queue row (.tcase-why) are -- a long string with no break
// opportunity in it becomes an anonymous flex item that the engine has to
// measure at max-content and then re-wrap, and the cost is superlinear.
//
// Measured live over CDP against this dashboard: a 15,000-character subject
// renders in about zero time, a 30,000-character one FREEZES the renderer
// permanently -- the tab never recovers, no console error, nothing on screen.
// The same 30,000 characters broken by spaces every ten render instantly, and
// the same case with display:block on that heading renders instantly too, so
// the trigger is the unbreakable run inside the wrapping flex box, not the
// byte count. It is reachable from a single inbound message, so it is an
// availability property of the operator console, not a cosmetic one.
//
// Even below the freeze it is not a heading: 30,000 characters measured 41,686
// pixels tall, pushing every control on the case off the screen.
//
// So a headline is bounded here, once, for every surface that renders one. The
// cap is far above any real subject (the seeded corpus's longest is 46
// characters) and the truncation is STATED rather than silent -- the full value
// is never the only copy on screen: the case-detail form's own Subject field is
// an <input>, which is single-line, cheap at any length, and editable.
const HEADLINE_MAX = 300;

// Every text field the dashboard itself can write is capped at 4000 characters
// server-side (server.js's MAX_LEN) and at 2000 in the report-field editor, so
// a stored value longer than this did not come from any operator write and is
// already outside the contract. The display bound sits AT the server's own cap
// rather than below it: nothing a person could have typed here is ever cut.
const FIELD_MAX = 4000;

function bounded(s, max) {
  const t = String(s == null ? '' : s);
  if (t.length <= max) return t;
  return t.slice(0, max) + '... (shortened for display, ' + t.length + ' characters in full)';
}

export function headline(s) { return bounded(s, HEADLINE_MAX); }

// A report field's own value. Same failure mode as a heading and the same
// bound-plus-real-flex-item fix: .casey-rep-editable is an inline-flex box
// (value, pencil, provenance chip) and the value used to be its bare text
// child, so a 200,000-character field measured at max-content on one
// unbreakable line and froze the renderer -- witnessed live on a case carrying
// one. Unlike a heading this is content an operator has to READ, so the bound
// is the server's own write cap and the true length is stated.
export function reportValue(s) { return bounded(s, FIELD_MAX); }
