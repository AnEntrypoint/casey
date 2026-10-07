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

const h = webjsx.createElement;

function applyFilterToMap() {
    if (mapStateRef.current) refilterMarkers(mapStateRef.current, state.mapFilter);
    schedule();
}

const OVERLAY_HELP = 'Clusters: dashed red lines join reports that look like one event. Coverage: large faint rings show areas an operator has worked. Workers: amber dots are field workers, red and larger when a check-in is overdue. Last reported: green dots show where each contact last reported from.';

function timeControl() {
    const opts = [{ v: '0', label: 'All time' }, { v: '7', label: 'This week' }, { v: '30', label: 'This month' }];
    return h('div', { class: 'ds-rail-controls' },
        FilterPills({
            label: 'Time window', selected: state.mapFilter.days,
            options: opts.map((o) => ({ id: o.v, label: o.label })),
            onSelect: (v) => { if (state.mapFilter.days === v) return; setMapFilter({ days: v }); refresh(); },
        }),
        Btn({
            key: 'reset', variant: 'ghost', size: 'sm',
            title: 'Move the map back to show every report',
            onClick: () => { resetMapView(mapStateRef.current); },
            children: 'Show all',
        }));
}

function filterChips() {
    const { attention: attentionCount, today: newToday, inView: inViewCount } = counts();

    const chip = (key, label, count, on, onClick, title) => FilterChip({ key, label, count, on, onClick, title });

    const f = state.mapFilter;
    return h('div', { class: 'ds-filter-pills' },
        chip('attn', 'need a person', attentionCount, f.band === 'attention',
            () => { setMapFilter({ band: f.band === 'attention' ? null : 'attention' }); applyFilterToMap(); },
            'Show only the reports the guardrails are chasing'),
        chip('today', 'new today', newToday, f.band === 'today',
            () => { setMapFilter({ band: f.band === 'today' ? null : 'today' }); applyFilterToMap(); },
            'Show only reports that came in today'),
        inViewCount == null ? null : chip('view', 'in this view', inViewCount, f.inView,
            () => { setMapFilter({ inView: !f.inView }); applyFilterToMap(); },
            'Narrow the list to the part of the map you are looking at'),
        filterIsActive(f)
            ? ClearChip({ onClick: () => { clearMapFilter(); applyFilterToMap(); } })
            : null);
}

export function visibleQueueRows() { return queueRows(); }

function attentionFeed() {
    const all = queueRows();
    const error = loadError();
    if (!all.length && error) return h('div', { class: 'triage' }, h('div', { class: 'calm', role: 'alert' }, 'The queue could not load: ' + error));
    if (!all.length && !hasLoadedOnce()) return h('div', { class: 'triage' }, h('div', { class: 'calm', role: 'status' }, 'Loading the queue...'));
    if (!all.length) {
        const why = filterIsActive(state.mapFilter)
            ? FILTERED_EMPTY_TEXT
            : 'Nothing needs attention right now.';
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
                'aria-label': `${c.ref}: ${URGENCY_BAND_LABEL[band] || ''}`,
                onkeydown: (e) => {
                    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); pick(c.id); }
                },
            },
                h('div', { class: 'tcase-why' }, headline(c.subject || c.ref)),
                h('div', { class: 'tcase-meta' }, c.ref, band > 1 ? ' ' : '', band > 1 ? h('span', { class: 'tcase-flag flag-' + band }, URGENCY_BAND_LABEL[band] || '') : null),
                c.reason ? h('div', { class: 'tcase-reason' }, c.reason) : null);
        }),
        all.length > rows.length
            ? QueueMore({ key: 'more', onClick: () => { setQueueShown(all.length); }, children: `Show all ${all.length}` })
            : (shown > QUEUE_PAGE && all.length > QUEUE_PAGE
                ? QueueMore({ key: 'less', onClick: () => { setQueueShown(QUEUE_PAGE); }, children: 'Show fewer' })
                : null));
}

function mapFilterRow() {
    const f = state.mapFilter;
    const options = filterOptions();
    return h('div', { class: 'ds-btn-row ds-map-filters' },
        Select({
            key: 'sp', placeholder: 'all species', value: f.species,
            options: options.species, onChange: (v) => { setMapFilter({ species: v }); applyFilterToMap(); },
        }),
        Select({
            key: 'ty', placeholder: 'all types', value: f.type,
            options: options.types, onChange: (v) => { setMapFilter({ type: v }); applyFilterToMap(); },
        }),
        Select({
            key: 'st', placeholder: 'all statuses', value: f.status,
            options: options.statuses, onChange: (v) => { setMapFilter({ status: v }); applyFilterToMap(); },
        }));
}

function mapOverlayRow() {
    const ms = mapStateRef.current;
    const tog = (key, label, title, on, onClick) => PillButton({ key, title, active: on, onClick, children: label });
    return h('div', { class: 'ds-btn-row ds-map-overlays' },
        tog('cl', 'Clusters', 'Draw a line between reports that look like the same event',
            !!(ms && ms.showClusters), () => { toggleClusters(ms, state.mapFilter); schedule(); }),
        tog('cov', 'Coverage', 'Ring the areas each operator has been working in',
            !!(ms && ms.showCoverage), async () => { await toggleCoverage(ms); schedule(); }),
        tog('wk', 'Workers', 'Show where field workers last checked in from',
            !!(ms && ms.showWorkers), async () => { await toggleWorkers(ms); schedule(); }),
        tog('lr', 'Last reported', 'Show the last place each contact reported from',
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
    queue: { label: queueName(), body: attentionFeed },
    clusters: { label: 'Related reports', body: () => ClustersPanel({ railed: true }) },
    geo: { label: 'Hotspots', body: () => GeoPanel({ railed: true }) },
};

function railModeTabs() {
    if (state.railMode === 'queue') return null;
    return h('div', { class: 'ds-rail-back' },
        Btn({
            variant: 'ghost',
            children: 'Back to the queue',
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
            ? 'Not refreshing -- last updated ' + rel(at) + '. Reload the page to get the current picture.'
            : 'Updated ' + rel(at)))
        : null;
    return h('div', { class: 'ds-map-rail' },
        h('div', { class: 'ds-rail-head' },
            h('div', { class: 'ds-rail-head-top' },
                h('h2', { class: 'ds-rail-title' }, mode.label),
                lastUpdatedNote),
            timeControl(),
            filterChips()),
        railModeTabs(),
        h('div', { class: 'ds-rail-body' },
            mode.body(),
            h('details', { class: 'ds-rail-disclosure' },
                h('summary', {}, 'Map options'),
                h('div', { class: 'ds-rail-disclosure-body' }, mapFilterRow(), mapOverlayRow(), h('p', { class: 'casey-hint' }, OVERLAY_HELP))),
            ...mapUnresolvedDisclosure()));
}
