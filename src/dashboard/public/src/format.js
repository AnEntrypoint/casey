// Shared SAST timestamp + duration + phone formatters, ported byte-for-byte
// from the legacy app.js and parameterized by state.config.tz/tz_label/
// country_code (see dashboard/format.js on the server side -- this is the
// client mirror; CLI and this SPA render the same way).
//
// Merged superset of the per-worktree format.js variants -- every helper any
// consumer view/panel module imports is present here.

import { state } from './state.js';

function tz() { return (state.config && state.config.tz) || 'Africa/Johannesburg'; }
function tzLabel() { return (state.config && state.config.tz_label != null) ? state.config.tz_label : 'SAST'; }
function countryCode() { return (state.config && state.config.country_code) || '27'; }

// Row timestamps may arrive as numeric-seconds STRINGS from busybase
// ("1782977388"). Never bare Date.parse -- accept a unix-seconds number/
// string or an ISO string and normalize to a JS Date.
export function toDate(v) {
  if (v == null || v === '') return null;
  const d = (typeof v === 'number' || /^\d+$/.test(String(v))) ? new Date(Number(v) * 1000) : new Date(v);
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
// Friendly label in simple mode, raw stage name otherwise. A stage with no
// entry (a deployment-added workflow stage) degrades to its raw name.
export function stageLabel(s) { return state.simpleMode ? (STAGE_LABEL[s] || s) : s; }

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
};
export function healthLabel(t) { return HEALTH_LABEL[t] || t; }

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
