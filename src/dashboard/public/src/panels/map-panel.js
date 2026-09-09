// RESPONSIBILITY: the map pane's chrome -- the canvas and its mount, the
// legend, the one state note, and what the map says to someone who cannot see
// it -- and the map feature's single import surface for the rest of the SPA.
//
// The canvas is the whole pane, and the ONLY things allowed to sit on it are
// the legend and one error/empty note. Everything else -- counts, the
// worst-first queue, filters, overlays, the no-location list -- is docked in
// the rail (map-rail.js). The pane also carries the map's heading and its text
// equivalent, both `sr-only`: they occupy no space and cover no pin, and they
// are what the canvas is named and described by for a reader who cannot see it.
// That split is not a style preference: mapuipatterns' full-map page states
// outright that situational-awareness and safety domains must not cover
// potentially important data with floating panels, and the measurable version
// of the failure here was pins fitted underneath an opaque queue card -- on
// screen, but unreadable and unclickable.
//
// How the map feature is divided, so a change lands in one place:
//   map-model.js       derivations both halves read (urgency, filter, counts)
//   map-view-state.js  the live view state and the one load, shared by both
//   map-leaflet.js     the Leaflet instance, its viewport, and the load
//   map-markers.js     the pin's three visual channels and the clustered layer
//   map-overlays.js    the four optional layers drawn beside the pins
//   map-rail.js        the rail's chrome
//   map-panel.js       this file: the pane's chrome, plus the re-exports below
//
// The re-exports at the bottom are deliberate: the rest of the SPA imports the
// map feature from ONE path, so how the feature is divided internally is not
// something main.js or the case detail has to track.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { state } from '../state.js';
import { URGENCY_BAND_LABEL, QUEUE_NAME, LOCATION_SOURCE_LABEL } from '../map-model.js';
import { STATUS_TOKEN } from './map-markers.js';
import {
    mapStateRef, refresh, discardMap, counts, loadSummary, loadError, hasLoadedOnce,
    unresolvedSummaryText,
} from './map-view-state.js';

const h = webjsx.createElement;

// The ids the canvas is named and described by. Named constants because three
// separate nodes have to agree on them and a typo in any one silently drops
// the name or the description with nothing on screen to show for it.
const MAP_HEADING_ID = 'ds-map-heading';
const MAP_SUMMARY_ID = 'ds-map-summary';

// ---- the canvas ---------------------------------------------------------

function mapCanvas() {
    // A stable key so webjsx PRESERVES this node across the poll-driven
    // re-renders instead of replacing it. Without one, every re-render handed
    // onMountCanvas a brand-new element, which tore down the Leaflet instance
    // and rebuilt it -- refetching tiles and losing the operator's viewport.
    // The live-container guard in onMountCanvas stays as the backstop for the
    // genuine remount case (switching home views and back).
    // The canvas is a named region described by the spoken summary beside it.
    // Without a role it reached the accessibility tree as one anonymous
    // `generic` node with no name and no content, so the whole of this
    // deployment's home view -- every report, every pin, every urgency band --
    // was simply absent for a screen-reader user. `region` rather than `img`:
    // the markers inside it are real controls and must stay reachable.
    const canvas = h('div', {
        id: 'ds-map-canvas', class: 'ds-map-canvas', key: 'ds-map-canvas',
        role: 'region', 'aria-labelledby': MAP_HEADING_ID, 'aria-describedby': MAP_SUMMARY_ID,
    });
    // webjsx DOES support refs -- vendor/webjsx assignRef() is called from
    // createDOMElement.js on creation and from applyDiff.js on every diff whose
    // props carry one, for both a function ref and a {current} object. It is
    // not used here for a different reason: on the creation path assignRef runs
    // BEFORE the node is attached to the document, and Leaflet needs a
    // container that is really in the page to measure itself against. Deferring
    // to a microtask puts the mount after the whole render pass, and looking
    // the node up by id then returns the element actually in the document
    // rather than a captured one a later diff may have replaced. onMountCanvas
    // is idempotent (it guards on the LIVE Leaflet container), so calling it
    // every render is safe.
    queueMicrotask(() => onMountCanvas(document.getElementById('ds-map-canvas')));
    return canvas;
}

// Guard on the LIVE element: Leaflet's own map.getContainer() names which DOM
// node it is actually bound to, so a canvas swap is detected and re-mounted
// while the SAME persisted element across a no-op re-render is left alone. A
// one-shot `mounted` boolean (an earlier version) latched on first render and
// the map vanished within one poll interval.
function onMountCanvas(el) {
    if (!el) return;
    if (mapStateRef.current && mapStateRef.current.map.getContainer() === el) return;
    if (mapStateRef.current) discardMap();
    refresh();
}

// ---- the legend ---------------------------------------------------------

function mapLegend() {
    // Documents every visual channel a pin encodes. The legend is the one
    // thing allowed to sit on the canvas precisely because the map cannot be
    // read without it -- so a channel added without a legend entry ships an
    // unreadable symbol.
    return h('div', { class: 'ds-map-legend' },
        ...Object.entries(STATUS_TOKEN).map(([k, tok]) =>
            h('span', { key: k, class: 'ds-map-legend-item' }, h('span', { class: 'ds-map-legend-sw', 'data-status-token': tok }), k.replace(/_/g, ' '))),
        h('span', { key: 'urgent', class: 'ds-map-legend-item' },
            h('span', { class: 'ds-map-legend-sw ds-map-legend-sw-urgent', 'data-urgency': '3' }), 'needs a person'),
        h('span', { key: 'loc-estimated', class: 'ds-map-legend-item' },
            h('span', { class: 'ds-map-legend-sw ds-map-legend-sw-dashed' }), LOCATION_SOURCE_LABEL.estimated));
}

// ---- the one note on the canvas -----------------------------------------

// A tile failure and a data failure look identical on screen -- pins on grey,
// or nothing on grey -- so say which happened. The distinction matters on a
// rural link, where the tiles are the thing most likely to be unreachable
// while the API is fine.
//
// Ordered by what the operator most needs to know, and only ever ONE note,
// because the canvas is allowed exactly two occupants (this and the legend)
// and a stack of alerts over a situational-awareness map is the floating-panel
// anti-pattern this layout exists to avoid. A data failure outranks an empty
// result, which outranks a missing backdrop -- a basemap outage is the least
// harmful of the three because every report is still plotted and still
// clickable on top of the grey.
function mapStateNote() {
    const error = loadError();
    if (error) return { kind: 'error', text: error };
    if (!hasLoadedOnce()) return null;
    const c = counts();
    if (!c.plotted) {
        const summary = loadSummary();
        if (summary.unresolvedCount) {
            return { kind: 'info', text: `Nothing can be placed on the map yet -- all ${summary.unresolvedCount} report(s) are missing a usable location. They are listed below.` };
        }
        // "No reports in this time window yet" names the time window as the
        // reason. On All time -- the default -- there is no window, so that
        // sentence pointed the operator at a control that could not help and
        // rendered "nothing has happened yet" as if it were "your time filter
        // hid everything". They are two of the four facts this function has to
        // keep apart, so they get two sentences.
        const days = state.mapFilter.days;
        return days && days !== '0'
            ? { kind: 'info', text: `No reports in the last ${days} days. Widen the time window to see older ones.` }
            : { kind: 'info', text: 'No reports have come in yet -- nothing has been reported.' };
    }
    if (!c.visible) return { kind: 'info', text: 'No reports match the filters you have on.' };
    if (mapStateRef.current && mapStateRef.current.tilesFailing) {
        return { kind: 'warn', text: 'The map background is not loading -- the reports below are still correct and still up to date, only the map picture behind them is missing.' };
    }
    return null;
}

// ---- what the map says to someone who cannot see it ----------------------

// The map's text equivalent: what it shows, how much of it, and the same
// counts the rail states as chips -- every one of them from map-model.js's
// mapCounts, so the sentence and the numbers beside it cannot disagree. It is
// visually hidden because the map itself already answers all of this for
// anyone who can see it; repeating it on screen would be the redundant second
// copy the rail's chips already rule out.
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
        // The same three rungs the pins are sized and ringed by, named with
        // map-model.js's own labels rather than a second wording of them.
        parts.push('By urgency: '
            + [3, 2, 1].map((b) => c.bands[b] + ' marked "' + URGENCY_BAND_LABEL[b] + '"').join(', ')
            + ', and ' + c.bands[0] + ' with nothing chasing them.');
    }
    parts.push(c.attention + ' report(s) are in the "' + QUEUE_NAME + '" list beside the map, and ' + c.today + ' came in today.');
    // The same sentence the no-location disclosure shows, not a second wording
    // of it: a report that cannot be plotted is a surveillance blind spot, and
    // it must be as audible as it is visible.
    const missing = unresolvedSummaryText();
    if (missing) parts.push(missing + ' -- these are not on the map.');
    const note = mapStateNote();
    if (note) parts.push(note.text);
    return parts.join(' ');
}

export function MapPanel() {
    const note = mapStateNote();
    return h('div', { class: 'ds-map-shell' },
        // The map pane's own heading, and the words the canvas is named and
        // described by. Both are sr-only: on screen the map, the legend and
        // the rail already say all of it, and a visible copy would be read
        // twice by anyone using both channels.
        h('h2', { id: MAP_HEADING_ID, class: 'sr-only' }, 'Where the reports are'),
        h('p', { id: MAP_SUMMARY_ID, class: 'sr-only', 'data-map-text-equivalent': '' }, mapTextEquivalent()),
        mapCanvas(),
        h('div', { class: 'ds-map-chrome' }, mapLegend()),
        note
            ? h('div', { class: 'ds-map-overlay-error', role: note.kind === 'error' ? 'alert' : 'status' },
                Alert({ kind: note.kind, children: note.text }))
            : null);
}

// ---- the map feature's import surface ------------------------------------
// views/map-command-center.js renders MapPanel beside MapRail; main.js polls
// refreshMapData while the map is on screen and walks visibleQueueRows with
// j/k; views/case-detail-view.js asks the three case-scoped accessors what the
// live map knows about one report. All of them import from here.
export { MapRail, visibleQueueRows } from './map-rail.js';
export {
    refreshMapData, mapDebugSnapshot, clusterNoteFor, canDispatchFor, dispatchWorkerFor,
} from './map-view-state.js';
