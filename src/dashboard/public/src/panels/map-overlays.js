import { setActiveId } from '../state.js';
import { LOCATION_SOURCE_LABEL } from '../map-model.js';
import { rel, NO_TIME_TEXT } from '../format.js';
import { countOf } from '../vocabulary.js';
import { fetchMapWorkers, fetchMapLastReports, fetchOperatorIdentities } from '../api.js';

function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || name;
}

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function renderClusterLines(mapState, filtered) {
    const { map } = mapState;
    if (mapState.clusterLines) { map.removeLayer(mapState.clusterLines); mapState.clusterLines = null; }
    if (!mapState.showClusters) return;
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

export async function renderMapCoverage(mapState) {
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
                .bindTooltip(esc(idOp.name) + ' -- ' + countOf(idOp.case_count, 'action', 'actions') + ' here')
                .addTo(layer);
        }
        layer.addTo(map);
        mapState.coverageLayer = layer;
    } catch (e) {  }
}

export async function renderMapWorkers(mapState) {
    const { map } = mapState;
    if (mapState.workersLayer) { map.removeLayer(mapState.workersLayer); mapState.workersLayer = null; }
    if (!mapState.showWorkers) return;
    try {
        const j = await fetchMapWorkers();
        if (!j) return;
        mapState.workers = j.workers || [];
        const layer = window.L.layerGroup();
        for (const w of (j.workers || [])) {
            const ageText = w.age_ms != null ? rel(Date.now() - w.age_ms) : null;
            const staleNote = w.stale
                ? (ageText ? ` (stale: ${ageText})` : ' (stale)')
                : (ageText ? ` (here now, ${ageText})` : ' (here now)');
            const overdueNote = w.overdue_checkin ? ' OVERDUE check-in' : '';
            const locSrc = w.location_source || 'unset';
            const srcNote = LOCATION_SOURCE_LABEL[locSrc] ? ` -- ${LOCATION_SOURCE_LABEL[locSrc]}` : '';
            const label = esc(w.display_name || 'field worker') + staleNote + overdueNote + srcNote;
            const color = w.overdue_checkin ? cssVar('--danger') : cssVar('--amber');
            const fillOpacity = w.overdue_checkin ? 0.8 : (w.stale ? 0.15 : 0.7);
            window.L.circleMarker([w.lat, w.lon], {
                radius: w.overdue_checkin ? 10 : 8, color, weight: 2, fillColor: color, fillOpacity,
                ...(locSrc === 'estimated' ? { dashArray: '4 3' } : {}),
            }).bindTooltip(label).addTo(layer);
        }
        layer.addTo(map);
        mapState.workersLayer = layer;
    } catch (e) {  }
}

export async function renderMapLastReports(mapState) {
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
            const when = rpt.last_report_at ? rel(Number(rpt.last_report_at) * 1000) : NO_TIME_TEXT;
            marker.bindTooltip(esc(rpt.location || '') + ' -- ' + when);
            marker.on('click', () => { if (rpt.case_id) setActiveId(rpt.case_id); });
            marker.addTo(layer);
        }
        layer.addTo(map);
        mapState.lastReportsLayer = layer;
    } catch (e) {  }
}
