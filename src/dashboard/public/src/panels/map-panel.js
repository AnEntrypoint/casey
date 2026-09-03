// Map panel chrome -- filters (species/type/status/days) + 4 overlay toggle
// Chips (coverage/clusters/workers/last-reported) + the Leaflet canvas mount.
// Leaflet itself is driven imperatively by map-leaflet.js (not webjsx-
// rendered); this file owns only the webjsx chrome around it, per
// architecture spec section 1's pre-declared overflow split.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Select } from '/design/src/components/content/fields.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { Chip, Btn } from '/design/src/components/shell/atoms.js';
import { state, schedule, closePanel, setActiveId } from '../state.js';
import {
    loadMap, toggleClusters, refilterMarkers, toggleCoverage, toggleWorkers, toggleLastReports, STATUS_TOKEN,
} from './map-leaflet.js';

const h = webjsx.createElement;

const mapStateRef = { current: null };
let filters = { species: '', type: '', status: '', days: '0' };
let options = { species: [], types: [], statuses: [] };
let summary = { unresolvedCount: 0, unresolved: [], truncated: false, cap: 0, totalConsidered: 0 };
let error = null;

function refresh() {
    error = null;
    loadMap(mapStateRef, document.getElementById('ds-map-canvas'), filters, filters.days, {
        onOptions: (o) => { options = o; schedule(); },
        onSummary: (s) => { summary = s; schedule(); },
        onError: (msg) => { error = msg; schedule(); },
    });
}

// The canvas div carries no webjsx `key`, so every re-render (a background
// poll's schedule(), not just a genuine remount) replaces it with a FRESH DOM
// node -- witnessed live once this panel became the default landing view
// (dashboard_ui.default_view:'map'), where main.js's own 5s/15s/30s poll
// intervals re-render MainContent() on a live timer regardless of which
// panel is showing. A plain one-shot `mounted` boolean guard (the prior
// version) latched true on the FIRST render and then never called refresh()
// again, so the second poll-triggered render swapped in an empty replacement
// canvas with no Leaflet instance ever attached to it -- the map vanished
// within one poll interval. Guard on the LIVE element instead: Leaflet's own
// `map.getContainer()` names which DOM node it is actually bound to, so a
// canvas swap is detected and re-mounted, while the SAME persisted element
// across a genuine no-op re-render is correctly left alone.
function onMountCanvas(el) {
    if (!el) return;
    if (mapStateRef.current && mapStateRef.current.map.getContainer() === el) return;
    if (mapStateRef.current) { mapStateRef.current.map.remove(); mapStateRef.current = null; }
    refresh();
}

export function MapPanel() {
    const back = Btn({ variant: 'ghost', children: 'Back to cases', onClick: () => { closePanel(); } });
    const legend = h('div', { class: 'ds-map-legend' }, ...Object.entries(STATUS_TOKEN).map(([k, tok]) =>
        h('span', { key: k, class: 'ds-map-legend-item' }, h('span', { class: 'ds-map-legend-sw', 'data-status-token': tok }), k.replace(/_/g, ' '))));

    const filterRow = h('div', { class: 'ds-map-filters' },
        Select({
            key: 'sp', placeholder: 'all species', value: filters.species,
            options: options.species, onChange: (v) => { filters.species = v; refilterMarkers(mapStateRef.current, filters); schedule(); },
        }),
        Select({
            key: 'ty', placeholder: 'all types', value: filters.type,
            options: options.types, onChange: (v) => { filters.type = v; refilterMarkers(mapStateRef.current, filters); schedule(); },
        }),
        Select({
            key: 'st', placeholder: 'all statuses', value: filters.status,
            options: options.statuses, onChange: (v) => { filters.status = v; refilterMarkers(mapStateRef.current, filters); schedule(); },
        }),
        Select({
            key: 'dy', value: filters.days,
            options: [{ value: '0', label: 'all time' }, { value: '7', label: 'last 7 days' }, { value: '30', label: 'last 30 days' }, { value: '90', label: 'last 90 days' }],
            onChange: (v) => { filters.days = v; refresh(); },
        }));

    const overlayRow = h('div', { class: 'ds-map-overlays' },
        Chip({ key: 'cl', tone: mapStateRef.current && mapStateRef.current.showClusters ? 'accent' : '', children: h('button', { type: 'button', class: 'ds-chip-btn', onclick: () => { toggleClusters(mapStateRef.current, filters); schedule(); } }, 'Clusters') }),
        Chip({ key: 'cov', tone: mapStateRef.current && mapStateRef.current.showCoverage ? 'accent' : '', children: h('button', { type: 'button', class: 'ds-chip-btn', onclick: async () => { await toggleCoverage(mapStateRef.current); schedule(); } }, 'Coverage') }),
        Chip({ key: 'wk', tone: mapStateRef.current && mapStateRef.current.showWorkers ? 'accent' : '', children: h('button', { type: 'button', class: 'ds-chip-btn', onclick: async () => { await toggleWorkers(mapStateRef.current); schedule(); } }, 'Workers') }),
        Chip({ key: 'lr', tone: mapStateRef.current && mapStateRef.current.showLastReports ? 'accent' : '', children: h('button', { type: 'button', class: 'ds-chip-btn', onclick: async () => { await toggleLastReports(mapStateRef.current); schedule(); } }, 'Last reported') }));

    const canvas = h('div', {
        id: 'ds-map-canvas', class: 'ds-map-canvas',
        // webjsx has no ref callback; use a mount-once pattern via a
        // MutationObserver-free approach: schedule() re-invokes this view,
        // and onMountCanvas is idempotent (mounted guard), so calling it
        // every render is safe and only truly mounts Leaflet once.
    });
    queueMicrotask(() => onMountCanvas(document.getElementById('ds-map-canvas')));

    const unresolvedNote = summary.unresolvedCount
        ? `${summary.unresolvedCount} case(s) have no placeable location yet (no GPS, and location text did not match a known area) -- not shown on the map.`
          + (summary.truncated ? ` Showing the most recent ${summary.cap} of ${summary.totalConsidered} considered.` : '')
        : (summary.truncated ? `Showing the most recent ${summary.cap} of ${summary.totalConsidered} considered.` : '');

    const unresolvedList = h('div', { class: 'ds-map-unresolved-list' }, ...(summary.unresolved || []).map((p, i) =>
        h('div', { key: i, class: 'ds-map-unresolved-row' },
            h('a', { href: '#', onclick: (e) => { e.preventDefault(); setActiveId(p.id); } }, h('b', {}, p.ref)),
            ' ', h('span', { class: 'ds-muted' }, p.status),
            p.species ? ' -- ' + p.species : '',
            p.location ? ` (${p.location})` : '',
            p.symptoms ? ' -- ' + p.symptoms : '')));

    return Panel({ title: 'Map', children: [
        back, filterRow, overlayRow, legend,
        error ? Alert({ kind: 'error', children: error }) : null,
        canvas,
        unresolvedNote ? h('div', { class: 'ds-map-unresolved-note' }, unresolvedNote) : null,
        unresolvedList,
    ]});
}
