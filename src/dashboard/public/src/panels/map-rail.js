import * as webjsx from '/design/vendor/webjsx/index.js';
import { Select } from '/design/src/components/content/fields.js';
import { FilterPills } from '/design/src/components/content/feedback.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import {
    state, schedule, setActiveId, setMapFilter, clearMapFilter, setRailMode,
} from '../state.js';
import { urgencyByCaseId, filterIsActive, URGENCY_BAND_LABEL, queueName } from '../map-model.js';
import {
    mapStateRef, refresh, counts, queueRows, filterOptions, loadSummary, loadError, hasLoadedOnce,
    unresolvedSummaryText, unresolvedNoteText, isStale, updatedAt,
    QUEUE_PAGE, queueShownCount, setQueueShown,
} from './map-view-state.js';
import { toggleClusters, refilterMarkers, toggleCoverage, toggleWorkers, toggleLastReports, resetMapView } from './map-leaflet.js';
import { GeoPanel } from './geo-panel.js';
import { ClustersPanel } from './clusters-panel.js';
import { FilterChip, ClearChip, QueueMore, PillButton } from '../components/filter-chip.js';
import { headline, rel, FILTERED_EMPTY_TEXT } from '../format.js';
import { word } from '../words.js';

const h = webjsx.createElement;

function applyFilterToMap() {
    if (mapStateRef.current) refilterMarkers(mapStateRef.current, state.mapFilter);
    schedule();
}

function timeControl() {
    const opts = [{ v: '0', key: 'ui.map_rail_all_time' }, { v: '7', key: 'ui.map_rail_this_week' }, { v: '30', key: 'ui.map_rail_this_month' }];
    return h('div', { class: 'ds-rail-controls' },
        FilterPills({
            label: word('ui.map_rail_time_window'), selected: state.mapFilter.days,
            options: opts.map((o) => ({ id: o.v, label: word(o.key) })),
            onSelect: (v) => { if (state.mapFilter.days === v) return; setMapFilter({ days: v }); refresh(); },
        }),
        Btn({
            key: 'reset', variant: 'ghost', size: 'sm',
            title: word('ui.map_rail_show_all_title'),
            onClick: () => { resetMapView(mapStateRef.current); },
            children: word('ui.map_rail_show_all'),
        }));
}

function filterChips() {
    const { attention: attentionCount, today: newToday, inView: inViewCount } = counts();

    const chip = (key, label, count, on, onClick, title) => FilterChip({ key, label, count, on, onClick, title });

    const f = state.mapFilter;
    return h('div', { class: 'ds-filter-pills' },
        chip('attn', word('ui.map_rail_chip_attention'), attentionCount, f.band === 'attention',
            () => { setMapFilter({ band: f.band === 'attention' ? null : 'attention' }); applyFilterToMap(); },
            word('ui.map_rail_chip_attention_title')),
        chip('today', word('ui.map_rail_chip_today'), newToday, f.band === 'today',
            () => { setMapFilter({ band: f.band === 'today' ? null : 'today' }); applyFilterToMap(); },
            word('ui.map_rail_chip_today_title')),
        inViewCount == null ? null : chip('view', word('ui.map_rail_chip_view'), inViewCount, f.inView,
            () => { setMapFilter({ inView: !f.inView }); applyFilterToMap(); },
            word('ui.map_rail_chip_view_title')),
        filterIsActive(f)
            ? ClearChip({ onClick: () => { clearMapFilter(); applyFilterToMap(); } })
            : null);
}

export function visibleQueueRows() { return queueRows(); }

function attentionFeed() {
    const all = queueRows();
    const error = loadError();
    if (!all.length && error) return h('div', { class: 'triage' }, h('div', { class: 'calm', role: 'alert' }, word('ui.map_rail_queue_error', { error })));
    if (!all.length && !hasLoadedOnce()) return h('div', { class: 'triage' }, h('div', { class: 'calm', role: 'status' }, word('ui.map_rail_loading_queue')));
    if (!all.length) {
        const why = filterIsActive(state.mapFilter)
            ? FILTERED_EMPTY_TEXT
            : word('ui.map_rail_nothing_needs');
        return h('div', { class: 'triage' }, h('div', { class: 'calm' }, why));
    }
    const shown = queueShownCount();
    const rows = all.slice(0, shown);
    const urgency = urgencyByCaseId();
    const pick = (id) => setActiveId(id);
    return h('div', { class: 'ds-map-attention-feed' },
        ...rows.map((c) => {
            const band = urgency.get(c.id) || 1;
            return h('div', {
                key: c.id, class: 'tcase heat-' + band + (state.activeId === c.id ? ' active' : ''),
                onclick: () => pick(c.id),
                role: 'button', tabindex: '0',
                'aria-label': word('ui.map_rail_row_aria', { ref: c.ref, band: URGENCY_BAND_LABEL[band] || '' }),
                onkeydown: (e) => {
                    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); pick(c.id); }
                },
            },
                h('div', { class: 'tcase-why' }, headline(c.subject || c.ref)),
                h('div', { class: 'tcase-meta' }, c.ref, band > 1 ? ' ' : '', band > 1 ? h('span', { class: 'tcase-flag flag-' + band }, URGENCY_BAND_LABEL[band] || '') : null),
                c.reason ? h('div', { class: 'tcase-reason' }, c.reason) : null);
        }),
        all.length > rows.length
            ? QueueMore({ key: 'more', onClick: () => { setQueueShown(all.length); }, children: word('ui.map_rail_show_all_count', { count: all.length }) })
            : (shown > QUEUE_PAGE && all.length > QUEUE_PAGE
                ? QueueMore({ key: 'less', onClick: () => { setQueueShown(QUEUE_PAGE); }, children: word('ui.map_rail_show_fewer') })
                : null));
}

function mapFilterRow() {
    const f = state.mapFilter;
    const options = filterOptions();
    return h('div', { class: 'ds-btn-row ds-map-filters' },
        Select({
            key: 'sp', placeholder: word('ui.map_rail_all_species'), value: f.species,
            options: options.species, onChange: (v) => { setMapFilter({ species: v }); applyFilterToMap(); },
        }),
        Select({
            key: 'ty', placeholder: word('ui.map_rail_all_types'), value: f.type,
            options: options.types, onChange: (v) => { setMapFilter({ type: v }); applyFilterToMap(); },
        }),
        Select({
            key: 'st', placeholder: word('ui.map_rail_all_statuses'), value: f.status,
            options: options.statuses, onChange: (v) => { setMapFilter({ status: v }); applyFilterToMap(); },
        }));
}

function mapOverlayRow() {
    const ms = mapStateRef.current;
    const tog = (key, label, title, on, onClick) => PillButton({ key, title, active: on, onClick, children: label });
    return h('div', { class: 'ds-btn-row ds-map-overlays' },
        tog('cl', word('ui.map_rail_ov_clusters'), word('ui.map_rail_ov_clusters_title'),
            !!(ms && ms.showClusters), () => { toggleClusters(ms, state.mapFilter); schedule(); }),
        tog('cov', word('ui.map_rail_ov_coverage'), word('ui.map_rail_ov_coverage_title'),
            !!(ms && ms.showCoverage), async () => { await toggleCoverage(ms); schedule(); }),
        tog('wk', word('ui.map_rail_ov_workers'), word('ui.map_rail_ov_workers_title'),
            !!(ms && ms.showWorkers), async () => { await toggleWorkers(ms); schedule(); }),
        tog('lr', word('ui.map_rail_ov_last_reported'), word('ui.map_rail_ov_last_reported_title'),
            !!(ms && ms.showLastReports), async () => { await toggleLastReports(ms); schedule(); }));
}

function mapUnresolvedList() {
    return h('div', { class: 'ds-map-unresolved-list' }, ...(loadSummary().unresolved || []).map((p, i) =>
        h('div', {
            key: i, class: 'ds-map-unresolved-row', role: 'button', tabindex: '0',
            onclick: () => setActiveId(p.id),
            onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveId(p.id); } },
        },
            h('b', {}, p.ref),
            ' ', h('span', { class: 'ds-muted' }, String(p.status || '').replace(/_/g, ' ')),
            p.species ? ' -- ' + p.species : '',
            p.location ? ` (${p.location})` : '',
            p.symptoms ? ' -- ' + p.symptoms : '')));
}

function mapUnresolvedDisclosure() {
    const summary = loadSummary();
    if (!summary.unresolvedCount && !summary.truncated) return [];
    return [h('details', { class: 'ds-rail-disclosure' },
        h('summary', {}, unresolvedSummaryText()),
        h('div', { class: 'ds-rail-disclosure-body' },
            h('div', { class: 'ds-map-unresolved-note' }, unresolvedNoteText()),
            mapUnresolvedList()))];
}

const RAIL_MODES = {
    queue: { label: () => queueName(), body: attentionFeed },
    clusters: { label: () => word('ui.map_rail_mode_clusters'), body: () => ClustersPanel({ railed: true }) },
    geo: { label: () => word('ui.map_rail_mode_geo'), body: () => GeoPanel({ railed: true }) },
};

function railModeTabs() {
    if (state.railMode === 'queue') return null;
    return h('div', { class: 'ds-rail-back' },
        Btn({
            variant: 'ghost',
            children: word('ui.map_rail_back'),
            onClick: () => { setRailMode('queue'); },
        }));
}

export function MapRail() {
    const mode = RAIL_MODES[state.railMode] || RAIL_MODES.queue;
    const stale = isStale();
    const at = updatedAt();
    const lastUpdatedNote = at
        ? h('div', {
            class: 'ds-map-updated' + (stale ? ' is-stale' : ''),
            role: stale ? 'status' : null,
        }, (stale
            ? word('ui.map_rail_stale', { time: rel(at) })
            : word('ui.map_rail_updated', { time: rel(at) })))
        : null;
    return h('div', { class: 'ds-map-rail' },
        h('div', { class: 'ds-rail-head' },
            h('div', { class: 'ds-rail-head-top' },
                h('h2', { class: 'ds-rail-title' }, mode.label()),
                lastUpdatedNote),
            timeControl(),
            filterChips()),
        railModeTabs(),
        h('div', { class: 'ds-rail-body' },
            mode.body(),
            h('details', { class: 'ds-rail-disclosure' },
                h('summary', {}, word('ui.map_rail_options')),
                h('div', { class: 'ds-rail-disclosure-body' }, mapFilterRow(), mapOverlayRow(), h('p', { class: 'casey-hint' }, word('ui.map_rail_overlay_help')))),
            ...mapUnresolvedDisclosure()));
}
