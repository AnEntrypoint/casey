import * as webjsx from '/design/vendor/webjsx/index.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { state } from '../state.js';
import { URGENCY_BAND_LABEL, queueName, LOCATION_SOURCE_LABEL } from '../map-model.js';
import { STATUS_TOKEN } from './map-markers.js';
import {
    mapStateRef, refresh, discardMap, counts, loadSummary, loadError, hasLoadedOnce,
    unresolvedSummaryText,
} from './map-view-state.js';
import { countOf } from '../vocabulary.js';
import { stageLabel, FILTERED_EMPTY_TEXT } from '../format.js';
import { word } from '../words.js';
const sentence = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

const h = webjsx.createElement;

const MAP_HEADING_ID = 'ds-map-heading';
const MAP_SUMMARY_ID = 'ds-map-summary';

function mapCanvas() {
    const canvas = h('div', {
        id: 'ds-map-canvas', class: 'ds-map-canvas', key: 'ds-map-canvas',
        role: 'region', 'aria-labelledby': MAP_HEADING_ID, 'aria-describedby': MAP_SUMMARY_ID,
    });
    queueMicrotask(() => onMountCanvas(document.getElementById('ds-map-canvas')));
    return canvas;
}

let lastAttemptedEl = null;
function onMountCanvas(el) {
    if (!el) return;
    if (mapStateRef.current && mapStateRef.current.map.getContainer() === el) return;
    if (el === lastAttemptedEl) return;
    lastAttemptedEl = el;
    if (mapStateRef.current) discardMap();
    refresh();
}

function mapLegend() {
    return h('div', { class: 'ds-map-legend', role: 'group', tabindex: '0', 'aria-label': word('ui.map_panel_key_aria') },
        ...Object.entries(STATUS_TOKEN).map(([k, tok]) =>
            h('span', { key: k, class: 'ds-map-legend-item' }, h('span', { class: 'ds-map-legend-sw', 'data-status-token': tok }), stageLabel(k))),
        h('span', { key: 'urgent', class: 'ds-map-legend-item' },
            h('span', { class: 'ds-map-legend-sw ds-map-legend-sw-urgent', 'data-urgency': '3' }), queueName()),
        h('span', { key: 'loc-estimated', class: 'ds-map-legend-item' },
            h('span', { class: 'ds-map-legend-sw ds-map-legend-sw-dashed' }), sentence(LOCATION_SOURCE_LABEL.estimated)),
        h('span', { key: 'ov-cluster', class: 'ds-map-legend-item' },
            h('span', { class: 'ds-map-legend-sw ds-map-legend-sw-cluster' }), word('ui.map_panel_legend_clusters')),
        h('span', { key: 'ov-coverage', class: 'ds-map-legend-item' },
            h('span', { class: 'ds-map-legend-sw ds-map-legend-sw-coverage' }), word('ui.map_panel_legend_coverage')),
        h('span', { key: 'ov-worker', class: 'ds-map-legend-item' },
            h('span', { class: 'ds-map-legend-sw ds-map-legend-sw-worker' }), word('ui.map_panel_legend_worker')),
        h('span', { key: 'ov-overdue', class: 'ds-map-legend-item' },
            h('span', { class: 'ds-map-legend-sw ds-map-legend-sw-overdue' }), word('ui.map_panel_legend_overdue')),
        h('span', { key: 'ov-report', class: 'ds-map-legend-item' },
            h('span', { class: 'ds-map-legend-sw ds-map-legend-sw-report' }), word('ui.map_panel_legend_report')));
}

function mapStateNote() {
    const error = loadError();
    if (error) return { kind: 'error', text: error };
    if (!hasLoadedOnce()) return null;
    const c = counts();
    if (!c.plotted) {
        const summary = loadSummary();
        if (summary.unresolvedCount) {
            const n = summary.unresolvedCount;
            return { kind: 'info', text: word('ui.map_panel_nothing_placed', { count: countOf(n), verb: word(n === 1 ? 'ui.map_panel_is' : 'ui.map_panel_are') }) };
        }
        const days = state.mapFilter.days;
        return days && days !== '0'
            ? { kind: 'info', text: word('ui.map_panel_no_reports_days', { days }) }
            : { kind: 'info', text: word('ui.map_panel_no_reports') };
    }
    if (!c.visible) return { kind: 'info', text: FILTERED_EMPTY_TEXT };
    if (mapStateRef.current && mapStateRef.current.tilesFailing) {
        return { kind: 'warn', text: word('ui.map_panel_tiles_failing') };
    }
    return null;
}

function mapTextEquivalent() {
    const error = loadError();
    if (error) return word('ui.map_panel_could_not_load', { error });
    if (!hasLoadedOnce()) return word('ui.map_panel_still_loading');
    const c = counts();
    const parts = [word('ui.map_panel_text_intro')];
    parts.push(word(c.plotted === 1 ? 'ui.map_panel_plotted_one' : 'ui.map_panel_plotted_many', { count: c.plotted }));
    if (c.visible !== c.plotted) parts.push(word('ui.map_panel_match_filters', { count: c.visible }));
    if (c.inView != null) parts.push(word('ui.map_panel_in_view', { count: c.inView }));
    if (c.visible) {
        parts.push(word('ui.map_panel_by_urgency', {
            bands: [3, 2, 1].map((b) => word('ui.map_panel_marked', { count: c.bands[b], band: URGENCY_BAND_LABEL[b] })).join(', '),
            none: c.bands[0],
        }));
    }
    parts.push(word(c.attention === 1 ? 'ui.map_panel_attention_one' : 'ui.map_panel_attention_many', {
        count: countOf(c.attention), queue: queueName(), today: c.today,
    }));
    const missing = unresolvedSummaryText();
    if (missing) parts.push(word('ui.map_panel_missing', { missing }));
    const note = mapStateNote();
    if (note) parts.push(note.text);
    return parts.join(' ');
}

export function MapPanel() {
    const note = mapStateNote();
    return h('div', { class: 'ds-map-shell' },
        h('h2', { id: MAP_HEADING_ID, class: 'sr-only' }, word('ui.map_panel_heading')),
        h('p', { id: MAP_SUMMARY_ID, class: 'sr-only', 'data-map-text-equivalent': '' }, mapTextEquivalent()),
        mapCanvas(),
        h('div', { class: 'ds-map-chrome' }, mapLegend()),
        note
            ? h('div', { class: 'ds-map-overlay-error', role: note.kind === 'error' ? 'alert' : 'status' },
                Alert({ kind: note.kind, children: note.text }))
            : null);
}

export { MapRail, visibleQueueRows } from './map-rail.js';
export {
    refreshMapData, mapDebugSnapshot, clusterNoteFor, canDispatchFor, dispatchWorkerFor,
} from './map-view-state.js';
