import {
    state, schedule, onActiveIdChange, onAttentionChange, onMobilePaneChange,
} from '../state.js';
import { onConnectionRestored } from '../api.js';
import { urgencyByCaseId, mapCounts, queueRows as queueRowsFor } from '../map-model.js';
import { loadMap, focusCaseOnMap, refilterMarkers } from './map-leaflet.js';
import { setSelectedCase } from './map-markers.js';
import { openDispatchPicker } from './dispatch-picker.js';

export const mapStateRef = { current: null };

let options = { species: [], types: [], statuses: [] };
let summary = { unresolvedCount: 0, unresolved: [], truncated: false, cap: 0, totalConsidered: 0 };
let error = null;
let loadedOnce = false;
let lastUpdatedAt = null;

export const QUEUE_PAGE = 8;
let queueShown = QUEUE_PAGE;

export const filterOptions = () => options;
export const loadSummary = () => summary;
export const loadError = () => error;
export const hasLoadedOnce = () => loadedOnce;
export const updatedAt = () => lastUpdatedAt;
export const queueShownCount = () => queueShown;
export const setQueueShown = (n) => { queueShown = n; schedule(); };

let inFlight = false;
const INFLIGHT_STALE_MS = 30000;
let inFlightSince = 0;
const RETRY_MIN_GAP_MS = 3000;
let lastAttemptAt = 0;
export function refresh() {
    if (inFlight && (Date.now() - inFlightSince) < INFLIGHT_STALE_MS) return;
    if (Date.now() - lastAttemptAt < RETRY_MIN_GAP_MS) return;
    lastAttemptAt = Date.now();
    inFlight = true;
    inFlightSince = Date.now();
    error = null;
    loadMap(mapStateRef, document.getElementById('ds-map-canvas'), state.mapFilter, state.mapFilter.days, {
        onOptions: (o) => { options = o; schedule(); },
        onSummary: (s) => { summary = s; loadedOnce = true; lastUpdatedAt = Date.now(); schedule(); },
        onError: (msg) => { error = msg; loadedOnce = true; schedule(); },
    }).finally(() => { inFlight = false; });
}

export function refreshMapData() {
    refresh();
}

export function discardMap() {
    const ms = mapStateRef.current;
    if (!ms) return;
    try { ms.sizeObserver?.disconnect(); } catch {  }
    ms.map.remove();
    mapStateRef.current = null;
}

export function livePins() {
    return (mapStateRef.current && mapStateRef.current.pins) || [];
}

export function mapBounds() {
    const ms = mapStateRef.current;
    if (!ms || !ms.map) return null;
    try { return ms.map.getBounds(); } catch { return null; }
}

export function counts() { return mapCounts(livePins(), mapBounds()); }
export function queueRows() { return queueRowsFor(livePins(), mapBounds()); }

export function unresolvedSummaryText() {
    const parts = [];
    if (summary.unresolvedCount) parts.push(`Reports with no location (${summary.unresolvedCount})`);
    if (summary.truncated) parts.push(`Only ${summary.cap} of ${summary.totalConsidered} reports loaded`);
    return parts.join(' -- ');
}

export function unresolvedNoteText() {
    const parts = [];
    if (summary.unresolvedCount) parts.push('No GPS, and the location text did not match a known area, so these cannot be drawn on the map.');
    if (summary.truncated) parts.push('The rest are not loaded at all, so they are not on this screen and not in the list below.');
    return parts.join(' ');
}

const STALE_AFTER_MS = 3 * 60e3;

export function isStale() {
    return lastUpdatedAt != null && (Date.now() - lastUpdatedAt) > STALE_AFTER_MS;
}

let wasStale = false;
setInterval(() => {
    const now = isStale();
    if (now === wasStale) return;
    wasStale = now;
    schedule();
}, 30e3);

onConnectionRestored(() => { if (error) refresh(); });

onActiveIdChange((id) => {
    if (!mapStateRef.current) return;
    setSelectedCase(mapStateRef.current, id);
    if (id != null) focusCaseOnMap(mapStateRef.current, id);
});

onMobilePaneChange(() => {
    const ms = mapStateRef.current;
    if (!ms || !ms.map) return;
    let view;
    try { view = { center: ms.map.getCenter(), zoom: ms.map.getZoom() }; } catch { return; }
    const restore = () => {
        try {
            ms.map.invalidateSize({ animate: false });
            ms.map.setView(view.center, view.zoom, { animate: false });
        } catch {  }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(restore));
    else restore();
});

let lastUrgencySig = '';
onAttentionChange(() => {
    const sig = [...urgencyByCaseId().entries()].sort().map(([k, v]) => k + ':' + v).join(',');
    if (sig === lastUrgencySig) return;
    lastUrgencySig = sig;
    if (mapStateRef.current) refilterMarkers(mapStateRef.current, state.mapFilter);
});

export function clusterNoteFor(caseId) {
    const ms = mapStateRef.current;
    if (!ms) return null;
    const p = (ms.pins || []).find((x) => x.id === caseId);
    if (!p || p.cluster == null) return null;
    const info = ms.clusters ? ms.clusters[p.cluster] : null;
    if (!info || !(info.count > 1)) return null;
    return {
        others: info.count - 1,
        reportedDiseaseNames: (info.reported_disease_names || []).filter(Boolean),
    };
}

export function canDispatchFor(caseId) {
    return !!(mapStateRef.current && (mapStateRef.current.pins || []).some((p) => p.id === caseId));
}

export function dispatchWorkerFor(caseId) {
    const ms = mapStateRef.current;
    if (!ms) return;
    const p = (ms.pins || []).find((x) => x.id === caseId);
    return openDispatchPicker(ms, caseId, p ? p.lat : null, p ? p.lon : null);
}

export function mapDebugSnapshot() {
    const ms = mapStateRef.current;
    let bounds = null;
    try { bounds = ms && ms.map ? ms.map.getBounds().toBBoxString() : null; } catch { bounds = null; }
    const c = counts();
    return {
        homeView: state.homeView,
        activePanel: state.activePanel,
        railMode: state.railMode,
        mobilePane: state.mobilePane,
        hasActiveCase: state.activeId != null,
        mapMounted: !!ms,
        mapBounds: bounds,
        mapZoom: ms && ms.map ? ms.map.getZoom() : null,
        filter: { ...state.mapFilter },
        pinsLoaded: c.plotted,
        pinsVisible: c.visible,
        attentionTotal: c.attention,
        queueMatching: queueRows().length,
        queueShown: Math.min(queueShown, queueRows().length),
        unresolvedCount: summary.unresolvedCount || 0,
        truncated: !!summary.truncated,
        lastUpdatedAt,
        loadedOnce,
        error,
    };
}
