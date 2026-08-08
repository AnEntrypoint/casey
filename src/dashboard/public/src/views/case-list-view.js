// Left-pane composer: filter bar + stage pills + bulk-bar + Needs-you-now
// inbox + case list rows (virtualized above threshold) + pagination.
// Every behavior in the CONTEXT inventory's case-list/inbox section is
// preserved: search/status/channel/source filters, saved views, Mine toggle,
// bulk selection + actions, keyboard nav (wired in main.js via keyboard.js),
// checkbox multi-select, server-ranked inbox, heat coloring, owner chips.

import * as ds from '/design/dist/247420.js';
import { state, schedule } from '../state.js';
import { attn, tagList, isMine } from '../format.js';
import { toast } from '../toasts.js';
import { saveCurrentView, applyNamedView } from '../saved-views.js';
import { FiltersBar, StagePills } from './case-list/filters-bar.js';
import { InboxPanel } from './case-list/inbox-panel.js';
import { BulkBar } from './case-list/bulk-bar.js';
import { Pagination } from './case-list/pagination.js';
import { VirtualizedCaseList, PlainCaseList, VIRTUALIZE_THRESHOLD } from './case-list/virtualized-list.js';
const { Heading } = ds.components;
const h = ds.h;

let expandedGuardrailId = null;
function toggleGuardrails(id) { expandedGuardrailId = expandedGuardrailId === id ? null : id; schedule(); }

// The client-side residual filter over the current server-fetched page: the
// server already applies status/channel/q (see api.js fetchCases params);
// Mine and source stay client-side exactly as the legacy app did, since
// source is derived from tags (not a stored column) and Mine depends on the
// logged-in session, neither of which the /api/cases endpoint filters on.
export function matchesClientFilt(c) {
  if (state.mineOnly && !isMine(c)) return false;
  if (state.filt.source) {
    const tags = tagList(c);
    if (state.filt.source === 'manual' && !tags.includes('intake_mode:manual')) return false;
    if (state.filt.source === 'channel' && !tags.includes('intake_mode:channel')) return false;
    if (state.filt.source === 'public_form' && !tags.includes('intake_mode:public_form')) return false;
  }
  return true;
}

export function visibleCases() {
  return state.allCases.filter(matchesClientFilt);
}

function promptSaveView() {
  const name = (prompt('Name this view (e.g. "my urgent", "Musina handoffs"):') || '').trim();
  if (!name) return;
  const r = saveCurrentView(name);
  if (!r.ok) { toast(r.error, 'err'); return; }
  toast('Saved view "' + name + '"', 'ok');
}

function CountsLine() {
  const total = state.allCases.length;
  const needing = state.allCases.filter(attn).length;
  return h('span', { class: 'ds-case-counts' }, total + ' total' + (needing ? ' - ' + needing + ' need attention' : ''));
}

export function CaseListView({ onOpenIntake, onPromptTag, onPromptNote, onReloadCases }) {
  const shown = visibleCases();

  return h('div', { class: 'case-list-view' },
    h('div', { key: 'head', class: 'case-list-head' },
      Heading({ level: 1, children: 'casey' }),
      CountsLine()
    ),
    FiltersBar({
      onOpenSavedViews: (name) => { applyNamedView(name); onReloadCases && onReloadCases(); },
      onSaveView: promptSaveView,
    }),
    StagePills(),
    InboxPanel(),
    BulkBar({ stages: (state.config && state.config.stages) || [], onDone: onReloadCases, onPromptTag, onPromptNote }),
    shown.length > VIRTUALIZE_THRESHOLD
      ? VirtualizedCaseList({ cases: shown, expandedGuardrails: expandedGuardrailId, onToggleGuardrails: toggleGuardrails })
      : PlainCaseList({ cases: shown, expandedGuardrails: expandedGuardrailId, onToggleGuardrails: toggleGuardrails }),
    Pagination()
  );
}
