// The case-list home view, bottom line up front.
//
// THE BOTTOM LINE OF THIS VIEW IS THE WORST-FIRST QUEUE. This is a duty
// roster: the operator's question on opening it is "who needs me, worst
// first", not "how many reports exist". So the queue is the first thing under
// the head, and everything that changes the question -- search, stage pills,
// channel/source/saved views -- sits below it, in that order of how often it
// is actually reached for.
//
// Three things this head must NOT carry, each of which shipped once:
//
//   - An <h1> brand. app-view.js already renders `brand` in both Topbar and
//     Crumb, so a third copy takes the slot the answer should hold.
//
//   - A "N total - M need attention" counts line. Any M derived here is a
//     SECOND derivation: format.js's attn() (autonomy observe/assisted, or a
//     needs-human tag) is not the shared urgency ladder, so it disagrees with
//     the status bar's server-ranked state.attention.length on the same
//     screen. In Focus mode state.allCases is never loaded at all (main.js
//     suppresses the list poll), so any count over it reads 0 above a queue
//     holding rows. The counts that survive are chips, and each one IS the
//     filter it reports.
//
//   - A pager. state.page/state.pageSize reach the server from nowhere: both
//     callers of api.fetchCases() for this list (main.js's loadCases and
//     reloadCases below) pass no params, so every fetch is an offset-0 page
//     and main.js re-fetches page one every 5 seconds. A Next button here
//     re-renders the same rows.
//
// A cap statement is a safety property here: two reports the operator cannot
// see and cannot be told about is how report 36 stops existing. State the cap
// from the SERVER's own total, at the TOP of the list.

import * as webjsx from 'webjsx';
import { state, schedule, setMineOnly, setCases } from '../state.js';
import { tagList, isMine } from '../format.js';
import * as api from '../api.js';
import { loadRoster } from '../api-roles.js';
import { toast } from '../toasts.js';
import { saveCurrentView, applyNamedView } from '../saved-views.js';
import { SearchBar, MoreFilters, StagePills, refreshSavedViews } from './case-list/filters-bar.js';
import { InboxPanel } from './case-list/inbox-panel.js';
import { BulkBar } from './case-list/bulk-bar.js';
import { VirtualizedCaseList, PlainCaseList, VIRTUALIZE_THRESHOLD } from './case-list/virtualized-list.js';
import { confirmDialog } from '../components/dialog-shell.js';
// One definition of the counted filter chip, shared with the map home view --
// see components/filter-chip.js for why a second local copy of the control is
// the same class of defect as a second local copy of the predicate it applies.
import { FilterChip, ClearChip, QueueMore } from '../components/filter-chip.js';
const h = webjsx.createElement;

// The report blob as it arrives on a list row: a JSON string on the wire,
// already absent or unparseable on a row that never got one.
function parseReportJson(raw) {
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

// How many reports the server says exist, versus how many arrived. The list
// poll that owns state.allCases lives in main.js and does not ask for the
// total, so this asks for it directly -- a limit=1 request, which returns one
// row and the count. Re-asked at the attention poll's own cadence so a total
// that moves while the operator is reading does not sit frozen; skipped
// entirely in Focus mode, where the list is deliberately not loaded.
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
    .catch(() => { /* the connection banner already surfaces a dead API */ });
}

// The cap and the true total in one plain sentence, or an honest admission that
// the total is not known yet. Never the loaded count on its own: "35 reports"
// over a 37-report deployment is a true number that tells a lie.
function pageRangeText() {
  const loaded = loadedRows().length;
  const total = state.allCasesTotal;
  if (state.inboxMode) return 'Not loaded (Focus mode)';
  if (wide.rows) return 'Searched all ' + total + ' reports';
  if (!total) return loaded ? loaded + ' loaded so far' : 'Nothing loaded yet';
  if (total > loaded) return 'Showing ' + loaded + ' of ' + total + ' reports';
  return 'All ' + total + ' report' + (total === 1 ? '' : 's');
}

let expandedGuardrailId = null;
function toggleGuardrails(id) { expandedGuardrailId = expandedGuardrailId === id ? null : id; schedule(); }

// Narrow the full list to the cases the guardrails are chasing. Module-local
// rather than a new state.js field, matching expandedGuardrailId above and
// leaving the shared filter object alone; state.js is not this session's to
// change. The membership test reads state.attention -- the same server-ranked
// list the queue is built from, never a second local predicate.
let attentionOnly = false;
function attentionIds() {
  const s = new Set();
  for (const a of state.attention || []) if (a && a.id != null) s.add(a.id);
  return s;
}

// EVERY filter is applied here, over the rows that are loaded.
//
// This function used to apply two of them (Mine and source) and carried a
// comment saying the server already applied the other three -- search text,
// stage and channel -- "see api.js fetchCases params". It does not, and it
// never could: both call sites that load this list (main.js's loadCases and
// case-list-detail-layout.js's reloadCases) call api.fetchCases() with NO
// arguments, so the query string is always empty and every fetch is an
// unfiltered offset-0 page. The search box, the stage pills and the channel
// select were therefore inert -- witnessed live at 1440x900: typing "Musina"
// and pressing Enter left all 35 rows on screen. Three controls that changed
// nothing, above a list, on a triage screen.
//
// Applying them here rather than fixing the fetch is deliberate: main.js owns
// the poll that overwrites state.allCases every 5 seconds with an unfiltered
// page, so a server-side narrowing would be undone within one tick. Narrowing
// what is loaded is immediate, survives the poll, and is honest as long as the
// head keeps saying how much of the deployment is loaded -- which it now does.
export function matchesClientFilt(c) {
  if (state.mineOnly && !isMine(c)) return false;
  if (state.filt.status && c.status !== state.filt.status) return false;
  if (state.filt.channel && c.channel !== state.filt.channel) return false;
  if (state.filt.q) {
    // Only over fields the PII-free /api/cases projection actually returns --
    // external_id and contact_id are deliberately not in it, so there is no
    // phone number here to search and the placeholder no longer offers one.
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
  // Known-value report-field narrowing (filters-bar.js's knownValueFilters).
  // The report blob is already in the PII-free /api/cases projection, so this
  // needs no extra fetch. Compared case-insensitively on the trimmed value and
  // nothing further: the options offered ARE stored values, so an exact-ish
  // compare is the honest reading of "reports whose species is this one" -- it
  // deliberately does not token-match, which would quietly widen "cattle" to
  // every row that happens to mention cattle somewhere.
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

// ---- reports beyond the first page ------------------------------------------------------
// The server sends the newest 50 by default and the list poll only ever asks for that page, so on
// a deployment with more, the older reports were unreachable: no pager, and search/stage/channel
// only looked at the 50 loaded. Two remedies live here, both kept out of state.allCases (which
// the poll rewrites every few seconds and the chip counts read):
//   - "Show more": further pages, appended after the poll's own page;
//   - a narrowed search (text, stage or channel) is asked of the server across every report.
const PAGE = 200;
// Pages are fetched by offset while the order underneath them can shift (a report that is
// touched moves to the top), so each fetch starts a little before where the loaded rows end and
// the overlap is dropped by id: a small shift then costs nothing instead of losing a row.
const OVERLAP = 10;
const more = { rows: [], want: 0, busy: false };
const wide = { key: '', rows: null, total: 0, timer: null, at: 0 };

function loadedRows() {
  if (!more.rows.length) return state.allCases || [];
  const seen = new Set((state.allCases || []).map((c) => c.id));
  return (state.allCases || []).concat(more.rows.filter((c) => !seen.has(c.id)));
}

async function showMore(refresh) {
  if (more.busy) return;
  more.busy = true; schedule();
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
  } catch { /* the connection banner already surfaces a dead API */ }
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
  wide.key = key; wide.at = now;
  if (!sameKey) wide.rows = null;
  clearTimeout(wide.timer);
  wide.timer = setTimeout(async () => {
    try {
      const r = await api.fetchCases({ q: state.filt.q, status: state.filt.status, channel: state.filt.channel, limit: PAGE });
      if (wide.key !== key) return;
      wide.rows = (r && r.cases) || []; wide.total = (r && r.total) || wide.rows.length;
      schedule();
    } catch { /* keep the loaded rows */ }
  }, sameKey ? 0 : 300);
}

export function visibleCases() {
  const base = (wide.rows || loadedRows()).filter(matchesClientFilt);
  if (!attentionOnly) return base;
  const ids = attentionIds();
  return base.filter((c) => ids.has(c.id));
}

async function promptSaveView() {
  const name = ((await confirmDialog({ title: 'Save this view', inputLabel: 'Name this view (e.g. "my urgent", "Musina handoffs"):' })) || '').trim();
  if (!name) return;
  const r = saveCurrentView(name);
  if (!r.ok) { toast(r.error, 'err'); return; }
  // Invalidate the menu's cache before the toast claims the save worked. Until
  // this existed the menu read a state field nothing wrote, so the toast was
  // the only evidence a view had been saved and the view itself never appeared.
  refreshSavedViews();
  toast('Saved view "' + name + '"', 'ok');
  schedule();
}

// Each chip states a count AND applies it. The count is taken over exactly the
// set the chip narrows -- the loaded report list -- so pressing it can never
// produce a different number than the one on its face.
function listChips() {
  const loaded = loadedRows();
  const ids = attentionIds();
  const needCount = loaded.filter((c) => ids.has(c.id)).length;
  const mineCount = loaded.filter(isMine).length;

  const chip = (key, label, count, on, onClick, title) => FilterChip({ key, label, count, on, onClick, title });

  return h('div', { class: 'ds-filter-pills' },
    chip('attn', 'need a person', needCount, attentionOnly,
      () => { attentionOnly = !attentionOnly; schedule(); },
      'Show only the reports the guardrails are chasing'),
    chip('mine', 'yours', mineCount, state.mineOnly,
      () => setMineOnly(!state.mineOnly),
      'Show only the reports you have claimed'),
    (attentionOnly || state.mineOnly)
      ? ClearChip({ onClick: () => { attentionOnly = false; setMineOnly(false); } })
      : null);
}

// Three different facts, three different sentences. Rendering all of them as an
// empty list tells the operator none of them -- and the Focus one is the
// dangerous case, because Focus mode deliberately stops the report list loading
// (main.js suppresses the poll), so an empty list there is not a statement
// about the deployment at all.
function listBody(shown) {
  if (state.inboxMode) {
    return h('div', { class: 'ds-case-list-empty empty' },
      'Focus mode is on, so only the queue above is loaded. Use "Also load every other report" above, or the Focus button in the top bar, to see the rest.');
  }
  if (!(state.allCases || []).length) {
    return h('div', { class: 'ds-case-list-empty empty' },
      'No reports yet. They arrive here as soon as a field worker sends one.');
  }
  if (!shown.length) {
    return h('div', { class: 'ds-case-list-empty empty' },
      'No reports match the filters you have on. Clear them to see the rest.');
  }
  return shown.length > VIRTUALIZE_THRESHOLD
    ? VirtualizedCaseList({ cases: shown, expandedGuardrails: expandedGuardrailId, onToggleGuardrails: toggleGuardrails })
    : PlainCaseList({ cases: shown, expandedGuardrails: expandedGuardrailId, onToggleGuardrails: toggleGuardrails });
}

export function CaseListView({ onPromptTag, onPromptNote, onReloadCases }) {
  loadRoster(schedule);
  ensureWide(Date.now());
  const shown = visibleCases();
  // Out of the render pass, like map-panel.js's own canvas mount: this can call
  // setCases, and a state mutation inside a render would re-enter schedule().
  queueMicrotask(probeTotal);

  return h('div', { class: 'case-list-view' },
    // 1. THE ANSWER. Worst-first, capped only with its true total stated on the
    //    control that lifts the cap.
    InboxPanel(),

    // 2. EVERY report, with the size of what is loaded stated before the rows
    //    rather than under them, and the counts that are also the controls.
    // Two single-purpose facts rather than one compound sentence: how much of
    // the deployment is loaded (the cap), and separately how much of that the
    // filters currently leave. Merging them into one line was how "35 results"
    // came to sit above a list showing something else entirely.
    h('div', { key: 'lhead', class: 'ds-cl-section-head' },
      h('h2', { class: 'ds-cl-section-title' }, 'All reports'),
      h('span', { class: 'ds-cl-range' }, pageRangeText()),
      // The next page of reports, beside the count it changes (the list below is its own
      // scroll region, so a control under it would sit out of sight). Not shown while a search
      // or stage is narrowing: those already ask the server across every report.
      (!state.inboxMode && !wide.rows && state.allCasesTotal > loadedRows().length && !narrowing())
        ? QueueMore({ key: 'more', onClick: () => showMore(false),
          children: more.busy ? 'Loading...' : 'Show ' + Math.min(PAGE, state.allCasesTotal - loadedRows().length) + ' more' })
        : null,
      anyFilterActive()
        ? h('span', { class: 'ds-cl-match' }, shown.length + ' match the filters you have on'
          + (wide.rows && wide.total > wide.rows.length ? ' (the first ' + wide.rows.length + ' of ' + wide.total + ' -- narrow the search to see the rest)' : ''))
        : null),
    listChips(),

    // 3. THE CONTROLS THAT CHANGE THE QUESTION. Search and stage are the two
    //    reached for constantly and stay in the open; the rest are one worded
    //    click away rather than four permanent rows above the answer.
    SearchBar({ resultCount: shown.length }),
    StagePills(),
    h('details', { class: 'ds-rail-disclosure ds-cl-more' },
      h('summary', {}, 'More ways to narrow this'),
      h('div', { class: 'ds-rail-disclosure-body' },
        MoreFilters({
          onOpenSavedViews: (name) => { applyNamedView(name); onReloadCases && onReloadCases(); },
          onSaveView: promptSaveView,
        }))),

    BulkBar({ stages: (state.config && state.config.stages) || [], onDone: onReloadCases, onPromptTag, onPromptNote }),
    listBody(shown)
  );
}
