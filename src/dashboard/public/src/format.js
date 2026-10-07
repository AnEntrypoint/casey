import { state } from './state.js';
import { brandName } from './vocabulary.js';
import { word, hasWord } from './words.js';

function tz() { return (state.config && state.config.tz) || 'Africa/Johannesburg'; }
function tzLabel() { return (state.config && state.config.tz_label != null) ? state.config.tz_label : 'SAST'; }
function countryCode() { return (state.config && state.config.country_code) || '27'; }

const MS_NOT_SECONDS = 1e11;

export const NO_TIME_TEXT = 'not recorded';
export const FILTERED_EMPTY_TEXT = 'No reports match the filters you have on. Clear them to see the rest.';

export function toDate(v) {
  if (v == null || v === '') return null;
  if (!(typeof v === 'number' || /^\d+$/.test(String(v)))) {
    const d = new Date(v);
    return isNaN(d) ? null : d;
  }
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

export function waitFmt(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return rm ? h + 'h ' + rm + 'm' : h + 'h';
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? d + 'd ' + rh + 'h' : d + 'd';
}

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

export function stageLabel(s) { return hasWord('stages.' + s) ? word('stages.' + s) : s; }

const HEALTH_LABEL = {
  'health:stale': 'Going cold (no recent activity)',
  'health:stuck': 'Stuck in this stage too long',
  'health:unanswered_handoff': 'A person was asked for and not yet answered',
  'health:abandoned_intake': 'Intake left with on-site facts missing',
  'health:incomplete_critical': 'Working but visit-critical facts still missing',
  'health:never_closed': 'Resolved but never closed',
  'health:timestamp_corrupt': 'Case time data looks wrong',
  'health:unanswered_handoff_escalated': 'Still waiting for a person, well past the first deadline',
  'health:unsent_draft': 'A reply is written but nobody has sent it',
  'health:premature_complete': 'Marked done with facts a field visit needs still blank',
};
export function healthLabel(t) { return HEALTH_LABEL[t] || t; }

function deSnake(s) { return String(s || '').replace(/_/g, ' '); }

const CHANNEL_LABEL = {
  whatsapp: 'WhatsApp',
  discord: 'Discord',
  manual: 'entered by hand',
  form: 'the public form',
  web: 'the public form',
};
export function channelLabel(c) { return CHANNEL_LABEL[c] || deSnake(c); }

const REPLYABLE = { whatsapp: 'WhatsApp', discord: 'Discord' };
export function replyChannelLabel(c) { return REPLYABLE[c] || null; }

const PRIORITY_LABEL = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
export function priorityLabel(p) { return PRIORITY_LABEL[p] || deSnake(p); }

const CASE_TYPE_LABEL = {
  unset: 'Not set yet',
  outbreak: 'Symptom cluster',
  follow_up: 'Follow-up',
  lab_sample: 'Lab sample',
  import_alert: 'Import alert',
};
export function caseTypeLabel(t) { return CASE_TYPE_LABEL[t] || deSnake(t); }

const EVENT_KIND_LABEL = {
  inbound: 'Inbound', outbound: 'Reply', transition: 'Stage change',
  note: 'Note', observation: 'Note', action: 'Action', autonomy_change: 'Who answers changed',
};
export function eventKindLabel(kind) {
  if (EVENT_KIND_LABEL[kind]) return EVENT_KIND_LABEL[kind];
  const words = deSnake(String(kind || '').replace(/-+/g, ' ')).trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Event';
}
export function eventKindOptions() {
  return Object.entries(EVENT_KIND_LABEL).map(([id, label]) => ({ id, label }));
}

export function actorLabel(actor) {
  if (actor === 'agent') return brandName();
  const known = { operator: 'Operator', contact: 'Contact', system: 'System' };
  return known[actor] || deSnake(actor);
}

const STAGE_TONE_MAP = {
  new: 'accent', triaging: 'warn', in_progress: 'live', waiting: 'sun',
  resolved: 'success', closed: 'dim',
};
export function stageTone(s) { return STAGE_TONE_MAP[s] || ''; }

export function tagList(c) { return String((c && c.tags) || '').split(',').map((t) => t.trim()).filter(Boolean); }

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

const HEADLINE_MAX = 300;

const FIELD_MAX = 4000;

function bounded(s, max) {
  const t = String(s == null ? '' : s);
  if (t.length <= max) return t;
  return t.slice(0, max) + '... (shortened for display, ' + t.length + ' characters in full)';
}

export function headline(s) { return bounded(s, HEADLINE_MAX); }

export function reportValue(s) { return bounded(s, FIELD_MAX); }
