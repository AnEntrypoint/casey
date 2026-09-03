// Search + status/channel/source filters + Mine toggle + saved-views Dropdown
// + FilterPills quick-stage strip (ux-case-list-sort-group-controls,
// ux-filter-dropdown-truncation, ux-search-hint-and-history).

import * as ds from '/design/dist/247420.js';
import { state, setFilt, setMineOnly } from '../../state.js';
import { stageLabel, stageTone } from '../../format.js';
import { pushRecentSearch } from '../../saved-views.js';
const { SearchInput, Select, Chip, Dropdown, Btn, FilterPills } = ds.components;
const h = ds.h;

// Truncate a long option label to a fixed budget so a Select never blows out
// the filter bar width (ux-filter-dropdown-truncation); the full value stays
// the real title attribute for a hover/screen-reader read.
function truncateLabel(label, max = 28) {
  const s = String(label || '');
  return s.length > max ? s.slice(0, max - 1) + '...' : s;
}

function statusOptions() {
  const stages = [...new Set(state.allCases.map((c) => c.status))].sort();
  return stages.map((s) => ({ value: s, label: truncateLabel(stageLabel(s)) }));
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

function searchHint() {
  if (!state.recentSearches.length || state.filt.q) return null;
  const items = state.recentSearches.map((q) => ({ id: q, label: q }));
  return Dropdown({
    ariaLabel: 'Recent searches',
    trigger: () => h('span', { class: 'ds-search-history-hint sr-only' }, 'recent searches'),
    items,
    onSelect: (id) => { setFilt({ q: id }); pushRecentSearch(id); },
  });
}

export function FiltersBar({ onOpenSavedViews, onSaveView, searchInputRef }) {
  const resultCount = state.allCases.length + ' result' + (state.allCases.length === 1 ? '' : 's');
  return h('div', { class: 'ds-case-filters-bar', role: 'search' },
    h('div', { key: 'search', class: 'ds-case-filters-search' },
      SearchInput({
        value: state.filt.q,
        placeholder: 'Search ref, subject, contact... ( / )',
        label: 'Search cases',
        resultCount,
        onInput: (v) => setFilt({ q: v }),
        onSubmit: (v) => { if (v) pushRecentSearch(v); },
      }),
      searchHint()
    ),
    Select({
      key: 'status', value: state.filt.status, placeholder: 'all stages',
      title: 'Filter by workflow stage', ariaLabel: 'Filter by stage',
      options: statusOptions(), onChange: (v) => setFilt({ status: v }),
    }),
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
    h('button', {
      key: 'mine-btn', type: 'button', class: 'ds-mine-toggle', 'aria-pressed': state.mineOnly ? 'true' : 'false',
      title: 'Show only the cases you have claimed',
      onclick: () => setMineOnly(!state.mineOnly),
    }, Chip({ tone: state.mineOnly ? 'accent' : '', children: 'Mine' })),
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

// Quick-stage FilterPills strip beneath the search/select row -- a faster
// single-click path to the same status filter the Select above also drives.
// deps/design's FilterPills now takes a per-option `tone`, so this calls it
// directly instead of hand-rolling the pill markup.
export function StagePills() {
  const stages = [...new Set(state.allCases.map((c) => c.status))].sort();
  if (!stages.length) return null;
  const options = [{ id: '', label: 'All', tone: '' }, ...stages.map((s) => ({ id: s, label: stageLabel(s), tone: stageTone(s) }))];
  return FilterPills({ options, selected: state.filt.status || '', onSelect: (id) => setFilt({ status: id }), label: 'Quick stage filter' });
}
