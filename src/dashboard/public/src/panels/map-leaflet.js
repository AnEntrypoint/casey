// Imperative Leaflet driver -- NOT webjsx-rendered, per architecture spec
// section 1 ("Leaflet init logic ported as-is since Leaflet itself is not
// webjsx-rendered"). Ported byte-behavior-for-behavior from the legacy
// app.js: marker clustering, cluster-link overlay, coverage overlay, worker
// overlay, last-reports overlay, dispatch picker, popups.

import { setActiveId } from '../state.js';
import { fmtDur } from '../format.js';
import { fetchMapCases, fetchMapWorkers, fetchMapLastReports, fetchOperatorIdentities } from '../api.js';
import { openDispatchPicker } from './dispatch-picker.js';

export const STATUS_TOKEN = { new: '--sky', triaging: '--amber', in_progress: '--green', waiting: '--purple-2', resolved: '--fg-3', closed: '--fg-3' };

function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || name;
}

function statusColor(status) {
    return cssVar(STATUS_TOKEN[status] || '--fg-3');
}

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function mapMarkerIcon(statusTok, locationSource) {
    // statusTok is the token name (e.g., '--sky', '--amber') from STATUS_TOKEN
    // Set it as a CSS variable on the marker div so CSS can use var(). Color
    // (status) stays the primary signal; location_source ('gps'/'estimated'/
    // 'confirmed'/'unset') is a secondary border treatment via a data
    // attribute (app.css), so an operator sees at a glance whether a pin is
    // a surveyed-exact position or still the agent's own unconfirmed guess,
    // without the two dimensions competing for the same fill color.
    return window.L.divIcon({
        className: 'ds-map-marker-icon',
        html: `<div class="ds-map-marker-dot" data-status-token="${statusTok}" data-location-source="${locationSource || 'unset'}"></div>`,
        iconSize: [14, 14],
    });
}

// location_source -> a short, honest label for the popup. 'unset' (a case
// predating this field) says nothing rather than implying a false certainty
// either way.
const LOCATION_SOURCE_LABEL = { gps: 'exact GPS', estimated: 'estimated, unconfirmed', confirmed: 'estimated, confirmed by worker' };

function mapPopupHtml(p) {
    const counts = [p.affected_count != null ? p.affected_count + ' affected' : '', p.dead_count != null ? p.dead_count + ' dead' : ''].filter(Boolean).join(', ');
    const locSrcLabel = LOCATION_SOURCE_LABEL[p.location_source];
    return `<div><b>${esc(p.ref)}</b> <span class="ds-map-popup-status">${esc(p.status)}</span><br>`
        + (p.species ? esc(p.species) + '<br>' : '')
        + (p.case_type && p.case_type !== 'unset' ? esc(p.case_type) + '<br>' : '')
        + (p.location ? esc(p.location) + '<br>' : '')
        + (locSrcLabel ? `<span class="ds-map-popup-location-source" data-location-source="${esc(p.location_source)}" title="Where this map pin's coordinate came from">pin: ${esc(locSrcLabel)}</span><br>` : '')
        + (p.symptoms ? '<span title="As reported/observed">symptoms: ' + esc(p.symptoms) + '</span><br>' : '')
        + (counts ? esc(counts) + '<br>' : '')
        + (p.onset ? 'onset: ' + esc(p.onset) + '<br>' : '')
        + (p.assignee && p.assignee !== 'agent' ? 'assigned: ' + esc(p.assignee) + '<br>' : '')
        + `<a href="#" data-open-ref="${esc(p.id)}">Open case</a>`
        + ` | <a href="#" data-dispatch-ref="${esc(p.id)}" title="Suggest a field worker for this case -- never messages them directly, they hear about it on their own next reply-in">Dispatch a worker</a></div>`;
}

function applyMapFilters(pins, filters) {
    const sp = filters.species || '', ty = filters.type || '', st = filters.status || '';
    return pins.filter((p) =>
        (!sp || String(p.species || '').toLowerCase().includes(sp.toLowerCase()))
        && (!ty || p.case_type === ty)
        && (!st || p.status === st));
}

function renderMapMarkers(mapState, filters) {
    const { map } = mapState;
    if (mapState.markerLayer) map.removeLayer(mapState.markerLayer);
    if (mapState.clusterLines) map.removeLayer(mapState.clusterLines);
    const filtered = applyMapFilters(mapState.pins, filters);
    const layer = window.L.markerClusterGroup({ maxClusterRadius: 40 });
    for (const p of filtered) {
        const m = window.L.marker([p.lat, p.lon], { icon: mapMarkerIcon(STATUS_TOKEN[p.status] || '--fg-3', p.location_source) });
        m.bindPopup(mapPopupHtml(p));
        m.on('popupopen', () => {
            const el = document.querySelector(`[data-open-ref="${p.id}"]`);
            if (el) el.onclick = (e) => { e.preventDefault(); setActiveId(p.id); };
            const dEl = document.querySelector(`[data-dispatch-ref="${p.id}"]`);
            if (dEl) dEl.onclick = (e) => { e.preventDefault(); openDispatchPicker(mapState, p.id, p.lat, p.lon); };
        });
        layer.addLayer(m);
    }
    map.addLayer(layer);
    mapState.markerLayer = layer;
    if (mapState.showClusters) {
        const lines = window.L.layerGroup();
        const byIdx = new Map();
        for (const p of filtered) { if (p.cluster == null) continue; if (!byIdx.has(p.cluster)) byIdx.set(p.cluster, []); byIdx.get(p.cluster).push(p); }
        for (const [, members] of byIdx) {
            if (members.length < 2) continue;
            for (let i = 1; i < members.length; i++) {
                window.L.polyline([[members[0].lat, members[0].lon], [members[i].lat, members[i].lon]], { color: cssVar('--danger'), weight: 1, opacity: .5, dashArray: '4,4' }).addTo(lines);
            }
        }
        lines.addTo(map);
        mapState.clusterLines = lines;
    }
}

async function renderMapCoverage(mapState) {
    const { map } = mapState;
    if (mapState.coverageLayer) { map.removeLayer(mapState.coverageLayer); mapState.coverageLayer = null; }
    if (!mapState.showCoverage) return;
    try {
        const j = await fetchOperatorIdentities();
        if (!j) return;
        const layer = window.L.layerGroup();
        for (const idOp of (j.identities || [])) {
            if (!idOp.areas || !idOp.areas.length) continue;
            const matched = mapState.pins.filter((p) => p.location && idOp.areas.some((a) => String(p.location).toLowerCase().includes(a.token)));
            if (!matched.length) continue;
            const lat = matched.reduce((s, p) => s + p.lat, 0) / matched.length;
            const lon = matched.reduce((s, p) => s + p.lon, 0) / matched.length;
            window.L.circle([lat, lon], { radius: 25000, color: cssVar('--accent'), weight: 1, fillOpacity: .06 })
                .bindTooltip(esc(idOp.name) + ' -- ' + idOp.case_count + ' case action(s)')
                .addTo(layer);
        }
        layer.addTo(map);
        mapState.coverageLayer = layer;
    } catch (e) { /* coverage overlay is a soft add-on */ }
}

async function renderMapWorkers(mapState) {
    const { map } = mapState;
    if (mapState.workersLayer) { map.removeLayer(mapState.workersLayer); mapState.workersLayer = null; }
    if (!mapState.showWorkers) return;
    try {
        const j = await fetchMapWorkers();
        if (!j) return;
        mapState.workers = j.workers || [];
        const layer = window.L.layerGroup();
        for (const w of (j.workers || [])) {
            const ageText = w.age_ms != null ? fmtDur(w.age_ms) + ' ago' : 'unknown';
            const staleNote = w.stale ? ` (stale: ${ageText})` : ` (here now, ${ageText})`;
            const overdueNote = w.overdue_checkin ? ' OVERDUE check-in' : '';
            const label = esc(w.display_name || 'field worker') + staleNote + overdueNote;
            const color = w.overdue_checkin ? cssVar('--danger') : cssVar('--amber');
            const fillOpacity = w.overdue_checkin ? 0.8 : (w.stale ? 0.15 : 0.7);
            window.L.circleMarker([w.lat, w.lon], { radius: w.overdue_checkin ? 10 : 8, color, weight: 2, fillColor: color, fillOpacity })
                .bindTooltip(label).addTo(layer);
        }
        layer.addTo(map);
        mapState.workersLayer = layer;
    } catch (e) { /* worker-location overlay is a soft add-on */ }
}

async function renderMapLastReports(mapState) {
    const { map } = mapState;
    if (mapState.lastReportsLayer) { map.removeLayer(mapState.lastReportsLayer); mapState.lastReportsLayer = null; }
    if (!mapState.showLastReports) return;
    try {
        const j = await fetchMapLastReports();
        if (!j) return;
        mapState.lastReports = j.reports || [];
        const layer = window.L.layerGroup();
        for (const rpt of (j.reports || [])) {
            const reportColor = cssVar('--green');
            const marker = window.L.circleMarker([rpt.lat, rpt.lon], { radius: 7, color: reportColor, weight: 2, fillColor: reportColor, fillOpacity: 0.55 });
            const when = rpt.last_report_at ? fmtDur(Date.now() - Number(rpt.last_report_at) * 1000) + ' ago' : 'unknown time';
            marker.bindTooltip(esc(rpt.location || '') + ' -- ' + when);
            marker.on('click', () => { if (rpt.case_id) setActiveId(rpt.case_id); });
            marker.addTo(layer);
        }
        layer.addTo(map);
        mapState.lastReportsLayer = layer;
    } catch (e) { /* last-reported-location overlay is a soft add-on */ }
}

// initMap -- creates (once) the Leaflet map bound to `canvas`, fetches pins,
// wires filter/overlay callbacks, and returns the live mapState. `filters`
// is a live-read object {species,type,status,days}; `onFiltersPopulated`
// is called once with the discovered species/type/status option lists so
// the webjsx chrome (map-panel.js) can render <Select> options.
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
    if (!j) { if (callbacks && callbacks.onError) callbacks.onError('Could not load the map.'); return mapStateRef.current; }
    if (!mapStateRef.current) {
        canvas.innerHTML = '';
        const map = window.L.map(canvas, { center: [-28.5, 25], zoom: 5 });
        window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '(c) OpenStreetMap contributors' }).addTo(map);
        mapStateRef.current = {
            map, markerLayer: null, clusterLines: null, coverageLayer: null, workersLayer: null, lastReportsLayer: null,
            pins: [], clusters: [], workers: [], showCoverage: false, showClusters: false, showWorkers: false, showLastReports: false,
        };
    }
    const mapState = mapStateRef.current;
    mapState.pins = j.pins || [];
    mapState.clusters = j.clusters || [];
    const species = [...new Set(mapState.pins.map((p) => p.species).filter(Boolean))].sort();
    const types = [...new Set(mapState.pins.map((p) => p.case_type).filter((t) => t && t !== 'unset'))].sort();
    const statuses = [...new Set(mapState.pins.map((p) => p.status))].sort();
    if (callbacks && callbacks.onOptions) callbacks.onOptions({ species, types, statuses });
    renderMapMarkers(mapState, filters);
    if (callbacks && callbacks.onSummary) {
        callbacks.onSummary({
            unresolvedCount: j.unresolved_count || 0,
            unresolved: j.unresolved || [],
            truncated: j.truncated, cap: j.cap, totalConsidered: j.total_considered,
        });
    }
    return mapState;
}

export function toggleClusters(mapState, filters) { mapState.showClusters = !mapState.showClusters; renderMapMarkers(mapState, filters); }
export function refilterMarkers(mapState, filters) { renderMapMarkers(mapState, filters); }
export async function toggleCoverage(mapState) { mapState.showCoverage = !mapState.showCoverage; await renderMapCoverage(mapState); }
export async function toggleWorkers(mapState) { mapState.showWorkers = !mapState.showWorkers; await renderMapWorkers(mapState); }
export async function toggleLastReports(mapState) { mapState.showLastReports = !mapState.showLastReports; await renderMapLastReports(mapState); }
export { statusColor };
