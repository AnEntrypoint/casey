import * as webjsx from 'webjsx';
import { SearchInput, Select, FilterPills } from 'ds/components/content.js';
import { Dropdown } from 'ds/components/overlay-primitives.js';
import { state, setFilt, schedule } from '../../state.js';
import { stageLabel, stageTone, channelLabel } from '../../format.js';
import { entityLabelPlural } from '../../vocabulary.js';
import { word } from '../../words.js';
import { pushRecentSearch, loadRecentSearches, listNamedViews } from '../../saved-views.js';
import { knownValues, knownValuesFresh, loadKnownValues } from '../../known-values.js';
import { PillButton } from '../../components/filter-chip.js';
const h = webjsx.createElement;

function truncateLabel(label, max = 28) {
  const s = String(label || '');
  return s.length > max ? s.slice(0, max - 1) + word('ui.filters_bar_ellipsis') : s;
}

function channelOptions() {
  const channels = [...new Set(state.allCases.map((c) => c.channel).filter(Boolean))].sort();
  return channels.map((c) => ({ value: c, label: truncateLabel(channelLabel(c)) }));
}
function sourceOptions() {
  return [
    { value: 'manual', label: word('ui.filters_bar_source_manual') },
    { value: 'channel', label: word('ui.filters_bar_source_channel') },
    { value: 'public_form', label: word('ui.filters_bar_source_public_form') },
  ];
}

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
    h('span', { key: 'lab', class: 'ds-recent-label' }, word('ui.filters_bar_recent')),
    ...arr.slice(0, 5).map((q) => PillButton({
      key: 'r-' + q, class: 'ds-recent-chip', title: q, children: q,
      onClick: () => { setFilt({ q }); remember(q); },
    })));
}

export function SearchBar({ resultCount = 0 } = {}) {
  const countLabel = word(resultCount === 1 ? 'ui.filters_bar_result_one' : 'ui.filters_bar_result_many', { n: resultCount });
  return h('div', { class: 'ds-btn-row', role: 'search' },
    h('div', { key: 'search', class: 'ds-case-filters-search' },
      SearchInput({
        value: state.filt.q,
        placeholder: word('ui.filters_bar_search_placeholder'),
        label: word('ui.filters_bar_search_label', { entity_plural: entityLabelPlural() }),
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
    const anyLabel = word('ui.filters_bar_any', { label: String(f.label || f.key).toLowerCase() });
    return Select({
      key: 'fv-' + f.key,
      value: (state.filt.fv && state.filt.fv[f.key]) || '',
      title: word('ui.filters_bar_filter_by', { label: f.label }), ariaLabel: word('ui.filters_bar_filter_by', { label: f.label }),
      options: [{ value: '', label: anyLabel }, ...values.map((v) => ({ value: v, label: truncateLabel(v) }))],
      onChange: (v) => setFilt({ fv: { ...(state.filt.fv || {}), [f.key]: v } }),
    });
  }).filter(Boolean);
}

export function MoreFilters({ onOpenSavedViews, onSaveView }) {
  return h('div', { class: 'ds-btn-row' },
    ...knownValueFilters(),
    Select({
      key: 'channel', value: state.filt.channel, placeholder: word('ui.filters_bar_all_channels'),
      title: word('ui.filters_bar_by_channel'), ariaLabel: word('ui.filters_bar_by_channel'),
      options: channelOptions(), onChange: (v) => setFilt({ channel: v }),
    }),
    Select({
      key: 'source', value: state.filt.source, placeholder: word('ui.filters_bar_all_sources'),
      title: word('ui.filters_bar_by_source'), ariaLabel: word('ui.filters_bar_by_source'),
      options: sourceOptions(), onChange: (v) => setFilt({ source: v }),
    }),
    Dropdown({
      key: 'views',
      ariaLabel: word('ui.filters_bar_saved_views'),
      trigger: () => [h('span', {}, word('ui.filters_bar_saved_views'))],
      items: [
        ...namedViews().map((n) => ({ id: 'apply:' + n, label: n })),
        { separator: true },
        { id: 'save', label: word('ui.filters_bar_save_view') },
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
  const options = [{ id: '', label: word('ui.filters_bar_all'), tone: '' }, ...stages.map((s) => ({ id: s, label: stageLabel(s), tone: stageTone(s) }))];
  return FilterPills({ options, selected: state.filt.status || '', onSelect: (id) => setFilt({ status: id }), label: word('ui.filters_bar_quick_stage') });
}
