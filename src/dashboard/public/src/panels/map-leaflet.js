// Imperative Leaflet driver -- NOT webjsx-rendered, per architecture spec
// section 1 ("Leaflet init logic ported as-is since Leaflet itself is not
// webjsx-rendered"). Ported byte-behavior-for-behavior from the legacy
// app.js: marker clustering, cluster-link overlay, coverage overlay, worker
// overlay, last-reports overlay, dispatch picker, popups.

import { setActiveId, setMapExtent } from '../state.js';
import { urgencyByCaseId, pinMatches } from '../map-model.js';
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

// Three independent channels on one pin, deliberately kept in three different
// visual dimensions so none of them has to compete for the same one:
//   fill colour     -> status        (new/triaging/in_progress/waiting/...)
//   border style    -> where the coordinate came from (gps vs the agent's own
//                      unconfirmed estimate)
//   size + ring     -> urgency, from attn.js's worst-first score
//
// Urgency is the channel this map was missing entirely. The rail ranked rows
// by score while the map coloured pins by status, so an operator reading a
// field of green dots could not tell which one was breaching -- the map
// answered "where is this happening" and had no answer at all for "which of
// these needs me now", which is the other half of the same question.
//
// It is encoded as SIZE and a RING, never as a fourth fill colour: fill is
// already spoken for, and size/geometry survive a colourblind viewer and both
// themes, where a hue-only severity ramp does not.
const URGENCY_SIZE = { 0: 14, 1: 14, 2: 18, 3: 22 };

function mapMarkerIcon(statusTok, locationSource, urgency, selected) {
    const u = urgency || 0;
    const size = URGENCY_SIZE[u] || 14;
    return window.L.divIcon({
        className: 'ds-map-marker-icon',
        html: `<div class="ds-map-marker-dot" data-status-token="${statusTok}"`
            + ` data-location-source="${locationSource || 'unset'}"`
            + ` data-urgency="${u}"${selected ? ' data-selected="1"' : ''}></div>`,
        iconSize: [size, size],
    });
}

// location_source -> a short, honest label for the popup/legend. 'unset' (a
// case predating this field) says nothing rather than implying a false
// certainty either way. Exported so map-panel.js's legend can document this
// visual channel (marker border treatment) the same way it already documents
// status color -- both are encoded on every pin but only status had a legend
// entry before.
export const LOCATION_SOURCE_LABEL = { gps: 'exact GPS', estimated: 'estimated, unconfirmed', confirmed: 'estimated, confirmed by worker' };

function mapPopupHtml(p, clusterInfo) {
    const counts = [p.affected_count != null ? p.affected_count + ' affected' : '', p.dead_count != null ? p.dead_count + ' dead' : ''].filter(Boolean).join(', ');
    const locSrcLabel = LOCATION_SOURCE_LABEL[p.location_source];
    // clusterInfo (mapState.clusters[p.cluster], from clusters.js buildClusters
    // via /api/map/cases) was already computed server-side and reached the
    // client, but nothing rendered it -- a clicked pin gave no hint it was
    // part of a wider, possibly-related group of reports (Ushahidi's
    // cluster-summary pattern: "what's going on here", not just a bare pin).
    const linkedNote = clusterInfo && clusterInfo.count > 1
        ? `<span title="Reports nearby that may be the same or a related situation">linked to ${clusterInfo.count - 1} other report(s)`
          + (clusterInfo.reported_disease_names && clusterInfo.reported_disease_names.length ? ': ' + esc(clusterInfo.reported_disease_names.join(', ')) : '')
          + '</span><br>'
        : '';
    return `<div><b>${esc(p.ref)}</b> <span class="ds-map-popup-status">${esc(p.status)}</span><br>`
        + (p.species ? esc(p.species) + '<br>' : '')
        + (p.case_type && p.case_type !== 'unset' ? esc(p.case_type) + '<br>' : '')
        + (p.location ? esc(p.location) + '<br>' : '')
        + (locSrcLabel ? `<span class="ds-map-popup-location-source" data-location-source="${esc(p.location_source)}" title="Where this map pin's coordinate came from">pin: ${esc(locSrcLabel)}</span><br>` : '')
        + (p.symptoms ? '<span title="As reported/observed">symptoms: ' + esc(p.symptoms) + '</span><br>' : '')
        + (counts ? esc(counts) + '<br>' : '')
        + (p.onset ? 'onset: ' + esc(p.onset) + '<br>' : '')
        + (p.assignee && p.assignee !== 'agent' ? 'assigned: ' + esc(p.assignee) + '<br>' : '')
        + linkedNote
        + `<a href="#" data-open-ref="${esc(p.id)}">Open case</a>`
        + ` | <a href="#" data-dispatch-ref="${esc(p.id)}" title="Suggest a field worker for this case -- never messages them directly, they hear about it on their own next reply-in">Dispatch a worker</a></div>`;
}

function renderMapMarkers(mapState, filters) {
    const { map } = mapState;
    if (mapState.markerLayer) map.removeLayer(mapState.markerLayer);
    if (mapState.clusterLines) map.removeLayer(mapState.clusterLines);
    // The SAME predicate the rail applies (map-model.js). Before this the two
    // filtered independently and could show different sets of the same cases.
    // The extent filter is deliberately not applied to the markers -- narrowing
    // the map to what is already on the map is a no-op, and it would fight the
    // operator's own pan; `inView` narrows the LIST only.
    const urgency = urgencyByCaseId();
    const filtered = mapState.pins.filter((p) => pinMatches(p, filters, urgency, null));
    const layer = window.L.markerClusterGroup({ maxClusterRadius: 40 });
    mapState.markerById = new Map();
    for (const p of filtered) {
        const u = urgency.get(p.id) || 0;
        const m = window.L.marker([p.lat, p.lon], {
            icon: mapMarkerIcon(STATUS_TOKEN[p.status] || '--fg-3', p.location_source, u, mapState.selectedId === p.id),
            // Worst-first has to survive marker overlap too: without this, a
            // breaching pin can be painted under a routine one that simply
            // happens to sit later in the list.
            zIndexOffset: u * 1000,
        });
        const clusterInfo = p.cluster != null ? mapState.clusters[p.cluster] : null;
        m.bindPopup(mapPopupHtml(p, clusterInfo));
        m.on('popupopen', () => {
            const el = document.querySelector(`[data-open-ref="${p.id}"]`);
            if (el) el.onclick = (e) => { e.preventDefault(); setActiveId(p.id); };
            const dEl = document.querySelector(`[data-dispatch-ref="${p.id}"]`);
            if (dEl) dEl.onclick = (e) => { e.preventDefault(); openDispatchPicker(mapState, p.id, p.lat, p.lon); };
        });
        mapState.markerById.set(p.id, m);
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
            markerById: new Map(), selectedId: null,
            pins: [], clusters: [], workers: [], showCoverage: false, showClusters: false, showWorkers: false, showLastReports: false,
        };
        // Publish the viewport so the rail can narrow to what is actually on
        // screen (mapuipatterns' extent-driven-content pattern). Without this
        // the map was a picture, not a control: an operator could zoom into one
        // district and still be reading a list covering the whole country.
        // Debounced -- moveend also fires at the end of every inertia glide, and
        // a re-render per frame of a drag is not free with 2000 pins.
        let extentTimer = null;
        const publishExtent = () => {
            if (extentTimer) clearTimeout(extentTimer);
            extentTimer = setTimeout(() => {
                try { setMapExtent(map.getBounds()); } catch { /* torn down mid-move */ }
            }, 150);
        };
        map.on('moveend', publishExtent);
        map.on('zoomend', publishExtent);
    }
    const mapState = mapStateRef.current;
    // Leaflet caches its container size and only recomputes on a WINDOW
    // resize. In this shell the canvas resizes without one -- the rail swaps
    // between the queue and a case detail, the pane's flex basis changes, the
    // phone breakpoint flips -- and a stale cached size renders as grey seams
    // where tiles were never requested. Observe the element itself.
    if (!mapState.sizeObserver && typeof ResizeObserver === 'function') {
        try {
            const el = mapState.map.getContainer();
            mapState.sizeObserver = new ResizeObserver((entries) => {
                const box = entries && entries[0] && entries[0].contentRect;
                const hidden = box && (box.width === 0 || box.height === 0);
                try {
                    if (hidden) {
                        // The phone's map/list toggle hides this pane with
                        // display:none, so the container really does go to
                        // 0x0. Calling invalidateSize against a zero box makes
                        // Leaflet recompute its centre from a degenerate
                        // rectangle -- measured live: switching map -> list ->
                        // map came back at a DIFFERENT centre and zoom, so the
                        // operator lost the district they had navigated to
                        // just by glancing at the list. Remember the real view
                        // instead and skip the resize entirely while hidden.
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
            });
            mapState.sizeObserver.observe(el);
        } catch { /* observation is an optimisation, never a hard requirement */ }
    }

    mapState.pins = j.pins || [];
    mapState.clusters = j.clusters || [];
    const species = [...new Set(mapState.pins.map((p) => p.species).filter(Boolean))].sort();
    const types = [...new Set(mapState.pins.map((p) => p.case_type).filter((t) => t && t !== 'unset'))].sort();
    const statuses = [...new Set(mapState.pins.map((p) => p.status))].sort();
    if (callbacks && callbacks.onOptions) callbacks.onOptions({ species, types, statuses });
    renderMapMarkers(mapState, filters);
    // Frame the map on the reports themselves, once, on first load. The
    // constructor's center/zoom above is a fixed [-28.5,25]@5 that shows most
    // of southern Africa regardless of where anything actually is -- measured
    // live, a dataset entirely inside South Africa opened centred over Angola
    // and Zambia, so the BLUF question ("what is going on where") needed a
    // manual pan and zoom before it could be answered at all.
    //
    // First load ONLY (didAutoFit), never on refilter/refresh: re-fitting on
    // every poll would yank the viewport out from under an operator who has
    // deliberately panned or zoomed somewhere. maxZoom keeps a single lone
    // report from slamming to street level, where surrounding context is lost.
    if (!mapState.didAutoFit) {
        const located = (mapState.pins || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
        if (located.length) {
            mapState.didAutoFit = true;
            const bounds = window.L.latLngBounds(located.map((p) => [p.lat, p.lon]));
            // Deferred a frame on purpose. loadMap runs in the same tick the
            // panel's webjsx pass mounts the overlays, so measuring them here
            // returns zero-size rects and overlayFitPadding silently degrades
            // to its 24px floor -- which is exactly the bug it exists to
            // prevent (witnessed: 2 of 6 pins fitted underneath the queue).
            // One rAF lets layout settle so the measurement is real.
            const fit = () => {
                // Resolve the shell from the map's OWN live container, never the
                // `canvas` captured above: a poll-driven webjsx re-render can
                // swap that element out between loadMap starting and this
                // callback running, and a detached node's closest() returns
                // null -- which silently degraded the padding to its floor and
                // fitted 2 of 6 pins underneath the queue.
                try { mapState.map.fitBounds(bounds, { maxZoom: 11, ...overlayFitPadding(mapState.map.getContainer()) }); }
                catch { /* a degenerate bounds box must never break the panel */ }
            };
            if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(fit)); else fit();
        }
    }
    if (callbacks && callbacks.onSummary) {
        callbacks.onSummary({
            unresolvedCount: j.unresolved_count || 0,
            unresolved: j.unresolved || [],
            truncated: j.truncated, cap: j.cap, totalConsidered: j.total_considered,
        });
    }
    return mapState;
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

// Move the map to one case, used when the attention queue (or any list) picks a
// report -- see map-panel.js's attentionFeed(). Cap the zoom: landing at max
// zoom on a rural point with no surrounding landmarks reads as a broken blank
// map, which is precisely the disorientation a low-computer-literacy operator
// cannot recover from. No-op when the case has no placeable location (the
// "no location yet" count on the strip), so the map simply stays put.
// Which pin is the case currently open in the rail. Before this there was no
// selected state at all: focusing moved the viewport and then nothing on the
// map said which of the pins now in front of you was the one you had opened.
//
// Repaints the two affected markers in place rather than re-rendering the
// layer -- a full re-render on every selection would rebuild up to 2000
// markers and collapse the marker-cluster groups the operator is looking at.
export function setSelectedCase(mapState, id) {
    if (!mapState) return;
    const prev = mapState.selectedId;
    if (prev === id) return;
    mapState.selectedId = id;
    for (const target of [prev, id]) {
        if (target == null) continue;
        const m = mapState.markerById && mapState.markerById.get(target);
        if (!m) continue;
        // getElement() is null while the marker is inside a collapsed cluster
        // or otherwise unrendered; the attribute is applied on its next render
        // from mapState.selectedId, so there is nothing to do here.
        const el = m.getElement && m.getElement();
        const dot = el && el.querySelector('.ds-map-marker-dot');
        if (!dot) continue;
        if (target === id) dot.setAttribute('data-selected', '1');
        else dot.removeAttribute('data-selected');
    }
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

export function toggleClusters(mapState, filters) { mapState.showClusters = !mapState.showClusters; renderMapMarkers(mapState, filters); }
export function refilterMarkers(mapState, filters) { renderMapMarkers(mapState, filters); }
export async function toggleCoverage(mapState) { mapState.showCoverage = !mapState.showCoverage; await renderMapCoverage(mapState); }
export async function toggleWorkers(mapState) { mapState.showWorkers = !mapState.showWorkers; await renderMapWorkers(mapState); }
export async function toggleLastReports(mapState) { mapState.showLastReports = !mapState.showLastReports; await renderMapLastReports(mapState); }
export { statusColor };
