import { setMapExtent, schedule } from '../state.js';
import { filterOptionsFrom } from '../map-model.js';
import { fetchMapCases } from '../api.js';
import { renderMapMarkers } from './map-markers.js';
import { renderMapCoverage, renderMapWorkers, renderMapLastReports } from './map-overlays.js';

function createFramedMap(canvas, pins) {
    canvas.innerHTML = '';
    const map = window.L.map(canvas);
    const located = (pins || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (!located.length) {
        map.setView([-28.5, 25], 5);
    } else {
        try {
            map.fitBounds(window.L.latLngBounds(located.map((p) => [p.lat, p.lon])), { maxZoom: 11, padding: [24, 24], animate: false });
        } catch { map.setView([-28.5, 25], 5); }
    }
    const tiles = window.L.tileLayer(tileUrl(), { maxZoom: 18, attribution: '(c) OpenStreetMap contributors' });
    tiles.addTo(map);
    return { map, tiles };
}

function tileUrl() {
    try {
        const el = document.querySelector('meta[name="casey-tile-url"]');
        const v = el && el.getAttribute('content');
        if (v) return v;
    } catch {  }
    return '/tiles/{z}/{x}/{y}.png';
}

const TILE_FAIL_RUN = 4;
function watchTileHealth(mapStateRef, tiles) {
    let tileFails = 0;
    const publish = (failing) => {
        const ms = mapStateRef.current;
        if (!ms || ms.tilesFailing === failing) return;
        ms.tilesFailing = failing;
        schedule();
    };
    tiles.on('tileerror', () => { tileFails += 1; if (tileFails >= TILE_FAIL_RUN) publish(true); });
    tiles.on('tileload', () => { tileFails = 0; publish(false); });
}

function publishExtentOnMove(map) {
    let timer = null;
    const publish = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            try { setMapExtent(map.getBounds()); } catch {  }
        }, 150);
    };
    map.on('moveend', publish);
    map.on('zoomend', publish);
}

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
    } catch {  }
}

function observeCanvasSize(mapState) {
    if (mapState.sizeObserver || typeof ResizeObserver !== 'function') return;
    try {
        mapState.sizeObserver = new ResizeObserver((entries) => onCanvasResized(mapState, entries));
        mapState.sizeObserver.observe(mapState.map.getContainer());
    } catch {  }
}

function overlayFitPadding(canvas) {
    const FALLBACK = { paddingTopLeft: [24, 24], paddingBottomRight: [24, 24] };
    try {
        const shell = canvas && canvas.closest ? canvas.closest('.ds-map-shell') : null;
        if (!shell) return FALLBACK;
        const base = shell.getBoundingClientRect();
        if (!base.width || !base.height) return FALLBACK;
        let top = 0, right = 0, bottom = 0, left = 0;
        for (const el of shell.querySelectorAll('.ds-map-chrome > *, .ds-map-overlay')) {
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            const dTop = r.top - base.top, dBottom = base.bottom - r.bottom;
            const dLeft = r.left - base.left, dRight = base.right - r.right;
            const vertical = Math.min(dTop, dBottom) <= Math.min(dLeft, dRight);
            if (vertical) { if (dTop <= dBottom) top = Math.max(top, dTop + r.height); else bottom = Math.max(bottom, dBottom + r.height); }
            else if (dLeft <= dRight) left = Math.max(left, dLeft + r.width);
            else right = Math.max(right, dRight + r.width);
        }
        const capX = base.width * 0.4, capY = base.height * 0.4;
        return {
            paddingTopLeft: [Math.min(Math.max(left, 24), capX), Math.min(Math.max(top, 24), capY)],
            paddingBottomRight: [Math.min(Math.max(right, 24), capX), Math.min(Math.max(bottom, 24), capY)],
        };
    } catch { return FALLBACK; }
}

function autoFitToReports(mapState) {
    if (mapState.didAutoFit) return;
    const located = (mapState.pins || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (!located.length) return;
    mapState.didAutoFit = true;
    const bounds = window.L.latLngBounds(located.map((p) => [p.lat, p.lon]));
    mapState.allBounds = bounds;
    const fit = () => {
        try { mapState.map.fitBounds(bounds, { maxZoom: 11, ...overlayFitPadding(mapState.map.getContainer()) }); }
        catch {  }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(fit)); else fit();
}

export async function loadMap(mapStateRef, canvas, filters, days, callbacks) {
    if (!canvas) return null;
    const j = await fetchMapCases({ days }).catch(() => null);
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

export function focusCaseOnMap(mapState, id) {
    if (!mapState || !mapState.map) return false;
    const p = (mapState.pins || []).find((x) => x.id === id);
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return false;
    try {
        mapState.map.setView([p.lat, p.lon], Math.min(Math.max(mapState.map.getZoom() || 0, 9), 13), { animate: true });
    } catch { return false; }
    return true;
}

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

export function toggleClusters(mapState, filters) { mapState.showClusters = !mapState.showClusters; renderMapMarkers(mapState, filters); }
export function refilterMarkers(mapState, filters) { renderMapMarkers(mapState, filters); }
export async function toggleCoverage(mapState) { mapState.showCoverage = !mapState.showCoverage; await renderMapCoverage(mapState); }
export async function toggleWorkers(mapState) { mapState.showWorkers = !mapState.showWorkers; await renderMapWorkers(mapState); }
export async function toggleLastReports(mapState) { mapState.showLastReports = !mapState.showLastReports; await renderMapLastReports(mapState); }
