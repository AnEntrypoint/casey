// RESPONSIBILITY: the Leaflet instance itself -- creating it already framed on
// the reports, keeping its viewport honest as the shell resizes around it, and
// loading the pin payload into it.
//
// Imperative, NOT webjsx-rendered, per architecture spec section 1 ("Leaflet
// init logic ported as-is since Leaflet itself is not webjsx-rendered"). That
// is the line this module and its two neighbours sit on: everything that talks
// to `window.L` is here or in map-markers.js / map-overlays.js, and nothing
// here renders chrome. What each of the three owns:
//   map-leaflet.js   the map object, its viewport, and the load that fills it
//   map-markers.js   the pin, its three visual channels, the clustered layer
//   map-overlays.js  the four optional layers drawn beside the pins
// Everything below is one of: constructing the map, moving it, measuring it, or
// handing the loaded payload to the other two.

import { setMapExtent, schedule } from '../state.js';
import { filterOptionsFrom } from '../map-model.js';
import { fetchMapCases } from '../api.js';
import { renderMapMarkers } from './map-markers.js';
import { renderMapCoverage, renderMapWorkers, renderMapLastReports } from './map-overlays.js';

// A pin click SELECTS the case; it does not open a popup. There is no
// mapPopupHtml any more, deliberately.
//
// Measured on the reference consoles (.gm/research/osint-map-ui-brief.md):
// Liveuamap has literally zero popups -- .leaflet-popup is absent from its DOM
// and .popup-box is display:none -- and a marker click instead selects the
// matching rail card, scrolls the rail to it, and pushes a permalink. Watch
// Duty and FlightRadar24 both route selection into a route change feeding a
// docked panel. The reason is structural, not stylistic: a popup is an opaque
// rectangle anchored to the exact pin you are investigating, so it covers the
// neighbouring pins -- the immediate spatial context that tells an operator
// whether this is one sick animal or the edge of an outbreak. In a
// situational-awareness domain that is the one thing that must not be
// occluded (mapuipatterns' full-map rule, the same rule that put the queue in
// a docked rail rather than floating it over the canvas).
//
// Nothing the popup uniquely carried was dropped. Its descriptive fields are
// all in the case detail the rail now shows on selection, and its two ACTIONS
// are re-homed on the accessors in map-view-state.js.

// A fresh Leaflet map already framed on the reports it is about to show.
//
// FRAME FIRST, THEN ADD TILES. The map used to be constructed at a fixed
// [-28.5,25]@z5 and only fitted to the reports afterwards, so every landing
// paid for two or three COMPLETE tile pyramids -- z5, then z6, then often z7
// during the settle -- when only the last one is ever looked at. Measured at
// ~220 KB for a single pyramid, on a link this deployment assumes is metered
// and slow. The pin payload is already in hand by the time this is called, so
// the destination view is knowable BEFORE a single tile is requested, and a
// tileLayer only starts fetching once it is added to a map that has a view.
function createFramedMap(canvas, pins) {
    canvas.innerHTML = '';
    const map = window.L.map(canvas);
    const located = (pins || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (!located.length) {
        // No placeable report: southern Africa, the same view as before.
        map.setView([-28.5, 25], 5);
    } else {
        // A plain 24px padding, not the overlay-aware measurement: the chrome
        // is not mounted yet at construction time. The rAF pass in
        // autoFitToReports still refines against the real overlays once layout
        // has settled -- it just no longer has three pyramids behind it.
        try {
            map.fitBounds(window.L.latLngBounds(located.map((p) => [p.lat, p.lon])), { maxZoom: 11, padding: [24, 24], animate: false });
        } catch { map.setView([-28.5, 25], 5); }
    }
    const tiles = window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '(c) OpenStreetMap contributors' });
    tiles.addTo(map);
    return { map, tiles };
}

// A basemap failure and a data failure are the SAME picture -- pins on grey, or
// nothing on grey -- and the panel used to render one string for both. On the
// rural link this deployment targets they are not equally likely and they do
// not have the same answer: the API is same-origin and small, while the tiles
// are a third-party CDN pulling an order of magnitude more bytes, so the tiles
// are what actually goes missing. Telling an operator "could not load the map"
// when the reports loaded fine and only the backdrop is missing sends them to
// check the wrong thing.
//
// Judged on a RUN of failures, never a single one: one 404 is normal (a tile
// that genuinely does not exist at that zoom over open sea), and any successful
// tile clears the count, so a transient blip on a flaky link never latches the
// warning on.
const TILE_FAIL_RUN = 4;
function watchTileHealth(mapStateRef, tiles) {
    let tileFails = 0;
    const publish = (failing) => {
        const ms = mapStateRef.current;
        if (!ms || ms.tilesFailing === failing) return;
        ms.tilesFailing = failing;
        // The panel is webjsx-rendered and these events arrive outside any
        // render pass, so the flag has to be PUBLISHED to be seen -- the same
        // reason setAttention notifies rather than merely assigning.
        schedule();
    };
    tiles.on('tileerror', () => { tileFails += 1; if (tileFails >= TILE_FAIL_RUN) publish(true); });
    tiles.on('tileload', () => { tileFails = 0; publish(false); });
}

// Publish the viewport so the rail can narrow to what is actually on screen
// (mapuipatterns' extent-driven-content pattern). Without this the map was a
// picture, not a control: an operator could zoom into one district and still be
// reading a list covering the whole country. Debounced -- moveend also fires at
// the end of every inertia glide, and a re-render per frame of a drag is not
// free with 2000 pins.
function publishExtentOnMove(map) {
    let timer = null;
    const publish = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            try { setMapExtent(map.getBounds()); } catch { /* torn down mid-move */ }
        }, 150);
    };
    map.on('moveend', publish);
    map.on('zoomend', publish);
}

// The phone's map/list toggle hides the map pane with display:none, so the
// container really does go to 0x0. Calling invalidateSize against a zero box
// makes Leaflet recompute its centre from a degenerate rectangle -- measured
// live: switching map -> list -> map came back at a DIFFERENT centre and zoom,
// so the operator lost the district they had navigated to just by glancing at
// the list. Remember the real view instead and skip the resize while hidden.
function onCanvasResized(mapState, entries) {
    const box = entries && entries[0] && entries[0].contentRect;
    const hidden = box && (box.width === 0 || box.height === 0);
    try {
        if (hidden) {
            mapState.hiddenView = { center: mapState.map.getCenter(), zoom: mapState.map.getZoom() };
            return;
        }
        mapState.map.invalidateSize({ animate: false });
        if (mapState.hiddenView) {
            const { center, zoom } = mapState.hiddenView;
            mapState.hiddenView = null;
            mapState.map.setView(center, zoom, { animate: false });
        }
    } catch { /* container torn down mid-observe */ }
}

// Leaflet caches its container size and only recomputes on a WINDOW resize. In
// this shell the canvas resizes without one -- the rail swaps between the queue
// and a case detail, the pane's flex basis changes, the phone breakpoint flips
// -- and a stale cached size renders as grey seams where tiles were never
// requested. Observe the element itself.
function observeCanvasSize(mapState) {
    if (mapState.sizeObserver || typeof ResizeObserver !== 'function') return;
    try {
        mapState.sizeObserver = new ResizeObserver((entries) => onCanvasResized(mapState, entries));
        mapState.sizeObserver.observe(mapState.map.getContainer());
    } catch { /* observation is an optimisation, never a hard requirement */ }
}

// In the map-first shell the chrome does not sit BESIDE the canvas, it sits ON
// it -- so the canvas rect overstates the visible map. Fitting to the raw rect
// centres a cluster underneath the attention queue or the stat pills, which
// looks exactly like "the map opened somewhere else": the pins are on screen,
// just behind an opaque panel. Rather than hardcode guesses that would go stale
// the moment an overlay is collapsed (both of ours are toggleable) or the
// layout reflows on a phone, measure the overlays that are ACTUALLY mounted
// right now and convert each one's intrusion into Leaflet's corner padding.
function overlayFitPadding(canvas) {
    const FALLBACK = { paddingTopLeft: [24, 24], paddingBottomRight: [24, 24] };
    try {
        const shell = canvas && canvas.closest ? canvas.closest('.ds-map-shell') : null;
        if (!shell) return FALLBACK;
        const base = shell.getBoundingClientRect();
        if (!base.width || !base.height) return FALLBACK;
        let top = 0, right = 0, bottom = 0, left = 0;
        // Both chrome families: the docked-rail era leaves only the legend and
        // the error alert on the canvas, but the selector covers any future
        // on-canvas element without needing to be revisited.
        for (const el of shell.querySelectorAll('.ds-map-chrome > *, .ds-map-overlay')) {
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            // Only the edge an overlay is actually anchored to is padded: an
            // element hugging the top contributes its height to `top`, not its
            // width to `left`, otherwise a wide top strip would squeeze the fit
            // horizontally for no reason.
            const dTop = r.top - base.top, dBottom = base.bottom - r.bottom;
            const dLeft = r.left - base.left, dRight = base.right - r.right;
            const vertical = Math.min(dTop, dBottom) <= Math.min(dLeft, dRight);
            if (vertical) { if (dTop <= dBottom) top = Math.max(top, dTop + r.height); else bottom = Math.max(bottom, dBottom + r.height); }
            else if (dLeft <= dRight) left = Math.max(left, dLeft + r.width);
            else right = Math.max(right, dRight + r.width);
        }
        // Never let chrome claim more than 40% of an axis -- on a small phone
        // the overlays can exceed the canvas, and an over-padded fitBounds
        // throws or collapses to a nonsense zoom.
        const capX = base.width * 0.4, capY = base.height * 0.4;
        return {
            paddingTopLeft: [Math.min(Math.max(left, 24), capX), Math.min(Math.max(top, 24), capY)],
            paddingBottomRight: [Math.min(Math.max(right, 24), capX), Math.min(Math.max(bottom, 24), capY)],
        };
    } catch { return FALLBACK; }
}

// Frame the map on the reports themselves, once, on first load. The
// constructor's fallback view is a fixed [-28.5,25]@5 that shows most of
// southern Africa regardless of where anything actually is -- measured live, a
// dataset entirely inside South Africa opened centred over Angola and Zambia,
// so the BLUF question ("what is going on where") needed a manual pan and zoom
// before it could be answered at all.
//
// First load ONLY (didAutoFit), never on refilter/refresh: re-fitting on every
// poll would yank the viewport out from under an operator who has deliberately
// panned or zoomed somewhere. maxZoom keeps a single lone report from slamming
// to street level, where surrounding context is lost.
function autoFitToReports(mapState) {
    if (mapState.didAutoFit) return;
    const located = (mapState.pins || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (!located.length) return;
    mapState.didAutoFit = true;
    const bounds = window.L.latLngBounds(located.map((p) => [p.lat, p.lon]));
    // Kept, not discarded. These bounds were computed once for the first-load
    // fit and then thrown away, which left an operator who had zoomed into one
    // district with no way back to "everything" short of reloading the page --
    // and a reload costs the map payload and a fresh round of tiles on a link
    // that charges by the megabyte.
    mapState.allBounds = bounds;
    // Deferred a frame on purpose. loadMap runs in the same tick the panel's
    // webjsx pass mounts the overlays, so measuring them here returns zero-size
    // rects and overlayFitPadding silently degrades to its 24px floor -- which
    // is exactly the bug it exists to prevent (witnessed: 2 of 6 pins fitted
    // underneath the queue). One rAF lets layout settle so the measurement is
    // real, and the shell is resolved from the map's OWN live container: a
    // poll-driven re-render can swap the canvas element out between loadMap
    // starting and this callback running, and a detached node's closest()
    // returns null.
    const fit = () => {
        try { mapState.map.fitBounds(bounds, { maxZoom: 11, ...overlayFitPadding(mapState.map.getContainer()) }); }
        catch { /* a degenerate bounds box must never break the panel */ }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(fit)); else fit();
}

// Creates the Leaflet map on first call and reuses it afterwards, loads the
// pins, and reports back through `callbacks` -- onOptions with the filter
// vocabularies, onSummary with the counts the rail states, onError with a
// sentence naming what failed. `filters` is the live-read state.mapFilter.
export async function loadMap(mapStateRef, canvas, filters, days, callbacks) {
    if (!canvas) return null;
    // fetchMapCases -> qs() expects a params OBJECT (Object.entries(params)) --
    // passing the bare `days` string here (qs()'s `params || {}` guard never
    // fires since a non-empty string is truthy) made Object.entries iterate
    // the STRING's characters instead, sending ?0=<first digit> and silently
    // dropping the days filter entirely (the server's /api/map/cases only
    // reads req.query.days -- confirmed live: the days dropdown had zero
    // effect on which pins loaded).
    const j = await fetchMapCases({ days }).catch(() => null);
    // Names the DATA specifically. "Could not load the map" was true of a
    // basemap outage too, and the two need different actions from the
    // operator -- see watchTileHealth above.
    if (!j) {
        if (callbacks && callbacks.onError) callbacks.onError('Could not load the reports. The map could not reach this dashboard\'s own server, so what you see may be out of date.');
        return mapStateRef.current;
    }
    if (!mapStateRef.current) {
        const { map, tiles } = createFramedMap(canvas, j.pins);
        mapStateRef.current = {
            map, markerLayer: null, clusterLines: null, coverageLayer: null, workersLayer: null, lastReportsLayer: null,
            markerById: new Map(), selectedId: null, tilesFailing: false,
            pins: [], clusters: [], workers: [], showCoverage: false, showClusters: false, showWorkers: false, showLastReports: false,
        };
        watchTileHealth(mapStateRef, tiles);
        publishExtentOnMove(map);
    }
    const mapState = mapStateRef.current;
    observeCanvasSize(mapState);

    mapState.pins = j.pins || [];
    mapState.clusters = j.clusters || [];
    if (callbacks && callbacks.onOptions) callbacks.onOptions(filterOptionsFrom(mapState.pins));
    renderMapMarkers(mapState, filters);
    autoFitToReports(mapState);
    if (callbacks && callbacks.onSummary) {
        callbacks.onSummary({
            unresolvedCount: j.unresolved_count || 0,
            unresolved: j.unresolved || [],
            truncated: j.truncated, cap: j.cap, totalConsidered: j.total_considered,
        });
    }
    return mapState;
}

// ---- moving the map -----------------------------------------------------

// Move the map to one case, used when the attention queue (or any list) picks a
// report -- see map-view-state.js's onActiveIdChange subscription. Cap the
// zoom: landing at max zoom on a rural point with no surrounding landmarks
// reads as a broken blank map, which is precisely the disorientation a low-
// computer-literacy operator cannot recover from. No-op when the case has no
// placeable location (the "no location yet" count on the rail), so the map
// stays put.
export function focusCaseOnMap(mapState, id) {
    if (!mapState || !mapState.map) return false;
    const p = (mapState.pins || []).find((x) => x.id === id);
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return false;
    try {
        mapState.map.setView([p.lat, p.lon], Math.min(Math.max(mapState.map.getZoom() || 0, 9), 13), { animate: true });
    } catch { return false; }
    return true;
}

// Back to every report, using the same bounds and the same overlay-aware
// padding the first-load fit used, so "show everything" lands exactly where
// the map opened rather than somewhere subtly different.
export function resetMapView(mapState) {
    if (!mapState || !mapState.map || !mapState.allBounds) return false;
    try {
        mapState.map.fitBounds(mapState.allBounds, {
            maxZoom: 11,
            ...overlayFitPadding(mapState.map.getContainer()),
        });
    } catch { return false; }
    return true;
}

// ---- what the rail's toggles reach --------------------------------------
// Clusters rides on the marker rebuild rather than an independent layer,
// because the lines are drawn between the pins that survived the filter.
export function toggleClusters(mapState, filters) { mapState.showClusters = !mapState.showClusters; renderMapMarkers(mapState, filters); }
export function refilterMarkers(mapState, filters) { renderMapMarkers(mapState, filters); }
export async function toggleCoverage(mapState) { mapState.showCoverage = !mapState.showCoverage; await renderMapCoverage(mapState); }
export async function toggleWorkers(mapState) { mapState.showWorkers = !mapState.showWorkers; await renderMapWorkers(mapState); }
export async function toggleLastReports(mapState) { mapState.showLastReports = !mapState.showLastReports; await renderMapLastReports(mapState); }
