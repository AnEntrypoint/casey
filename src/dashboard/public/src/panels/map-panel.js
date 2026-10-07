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
import { stageLabel } from '../format.js';
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
    return h('div', { class: 'ds-map-legend' },
        ...Object.entries(STATUS_TOKEN).map(([k, tok]) =>
            h('span', { key: k, class: 'ds-map-legend-item' }, h('span', { class: 'ds-map-legend-sw', 'data-status-token': tok }), stageLabel(k))),
        h('span', { key: 'urgent', class: 'ds-map-legend-item' },
            h('span', { class: 'ds-map-legend-sw ds-map-legend-sw-urgent', 'data-urgency': '3' }), queueName()),
        h('span', { key: 'loc-estimated', class: 'ds-map-legend-item' },
            h('span', { class: 'ds-map-legend-sw ds-map-legend-sw-dashed' }), sentence(LOCATION_SOURCE_LABEL.estimated)),
        h('span', { key: 'ov-cluster', class: 'ds-map-legend-item' },
            h('span', { class: 'ds-map-legend-sw ds-map-legend-sw-cluster' }), 'Related reports (Clusters overlay)'),
        h('span', { key: 'ov-coverage', class: 'ds-map-legend-item' },
            h('span', { class: 'ds-map-legend-sw ds-map-legend-sw-coverage' }), 'Area worked (Coverage overlay)'),
        h('span', { key: 'ov-worker', class: 'ds-map-legend-item' },
            h('span', { class: 'ds-map-legend-sw ds-map-legend-sw-worker' }), 'Field worker (Workers overlay)'),
        h('span', { key: 'ov-overdue', class: 'ds-map-legend-item' },
            h('span', { class: 'ds-map-legend-sw ds-map-legend-sw-overdue' }), 'Field worker, check-in overdue (red, larger)'),
        h('span', { key: 'ov-report', class: 'ds-map-legend-item' },
            h('span', { class: 'ds-map-legend-sw ds-map-legend-sw-report' }), 'Last reported from (Last reported overlay)'));
}

function mapStateNote() {
    const error = loadError();
    if (error) return { kind: 'error', text: error };
    if (!hasLoadedOnce()) return null;
    const c = counts();
    if (!c.plotted) {
        const summary = loadSummary();
        if (summary.unresolvedCount) {
            return { kind: 'info', text: `Nothing can be placed on the map yet -- all ${countOf(summary.unresolvedCount)} ${summary.unresolvedCount === 1 ? 'is' : 'are'} missing a usable location. They are listed below.` };
        }
        const days = state.mapFilter.days;
        return days && days !== '0'
            ? { kind: 'info', text: `No reports in the last ${days} days. Widen the time window to see older ones.` }
            : { kind: 'info', text: 'No reports have come in yet -- nothing has been reported.' };
    }
    if (!c.visible) return { kind: 'info', text: 'No reports match the filters you have on.' };
    if (mapStateRef.current && mapStateRef.current.tilesFailing) {
        return { kind: 'warn', text: 'The map background is not loading. The pins and the list below come from this dashboard and are unaffected -- only the map picture behind them is missing.' };
    }
    return null;
}

function mapTextEquivalent() {
    const error = loadError();
    if (error) return 'The map could not load: ' + error;
    if (!hasLoadedOnce()) return 'The map is still loading.';
    const c = counts();
    const parts = ['Map of where reports came from. Each pin is one report: its colour is the report status, its size and ring say how urgent it is, and a dashed border means the location is an estimate rather than a GPS reading.'];
    parts.push(c.plotted === 1 ? '1 report is plotted.' : c.plotted + ' reports are plotted.');
    if (c.visible !== c.plotted) parts.push(c.visible + ' of them match the filters you have on.');
    if (c.inView != null) parts.push(c.inView + ' are inside the part of the map now on screen.');
    if (c.visible) {
        parts.push('By urgency: '
            + [3, 2, 1].map((b) => c.bands[b] + ' marked "' + URGENCY_BAND_LABEL[b] + '"').join(', ')
            + ', and ' + c.bands[0] + ' with nothing chasing them.');
    }
    parts.push(countOf(c.attention) + (c.attention === 1 ? ' is' : ' are') + ' in the "' + queueName() + '" list beside the map, and ' + c.today + ' came in today.');
    const missing = unresolvedSummaryText();
    if (missing) parts.push(missing + ' -- these are not on the map.');
    const note = mapStateNote();
    if (note) parts.push(note.text);
    return parts.join(' ');
}

export function MapPanel() {
    const note = mapStateNote();
    return h('div', { class: 'ds-map-shell' },
        h('h2', { id: MAP_HEADING_ID, class: 'sr-only' }, 'Where the reports are'),
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
