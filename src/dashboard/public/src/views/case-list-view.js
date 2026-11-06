import * as webjsx from 'webjsx';
import { state, schedule, setMineOnly, setCases } from '../state.js';
import { tagList, isMine, FILTERED_EMPTY_TEXT } from '../format.js';
import * as api from '../api.js';
import { loadRoster } from '../api-roles.js';
import { toast } from '../toasts.js';
import { saveCurrentView, applyNamedView } from '../saved-views.js';
import { SearchBar, MoreFilters, StagePills, refreshSavedViews } from './case-list/filters-bar.js';
import { InboxPanel } from './case-list/inbox-panel.js';
import { BulkBar } from './case-list/bulk-bar.js';
import { VirtualizedCaseList, PlainCaseList, VIRTUALIZE_THRESHOLD } from './case-list/virtualized-list.js';
import { confirmDialog } from '../components/dialog-shell.js';
import { FilterChip, ClearChip, QueueMore } from '../components/filter-chip.js';
import { Alert } from 'ds/components/content.js';
import { Btn } from 'ds/components/shell.js';
import { word } from '../words.js';
const h = webjsx.createElement;

let listError = '';
export function setListError(msg) { listError = msg || ''; }

function parseReportJson(raw) {
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

const TOTAL_PROBE_MS = 30e3;
let lastProbeAt = 0;
function probeTotal() {
  if (state.inboxMode) return;
  const now = Date.now();
  if (now - lastProbeAt < TOTAL_PROBE_MS) return;
  lastProbeAt = now;
  if (more.rows.length) showMore(true);
  api.fetchCases({ limit: 1 })
    .then((r) => {
      if (!r || typeof r.total !== 'number' || r.total === state.allCasesTotal) return;
      setCases(state.allCases, r.total);
    })
    .catch(() => {  });
}

function pageRangeText() {
  const loaded = loadedRows().length;
  const total = state.allCasesTotal;
  if (state.inboxMode) return word('ui.case_list_view_not_loaded');
  if (wide.rows) return word('ui.case_list_view_searched_all', { total });
  if (!total) return loaded ? word('ui.case_list_view_loaded_so_far', { n: loaded }) : word('ui.case_list_view_nothing_loaded');
  if (total > loaded) return word('ui.case_list_view_showing', { loaded, total });
  return word(total === 1 ? 'ui.case_list_view_all_one' : 'ui.case_list_view_all_many', { total });
}

let expandedGuardrailId = null;
function toggleGuardrails(id) { expandedGuardrailId = expandedGuardrailId === id ? null : id; schedule(); }

let attentionOnly = false;
function attentionIds() {
  const s = new Set();
  for (const a of state.attention || []) if (a && a.id != null) s.add(a.id);
  return s;
}

export function matchesClientFilt(c) {
  if (state.mineOnly && !isMine(c)) return false;
  if (state.filt.status && c.status !== state.filt.status) return false;
  if (state.filt.channel && c.channel !== state.filt.channel) return false;
  if (state.filt.q) {
    const hay = [c.ref, c.subject, c.summary, c.channel, c.assignee, c.status, c.tags]
      .filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(state.filt.q.toLowerCase())) return false;
  }
  if (state.filt.source) {
    const tags = tagList(c);
    if (state.filt.source === 'manual' && !tags.includes('intake_mode:manual')) return false;
    if (state.filt.source === 'channel' && !tags.includes('intake_mode:channel')) return false;
    if (state.filt.source === 'public_form' && !tags.includes('intake_mode:public_form')) return false;
  }
  const fv = state.filt.fv;
  if (fv && Object.values(fv).some(Boolean)) {
    const rep = parseReportJson(c.report);
    for (const [k, want] of Object.entries(fv)) {
      if (!want) continue;
      if (String(rep[k] == null ? '' : rep[k]).trim().toLowerCase() !== String(want).trim().toLowerCase()) return false;
    }
  }
  return true;
}

function anyFieldValueFilter() {
  return Object.values(state.filt.fv || {}).some(Boolean);
}

export function anyFilterActive() {
  return !!(state.mineOnly || attentionOnly || state.filt.q || state.filt.status || state.filt.channel || state.filt.source || anyFieldValueFilter());
}

const PAGE = 200;
const OVERLAP = 10;
const more = { rows: [], want: 0, busy: false, failed: false };
const wide = { key: '', rows: null, total: 0, timer: null, at: 0, failed: false };

function loadedRows() {
  if (!more.rows.length) return state.allCases || [];
  const seen = new Set((state.allCases || []).map((c) => c.id));
  return (state.allCases || []).concat(more.rows.filter((c) => !seen.has(c.id)));
}

async function showMore(refresh) {
  if (more.busy) return;
  more.busy = true; more.failed = false; schedule();
  try {
    if (!refresh) more.want += PAGE;
    const first = (state.allCases || []).length;
    const start = Math.max(0, first - OVERLAP);
    const target = more.want + (first - start);
    const rows = [];
    while (rows.length < target) {
      const r = await api.fetchCases({ limit: Math.min(PAGE, target - rows.length), offset: start + rows.length });
      const page = (r && r.cases) || [];
      if (r && typeof r.total === 'number' && r.total !== state.allCasesTotal) state.allCasesTotal = r.total;
      rows.push(...page);
      if (page.length === 0) break;
    }
    more.rows = rows;
  } catch { more.failed = true; }
  more.busy = false; schedule();
}

const narrowing = () => !!(state.filt.q || state.filt.status || state.filt.channel);
function ensureWide(now) {
  const partial = !state.inboxMode && narrowing() && state.allCasesTotal > loadedRows().length;
  if (!partial) { wide.rows = null; wide.key = ''; return; }
  const key = JSON.stringify([state.filt.q || '', state.filt.status || '', state.filt.channel || '']);
  const stale = key === wide.key && now - wide.at > TOTAL_PROBE_MS;
  if (key === wide.key && !stale) return;
  const sameKey = key === wide.key;
  wide.key = key; wide.at = now; wide.failed = false;
  if (!sameKey) wide.rows = null;
  clearTimeout(wide.timer);
  wide.timer = setTimeout(async () => {
    try {
      const r = await api.fetchCases({ q: state.filt.q, status: state.filt.status, channel: state.filt.channel, limit: PAGE });
      if (wide.key !== key) return;
      wide.rows = (r && r.cases) || []; wide.total = (r && r.total) || wide.rows.length;
      schedule();
    } catch {
      if (wide.key !== key) return;
      wide.failed = true; schedule();
    }
  }, sameKey ? 0 : 300);
}

export function visibleCases() {
  const base = (wide.rows || loadedRows()).filter(matchesClientFilt);
  if (!attentionOnly) return base;
  const ids = attentionIds();
  return base.filter((c) => ids.has(c.id));
}

async function promptSaveView() {
  const name = ((await confirmDialog({ title: word('ui.case_list_view_save_title'), inputLabel: word('ui.case_list_view_save_label') })) || '').trim();
  if (!name) return;
  const r = saveCurrentView(name);
  if (!r.ok) { toast(r.error, 'err'); return; }
  refreshSavedViews();
  toast(word('ui.case_list_view_saved', { name }), 'ok');
  schedule();
}

function listChips() {
  const loaded = loadedRows();
  const ids = attentionIds();
  const needCount = loaded.filter((c) => ids.has(c.id)).length;
  const mineCount = loaded.filter(isMine).length;

  const chip = (key, label, count, on, onClick, title) => FilterChip({ key, label, count, on, onClick, title });

  return h('div', { class: 'ds-filter-pills' },
    chip('attn', word('ui.case_list_view_need_person'), needCount, attentionOnly,
      () => { attentionOnly = !attentionOnly; schedule(); },
      word('ui.case_list_view_need_title')),
    chip('mine', word('ui.case_list_view_yours'), mineCount, state.mineOnly,
      () => setMineOnly(!state.mineOnly),
      word('ui.case_list_view_yours_title')),
    (attentionOnly || state.mineOnly)
      ? ClearChip({ onClick: () => { attentionOnly = false; setMineOnly(false); } })
      : null);
}

function listBody(shown) {
  if (state.inboxMode) {
    return h('div', { class: 'ds-case-list-empty empty' },
      word('ui.case_list_view_focus_on'));
  }
  if (!(state.allCases || []).length && listError) return null;
  if (!(state.allCases || []).length) {
    return h('div', { class: 'ds-case-list-empty empty' },
      word('ui.case_list_view_empty'));
  }
  if (!shown.length) {
    return h('div', { class: 'ds-case-list-empty empty' },
      FILTERED_EMPTY_TEXT);
  }
  return shown.length > VIRTUALIZE_THRESHOLD
    ? VirtualizedCaseList({ cases: shown, expandedGuardrails: expandedGuardrailId, onToggleGuardrails: toggleGuardrails })
    : PlainCaseList({ cases: shown, expandedGuardrails: expandedGuardrailId, onToggleGuardrails: toggleGuardrails });
}

export function CaseListView({ onPromptTag, onPromptNote, onReloadCases }) {
  loadRoster(schedule);
  ensureWide(Date.now());
  const shown = visibleCases();
  queueMicrotask(probeTotal);

  return h('div', { class: 'case-list-view' },
    InboxPanel(),

    listError ? h('div', { key: 'lerr' }, Alert({ kind: 'warn', children: h('div', {}, listError + ' ', Btn({ size: 'sm', variant: 'ghost', children: word('ui.case_list_view_try_again'), onClick: () => onReloadCases && onReloadCases() })) })) : null,

    h('div', { key: 'lhead', class: 'ds-cl-section-head' },
      h('h2', { class: 'ds-cl-section-title' }, word('ui.case_list_view_all_reports')),
      h('span', { class: 'ds-cl-range' }, pageRangeText()),
      (!state.inboxMode && !wide.rows && state.allCasesTotal > loadedRows().length && !narrowing())
        ? QueueMore({ key: 'more', onClick: () => showMore(false),
          children: more.busy ? word('ui.case_list_view_loading') : word('ui.case_list_view_show_more', { n: Math.min(PAGE, state.allCasesTotal - loadedRows().length) }) })
        : null,
      more.failed
        ? Btn({ key: 'more-retry', size: 'sm', variant: 'ghost', children: word('ui.case_list_view_more_failed'), onClick: () => showMore(true) })
        : null,
      wide.failed
        ? Btn({ key: 'wide-retry', size: 'sm', variant: 'ghost', children: word('ui.case_list_view_search_failed'), onClick: () => { wide.key = ''; wide.failed = false; schedule(); } })
        : null,
      anyFilterActive()
        ? h('span', { class: 'ds-cl-match' }, word('ui.case_list_view_matches', { n: shown.length })
          + (wide.rows && wide.total > wide.rows.length ? word('ui.case_list_view_matches_partial', { first: wide.rows.length, total: wide.total }) : ''))
        : null),
    listChips(),

    SearchBar({ resultCount: shown.length }),
    StagePills(),
    h('details', { class: 'ds-rail-disclosure ds-cl-more' },
      h('summary', {}, word('ui.case_list_view_more_ways')),
      h('div', { class: 'ds-rail-disclosure-body' },
        MoreFilters({
          onOpenSavedViews: (name) => { applyNamedView(name); onReloadCases && onReloadCases(); },
          onSaveView: promptSaveView,
        }))),

    BulkBar({ stages: (state.config && state.config.stages) || [], onDone: onReloadCases, onPromptTag, onPromptNote }),
    listBody(shown)
  );
}
