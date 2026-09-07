// The case-list home view, bottom line up front.
//
// THE BOTTOM LINE OF THIS VIEW IS THE WORST-FIRST QUEUE. This is a duty
// roster: the operator's question on opening it is "who needs me, worst
// first", not "how many reports exist". So the queue is the first thing under
// the head, and everything that changes the question -- search, stage pills,
// channel/source/saved views -- sits below it, in that order of how often it
// is actually reached for.
//
// What this view opened with before, in order, was: the deployment's brand name
// as an <h1>; a text line reading "N total - M need attention"; a row of five
// filter controls; a second row of stage pills; and only then the queue. The
// answer was fourth on a screen whose first three rows were an identity the
// topbar already states twice (app-view.js renders `brand` in both Topbar and
// Crumb) and controls for a question nobody had asked yet.
//
// Two things went with the head, not for tidiness:
//
//   - The <h1> brand. Three copies of "casey"/"uhh" on one screen, and the
//     largest of them in the slot the most operationally important sentence
//     should hold.
//
//   - CountsLine's "N total - M need attention". It was a number an operator
//     could read and not act on -- the same failure four deleted stat tiles on
//     the map side had ("Needs attention 3 / see below"). Worse, its M came
//     from format.js's attn() -- a client-side predicate (autonomy is observe
//     or assisted, or a needs-human tag) that is NOT the shared urgency ladder.
//     The status bar three rows below it states `${state.attention.length} need
//     a person` from the server-ranked list, so the same screen printed two
//     different answers to one question from two derivations. And in Focus mode
//     state.allCases is never loaded at all (main.js suppresses the list poll),
//     so this line read "0 total - 0 need attention" directly above a queue
//     holding fourteen rows.
//
// The counts that survive are chips, and each one IS the filter it reports.
//
// The pager went too, and that one needs naming because it looked like a
// working feature. views/case-list/pagination.js rendered Prev / "Page 1 of N"
// / Next / rows-per-page against state.page and state.pageSize -- and NOTHING
// in the SPA ever sent either of them to the server. The only two callers of
// api.fetchCases() for this list (main.js's loadCases, and reloadCases below)
// both call it with no params at all, so every fetch is offset 0, and main.js
// re-fetches page one every 5 seconds regardless. Pressing Next re-rendered the
// same 35 rows. Worse, its own range line read state.allCasesTotal, which no
// module ever published (state.js's setCases was never called for this list),
// so the total was permanently 0 and the honest-range branch was unreachable:
// the shipped build stated "0 cases" under a list of 35, over a deployment the
// server said had 37. Measured live at http://localhost:4410/api/cases --
// total 37, limit 50, returned 35, and not one word of it on screen.
//
// A cap statement is a safety property here: two reports the operator cannot
// see and cannot be told about is how report 36 stops existing. So the cap is
// stated, from the server's own total, at the TOP of the list; and the control
// that could not page anything is gone rather than left as decoration.

import * as ds from '/design/dist/247420.js';
import { state, schedule, setMineOnly, setCases } from '../state.js';
import { tagList, isMine } from '../format.js';
import * as api from '../api.js';
import { toast } from '../toasts.js';
import { saveCurrentView, applyNamedView } from '../saved-views.js';
import { SearchBar, MoreFilters, StagePills } from './case-list/filters-bar.js';
import { InboxPanel } from './case-list/inbox-panel.js';
import { BulkBar } from './case-list/bulk-bar.js';
import { VirtualizedCaseList, PlainCaseList, VIRTUALIZE_THRESHOLD } from './case-list/virtualized-list.js';
import { confirmDialog } from '../components/dialog-shell.js';
const h = ds.h;

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
  const loaded = (state.allCases || []).length;
  const total = state.allCasesTotal;
  if (state.inboxMode) return 'Not loaded (Focus mode)';
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
  return true;
}

export function anyFilterActive() {
  return !!(state.mineOnly || attentionOnly || state.filt.q || state.filt.status || state.filt.channel || state.filt.source);
}

export function visibleCases() {
  const base = state.allCases.filter(matchesClientFilt);
  if (!attentionOnly) return base;
  const ids = attentionIds();
  return base.filter((c) => ids.has(c.id));
}

async function promptSaveView() {
  const name = ((await confirmDialog({ title: 'Save this view', inputLabel: 'Name this view (e.g. "my urgent", "Musina handoffs"):' })) || '').trim();
  if (!name) return;
  const r = saveCurrentView(name);
  if (!r.ok) { toast(r.error, 'err'); return; }
  toast('Saved view "' + name + '"', 'ok');
}

// Each chip states a count AND applies it. The count is taken over exactly the
// set the chip narrows -- the loaded report list -- so pressing it can never
// produce a different number than the one on its face.
function listChips() {
  const loaded = state.allCases || [];
  const ids = attentionIds();
  const needCount = loaded.filter((c) => ids.has(c.id)).length;
  const mineCount = loaded.filter(isMine).length;

  const chip = (key, label, count, on, onClick, title) => h('button', {
    key, type: 'button', title,
    class: 'ds-fchip' + (on ? ' is-on' : '') + (count === 0 ? ' is-empty' : ''),
    'aria-pressed': on ? 'true' : 'false',
    onclick: onClick,
  }, h('span', { class: 'ds-fchip-n' }, String(count)), h('span', { class: 'ds-fchip-l' }, label));

  return h('div', { class: 'ds-fchips' },
    chip('attn', 'need a person', needCount, attentionOnly,
      () => { attentionOnly = !attentionOnly; schedule(); },
      'Show only the reports the guardrails are chasing'),
    chip('mine', 'yours', mineCount, state.mineOnly,
      () => setMineOnly(!state.mineOnly),
      'Show only the reports you have claimed'),
    (attentionOnly || state.mineOnly)
      ? h('button', {
        key: 'clr', type: 'button', class: 'ds-fchip-clear',
        onclick: () => { attentionOnly = false; setMineOnly(false); },
      }, 'Clear')
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
      anyFilterActive()
        ? h('span', { class: 'ds-cl-match' }, shown.length + ' match the filters you have on')
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
