// Imperative Leaflet driver -- NOT webjsx-rendered, per architecture spec
// section 1 ("Leaflet init logic ported as-is since Leaflet itself is not
// webjsx-rendered"). Ported byte-behavior-for-behavior from the legacy
// app.js: marker clustering, cluster-link overlay, coverage overlay, worker
// overlay, last-reports overlay, dispatch picker, popups.

import { setActiveId, setMapExtent, schedule } from '../state.js';
import { urgencyByCaseId, pinMatches } from '../map-model.js';
import { fmtDur } from '../format.js';
import { fetchMapCases, fetchMapWorkers, fetchMapLastReports, fetchOperatorIdentities } from '../api.js';
import { openDispatchPicker } from './dispatch-picker.js';

// GREEN APPEARS ON EXACTLY ONE STATE, AND IT MEANS DONE.
//
// It used to mean `in_progress`, which put a green dot on an OPEN case: a fresh
// mass-mortality report (blue "new") read CALMER on the map than one somebody
// was already handling. On a disease-surveillance map green is the one colour
// an operator reads without thinking, and it was saying all-clear over an
// active outbreak. `resolved` and `closed` also both rendered `--fg-3`, so a
// genuinely-finished case was indistinguishable from an archived one and both
// were near-invisible against a grey basemap in dark mode.
//
// Every open state is now warm-or-cool but never green; the two terminal states
// are green (finished) and grey (archived).
//
// This is the safety half of a larger finding. Research across shipped
// situational-awareness consoles (HealthMap, Liveuamap, Palantir -- see
// .gm/research/osint-map-ui-brief.md) found that NONE of them spend the colour
// channel on workflow status at all: HealthMap gives colour to noteworthiness
// and size to geographic scope, Liveuamap gives colour to actor and ships a
// "show patterns instead of colours" toggle. Moving colour onto severity is
// tracked as its own row (colour-channel-carries-severity-not-status) because
// it needs a severity notion casey does not have yet; this commit only removes
// the false all-clear.
export const STATUS_TOKEN = {
    new: '--sky',
    triaging: '--amber',
    in_progress: '--purple-2',
    waiting: '--accent',
    resolved: '--green',
    closed: '--fg-3',
};

function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || name;
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

// Every value interpolated into this HTML string is constrained to a known set
// before it gets here, never merely escaped. statusTok is a STATUS_TOKEN lookup
// so it is one of five literals; urgency is a number this module computed; and
// location_source is whitelisted below rather than passed through, because it
// arrives from the store and an unrecognised value would otherwise be written
// straight into an attribute. Nothing on a pin is contact-authored text, and
// this keeps it that way by construction -- the CSS only matches the known
// values anyway, so an unknown one has no rendering to lose.
const LOCATION_SOURCE_VALUES = new Set(['gps', 'estimated', 'confirmed', 'unset']);

function mapMarkerIcon(statusTok, locationSource, urgency, selected) {
    const u = urgency || 0;
    const size = URGENCY_SIZE[u] || 14;
    const loc = LOCATION_SOURCE_VALUES.has(locationSource) ? locationSource : 'unset';
    const tok = Object.values(STATUS_TOKEN).includes(statusTok) ? statusTok : '--fg-3';
    return window.L.divIcon({
        className: 'ds-map-marker-icon',
        html: `<div class="ds-map-marker-dot" data-status-token="${tok}"`
            + ` data-location-source="${loc}"`
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
// Nothing the popup uniquely carried was dropped. Its descriptive fields
// (ref, status, species, type, location, provenance, symptoms, counts, onset,
// assignee) are all in the case detail the rail now shows on selection. Its
// two ACTIONS had no other entry point in the app at all, so both are
// re-homed rather than deleted, via the two accessors below:
// clusterNoteForCase and dispatchForCase, rendered by the case detail.

// The cluster linkage (mapState.clusters[p.cluster], computed server-side by
// clusters.js buildClusters and shipped in /api/map/cases) answers "what is
// going on HERE" rather than "what is this one pin" -- Ushahidi's
// cluster-summary pattern. It reached the client and, before the popup
// existed, nothing rendered it at all.
export function clusterNoteForCase(mapState, caseId) {
    if (!mapState) return null;
    const p = (mapState.pins || []).find((x) => x.id === caseId);
    if (!p || p.cluster == null) return null;
    const info = mapState.clusters ? mapState.clusters[p.cluster] : null;
    if (!info || !(info.count > 1)) return null;
    return {
        others: info.count - 1,
        // Named reportedDiseaseNames, not `diseases`. clusters.js exposes this
        // as reported_disease_names precisely so no view can render it as a
        // diagnosis, and shortening it here to `diseases` is how that
        // protection gets lost one hop later -- which is exactly what happened
        // to the case detail's linked-reports note, where the names arrived
        // bare after a colon and read as fact. The value is a name the worker
        // relayed from the farmer's own guess, never a lab result.
        reportedDiseaseNames: (info.reported_disease_names || []).filter(Boolean),
    };
}

// Resolves the case's own coordinate so the picker can rank workers by
// distance, exactly as the popup's link did. A case with no placeable
// coordinate still dispatches -- it just ranks unsorted rather than refusing,
// since "no GPS yet" is a routine state here, not an error.
export function dispatchForCase(mapState, caseId) {
    if (!mapState) return;
    const p = (mapState.pins || []).find((x) => x.id === caseId);
    return openDispatchPicker(mapState, caseId, p ? p.lat : null, p ? p.lon : null);
}

// What the rendered marker layer is a function of. Rebuilding the layer tears
// down and recreates every marker, which COLLAPSES the marker-cluster groups
// the operator is currently reading and drops their expansion state -- so a
// rebuild that would produce a pixel-identical result is not free, it is
// actively disruptive. Selection is deliberately absent: setSelectedCase
// repaints the two affected markers in place precisely so selecting does not
// cost a rebuild.
function markerSignature(mapState, filters, urgency) {
    const f = filters || {};
    return [f.species || '', f.type || '', f.status || '', f.band || '', mapState.showClusters ? 1 : 0]
        .concat((mapState.pins || []).map((p) => `${p.id}:${p.status}:${p.lat}:${p.lon}:${p.location_source}:${urgency.get(p.id) || 0}`))
        .join('|');
}

function renderMapMarkers(mapState, filters) {
    const { map } = mapState;
    // Computed before anything is torn down: this is what makes a periodic
    // refresh of the pins affordable at all. Without it, polling the map data
    // to keep a surveillance view current would collapse the operator's
    // clusters on every tick even when not one report had changed.
    const sig = markerSignature(mapState, filters, urgencyByCaseId());
    if (mapState.markerLayer && sig === mapState.markerSig) return;
    mapState.markerSig = sig;
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
            // Leaflet's own marker keyboard handling is left ON (the default):
            // it makes the marker focusable and fires this same click handler
            // on Enter, so a keyboard operator selects a pin the same way a
            // pointer does. Witnessed live: the icon element comes back with
            // role="button" and tabindex="0".
            //
            // `title` is set here rather than `alt` deliberately. Leaflet's
            // Marker._initIcon applies `alt` ONLY when the icon element is an
            // IMG; ours is a divIcon, so an `alt` option is silently dropped --
            // measured, not assumed (the first witness of this change came back
            // with alt null on a marker that did have role and tabindex).
            title: `${p.ref} -- ${p.status}`,
        });
        // The accessible NAME, set on the element Leaflet actually focuses.
        // Without it a screen reader announces eight identical "button"s and
        // the pin field is unusable non-visually -- role and tabindex alone
        // make a control reachable, not identifiable. Constrained values only,
        // same discipline as the icon attributes: ref and status are
        // store-owned enums/identifiers, never contact-authored text.
        m.on('add', () => {
            const el = m.getElement();
            if (el) el.setAttribute('aria-label', `Report ${p.ref}, ${p.status}`);
        });
        // Select, never pop up. This is the queue-row click and the pin click
        // converging on ONE publisher (state.setActiveId), which is also what
        // moves the map, marks the pin selected, and updates the URL -- see the
        // onActiveIdChange subscription in map-panel.js. Before this, a pin
        // click opened an overlay that covered the neighbouring pins and put a
        // second "Open case" click between the operator and the report.
        m.on('click', () => setActiveId(p.id));
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

// The option lists the rail's Select controls offer, taken from the pins that
// actually loaded rather than from a fixed vocabulary -- a filter that offers a
// species no report has is a control that can only ever empty the map.
function filterOptionsFrom(pins) {
    return {
        species: [...new Set(pins.map((p) => p.species).filter(Boolean))].sort(),
        types: [...new Set(pins.map((p) => p.case_type).filter((t) => t && t !== 'unset'))].sort(),
        statuses: [...new Set(pins.map((p) => p.status))].sort(),
    };
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

// Move the map to one case, used when the attention queue (or any list) picks a
// report -- see map-panel.js's onActiveIdChange subscription. Cap the zoom:
// landing at max zoom on a rural point with no surrounding landmarks reads as a
// broken blank map, which is precisely the disorientation a low-computer-
// literacy operator cannot recover from. No-op when the case has no placeable
// location (the "no location yet" count on the rail), so the map stays put.
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

export function toggleClusters(mapState, filters) { mapState.showClusters = !mapState.showClusters; renderMapMarkers(mapState, filters); }
export function refilterMarkers(mapState, filters) { renderMapMarkers(mapState, filters); }
export async function toggleCoverage(mapState) { mapState.showCoverage = !mapState.showCoverage; await renderMapCoverage(mapState); }
export async function toggleWorkers(mapState) { mapState.showWorkers = !mapState.showWorkers; await renderMapWorkers(mapState); }
export async function toggleLastReports(mapState) { mapState.showLastReports = !mapState.showLastReports; await renderMapLastReports(mapState); }
