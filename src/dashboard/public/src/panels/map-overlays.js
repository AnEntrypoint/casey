// RESPONSIBILITY: the four toggleable layers drawn beside the pins -- cluster
// links, operator coverage, field workers, last-reported places -- each one
// added and removed as a whole layer group.
//
// They are grouped because they behave identically and differ from the pins in
// the same way: every one is optional, off by default, owns exactly one
// mapState.<name>Layer, and answers a question ABOUT the pins rather than being
// one. Three of them fetch their own rows; all three are soft add-ons whose
// failure must never break the map, because a map with no coverage rings still
// answers the question the operator opened it for.

import { setActiveId } from '../state.js';
import { LOCATION_SOURCE_LABEL } from '../map-model.js';
import { fmtDur } from '../format.js';
import { fetchMapWorkers, fetchMapLastReports, fetchOperatorIdentities } from '../api.js';

// Reads a design-token value off the live document, so an overlay drawn into an
// SVG canvas (which cannot take a CSS variable) still lands on the theme's own
// palette in both themes.
function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || name;
}

// Tooltip text is the one place on the map where store-held, contact-adjacent
// text (a worker's display name, a place name) is interpolated into markup, so
// it is escaped here rather than trusted.
function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The lines between reports that look like the same event. The linkage
// itself (p.cluster, indexed by clusters.js buildClusters server-side and
// shipped in /api/map/cases) answers "what is going on HERE" rather than "what
// is this one pin" -- Ushahidi's cluster-summary pattern.
//
// Takes the ALREADY-FILTERED pin list rather than filtering again: a line drawn
// to a report the filter has hidden points at a pin that is not on the map.
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

// The areas each operator has actually been working in, ringed. Centred on the
// mean of the pins whose location text matches one of that operator's learned
// area tokens, so the ring follows the real reports rather than a stored
// polygon nobody maintains.
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
                .bindTooltip(esc(idOp.name) + ' -- ' + idOp.case_count + ' case action(s)')
                .addTo(layer);
        }
        layer.addTo(map);
        mapState.coverageLayer = layer;
    } catch (e) { /* coverage overlay is a soft add-on */ }
}

// Where field workers last checked in from.
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
            // No age recorded drops the clause rather than printing a bare
            // "unknown" where a time belongs.
            const ageText = w.age_ms != null ? fmtDur(w.age_ms) + ' ago' : null;
            const staleNote = w.stale
                ? (ageText ? ` (stale: ${ageText})` : ' (stale)')
                : (ageText ? ` (here now, ${ageText})` : ' (here now)');
            const overdueNote = w.overdue_checkin ? ' OVERDUE check-in' : '';
            // HOW this position was arrived at, on the pin itself. case_checkin's
            // own lat is documented as the worker's "best estimate for a described
            // place, or exact if they shared GPS", so this dot may be the model's
            // guess at a place name -- and it used to be drawn identically to a
            // real fix. A case pin already answers this through its border
            // treatment; a worker pin is an SVG circle, so the same distinction is
            // a dashed stroke. Only an unconfirmed estimate is dashed: gps and
            // worker-confirmed are solid, and 'unset' (a check-in predating this
            // field) stays solid rather than implying a precision claim either way.
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
    } catch (e) { /* worker-location overlay is a soft add-on */ }
}

// The last place each contact reported from.
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
            const when = rpt.last_report_at ? fmtDur(Date.now() - Number(rpt.last_report_at) * 1000) + ' ago' : 'unknown time';
            marker.bindTooltip(esc(rpt.location || '') + ' -- ' + when);
            marker.on('click', () => { if (rpt.case_id) setActiveId(rpt.case_id); });
            marker.addTo(layer);
        }
        layer.addTo(map);
        mapState.lastReportsLayer = layer;
    } catch (e) { /* last-reported-location overlay is a soft add-on */ }
}
