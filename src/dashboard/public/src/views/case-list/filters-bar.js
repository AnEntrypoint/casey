import * as webjsx from 'webjsx';
import { SearchInput, Select, FilterPills } from 'ds/components/content.js';
import { Dropdown } from 'ds/components/overlay-primitives.js';
import { state, setFilt, schedule } from '../../state.js';
import { stageLabel, stageTone, channelLabel } from '../../format.js';
import { entityLabelPlural } from '../../vocabulary.js';
import { pushRecentSearch, loadRecentSearches, listNamedViews } from '../../saved-views.js';
import { knownValues, knownValuesFresh, loadKnownValues } from '../../known-values.js';
import { PillButton } from '../../components/filter-chip.js';
const h = webjsx.createElement;

function truncateLabel(label, max = 28) {
  const s = String(label || '');
  return s.length > max ? s.slice(0, max - 1) + '...' : s;
}

function channelOptions() {
  const channels = [...new Set(state.allCases.map((c) => c.channel).filter(Boolean))].sort();
  return channels.map((c) => ({ value: c, label: truncateLabel(channelLabel(c)) }));
}
const SOURCE_OPTIONS = [
  { value: 'manual', label: 'Manual (operator)' },
  { value: 'channel', label: 'Channel (AI)' },
  { value: 'public_form', label: 'Public form' },
];

let recentCache = null;
function recent() {
  if (recentCache === null) recentCache = loadRecentSearches();
  return recentCache;
}
function remember(q) { pushRecentSearch(q); recentCache = null; }

let viewsCache = null;
function namedViews() {
  if (viewsCache === null) viewsCache = listNamedViews();
  return viewsCache;
}
export function refreshSavedViews() { viewsCache = null; }

function recentSearches() {
  const arr = recent();
  if (!arr.length || state.filt.q) return null;
  return h('div', { class: 'ds-btn-row' },
    h('span', { key: 'lab', class: 'ds-recent-label' }, 'Recent:'),
    ...arr.slice(0, 5).map((q) => PillButton({
      key: 'r-' + q, class: 'ds-recent-chip', title: q, children: q,
      onClick: () => { setFilt({ q }); remember(q); },
    })));
}

export function SearchBar({ resultCount = 0 } = {}) {
  const countLabel = resultCount + ' result' + (resultCount === 1 ? '' : 's');
  return h('div', { class: 'ds-btn-row', role: 'search' },
    h('div', { key: 'search', class: 'ds-case-filters-search' },
      SearchInput({
        value: state.filt.q,
        placeholder: 'Search a reference or what it is about ( / )',
        label: 'Search ' + entityLabelPlural(),
        resultCount: countLabel,
        onInput: (v) => setFilt({ q: v }),
        onSubmit: (v) => { if (v) remember(v); },
      })
    ),
    recentSearches()
  );
}

function knownValueFilters() {
  const fields = ((state.runConfig || state.config || {}).known_value_fields) || [];
  return fields.map((f) => {
    const values = knownValues(f.key);
    if (!values.length) { if (!knownValuesFresh(f.key)) loadKnownValues(f.key).then(schedule); return null; }
    const anyLabel = 'any ' + String(f.label || f.key).toLowerCase();
    return Select({
      key: 'fv-' + f.key,
      value: (state.filt.fv && state.filt.fv[f.key]) || '',
      title: 'Filter by ' + f.label, ariaLabel: 'Filter by ' + f.label,
      options: [{ value: '', label: anyLabel }, ...values.map((v) => ({ value: v, label: truncateLabel(v) }))],
      onChange: (v) => setFilt({ fv: { ...(state.filt.fv || {}), [f.key]: v } }),
    });
  }).filter(Boolean);
}

export function MoreFilters({ onOpenSavedViews, onSaveView }) {
  return h('div', { class: 'ds-btn-row' },
    ...knownValueFilters(),
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
      trigger: () => [h('span', {}, 'Saved views')],
      items: [
        ...namedViews().map((n) => ({ id: 'apply:' + n, label: n })),
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

export function StagePills() {
  const stages = [...new Set(state.allCases.map((c) => c.status))].sort();
  if (!stages.length) return null;
  const options = [{ id: '', label: 'All', tone: '' }, ...stages.map((s) => ({ id: s, label: stageLabel(s), tone: stageTone(s) }))];
  return FilterPills({ options, selected: state.filt.status || '', onSelect: (id) => setFilt({ status: id }), label: 'Quick stage filter' });
}
