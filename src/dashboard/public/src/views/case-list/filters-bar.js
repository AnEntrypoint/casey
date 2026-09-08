// The controls that change the question, in two tiers.
//
// Tier 1 (SearchBar + StagePills) is always visible: typing a ref or a place,
// and one-tap stage narrowing. Tier 2 (MoreFilters) sits behind a worded
// disclosure in case-list-view.js -- channel, intake source, saved views.
//
// Two controls were removed rather than restyled:
//   - the "all stages" Select. It drove setFilt({status}) exactly as StagePills
//     does, rendered immediately above it, so the same question had two answers
//     stacked on top of each other. The pills win: one tap, always visible, no
//     dropdown to open on a phone.
//   - the Mine toggle. It became a counted chip in case-list-view.js's head,
//     because a control that also states how many it will show you is strictly
//     better than one that makes you apply it to find out.
//
// The recent-search affordance was a Dropdown whose entire trigger was
// `class: 'ds-search-history-hint sr-only'` -- visually hidden, so on a touch
// screen it did not exist at all. It is real, tappable chips now.

import * as webjsx from 'webjsx';
import { Btn } from 'ds/components/shell.js';
import { SearchInput, Select, FilterPills } from 'ds/components/content.js';
import { Dropdown } from 'ds/components/overlay-primitives.js';
import { state, setFilt } from '../../state.js';
import { stageLabel, stageTone } from '../../format.js';
import { pushRecentSearch, loadRecentSearches } from '../../saved-views.js';
const h = webjsx.createElement;

// Truncate a long option label to a fixed budget so a Select never blows out
// the filter bar width; the full value stays the real title attribute for a
// hover/screen-reader read.
function truncateLabel(label, max = 28) {
  const s = String(label || '');
  return s.length > max ? s.slice(0, max - 1) + '...' : s;
}

function channelOptions() {
  const channels = [...new Set(state.allCases.map((c) => c.channel).filter(Boolean))].sort();
  return channels.map((c) => ({ value: c, label: truncateLabel(c) }));
}
const SOURCE_OPTIONS = [
  { value: 'manual', label: 'Manual (operator)' },
  { value: 'channel', label: 'Channel (AI)' },
  { value: 'public_form', label: 'Public form' },
];

// The ring buffer saved-views.js keeps in localStorage, read from there rather
// than from state.recentSearches. pushRecentSearch() has always WRITTEN that
// buffer on every search submit, but nothing in the SPA ever called
// loadRecentSearches() or setRecentSearches(), so state.recentSearches was []
// for the life of every page -- the whole feature was written-only, and the
// control that consumed it could never have rendered even if it had been
// visible. Cached per page so a 5s poll's re-render is not a storage read.
let recentCache = null;
function recent() {
  if (recentCache === null) recentCache = loadRecentSearches();
  return recentCache;
}
function remember(q) { pushRecentSearch(q); recentCache = null; }

// Real chips, not a screen-reader-only dropdown. Only while the box is empty:
// once the operator is typing, their own text is the subject of the control
// and a row of old searches under it is just noise to tap past.
function recentSearches() {
  const arr = recent();
  if (!arr.length || state.filt.q) return null;
  return h('div', { class: 'ds-recent-searches' },
    h('span', { key: 'lab', class: 'ds-recent-label' }, 'Recent:'),
    ...arr.slice(0, 5).map((q) => h('button', {
      key: 'r-' + q, type: 'button', class: 'ds-recent-chip', title: q,
      onclick: () => { setFilt({ q }); remember(q); },
    }, q)));
}

// resultCount comes from the caller, which is the only place that knows how
// many rows actually survive every filter. It used to be state.allCases.length
// -- the count BEFORE filtering -- so the number beside the search box was the
// one number on screen guaranteed not to describe the list under it.
//
// The placeholder no longer offers "contact": /api/cases is a PII-free
// projection with no external_id or contact_id in it, so a phone number was
// never searchable here and offering it taught the operator to expect a result
// that could not arrive.
export function SearchBar({ resultCount = 0 } = {}) {
  const countLabel = resultCount + ' result' + (resultCount === 1 ? '' : 's');
  return h('div', { class: 'ds-case-filters-bar', role: 'search' },
    h('div', { key: 'search', class: 'ds-case-filters-search' },
      SearchInput({
        value: state.filt.q,
        placeholder: 'Search a reference or what it is about ( / )',
        label: 'Search cases',
        resultCount: countLabel,
        onInput: (v) => setFilt({ q: v }),
        onSubmit: (v) => { if (v) remember(v); },
      })
    ),
    recentSearches()
  );
}

export function MoreFilters({ onOpenSavedViews, onSaveView }) {
  return h('div', { class: 'ds-case-more-filters' },
    Select({
      key: 'channel', value: state.filt.channel, placeholder: 'all channels',
      title: 'Filter by channel', ariaLabel: 'Filter by channel',
      options: channelOptions(), onChange: (v) => setFilt({ channel: v }),
    }),
    Select({
      key: 'source', value: state.filt.source, placeholder: 'all sources',
      title: 'Filter by intake source', ariaLabel: 'Filter by intake source',
      options: SOURCE_OPTIONS, onChange: (v) => setFilt({ source: v }),
    }),
    Dropdown({
      key: 'views',
      ariaLabel: 'Saved views',
      trigger: () => Btn({ variant: 'ghost', size: 'sm', children: 'Saved views' }),
      items: [
        ...Object.keys(state.savedViews).sort().map((n) => ({ id: 'apply:' + n, label: n })),
        { separator: true },
        { id: 'save', label: 'Save current view' },
      ],
      onSelect: (id) => {
        if (id === 'save') { onSaveView && onSaveView(); return; }
        if (id.startsWith('apply:')) { onOpenSavedViews && onOpenSavedViews(id.slice(6)); }
      },
    })
  );
}

// Quick-stage strip: the single, always-visible answer to "which stage".
// deps/design's FilterPills takes a per-option `tone`, so this calls it
// directly instead of hand-rolling the pill markup.
export function StagePills() {
  const stages = [...new Set(state.allCases.map((c) => c.status))].sort();
  if (!stages.length) return null;
  const options = [{ id: '', label: 'All', tone: '' }, ...stages.map((s) => ({ id: s, label: stageLabel(s), tone: stageTone(s) }))];
  return FilterPills({ options, selected: state.filt.status || '', onSelect: (id) => setFilt({ status: id }), label: 'Quick stage filter' });
}
