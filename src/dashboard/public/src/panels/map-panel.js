// Map shell + the docked rail beside it.
//
// The canvas is the whole pane, and the ONLY things allowed to sit on it are
// the legend and an error alert. Everything else -- counts, the worst-first
// queue, filters, overlays, the no-location list -- is docked in the rail.
// That split is not a style preference: mapuipatterns' full-map page states
// outright that situational-awareness and safety domains must not cover
// potentially important data with floating panels, and the measurable version
// of the failure here was pins fitted underneath an opaque queue card -- on
// screen, but unreadable and unclickable.
//
// This file owns only the webjsx chrome; Leaflet is driven imperatively by
// map-leaflet.js. Two things it deliberately does NOT own any more:
//   - a second stacked "legacy" layout. There was a non-embedded branch here
//     rendering the same data as a scrolling page with its own back button and
//     a viewport-fraction canvas. It was not dead: main.js's own boot() routed
//     the map-first deployment straight into it, so the docked layout below
//     was never what a real uhh operator landed on. One map surface now.
//   - its own idea of which cases are urgent or which pass the filter. Both
//     derivations moved to map-model.js so the pins and the rows can no longer
//     disagree about the same case.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Select } from '/design/src/components/content/fields.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { Chip, Btn } from '/design/src/components/shell/atoms.js';
import {
    state, schedule, setActiveId, setMapFilter, clearMapFilter, setRailMode,
    onActiveIdChange, onAttentionChange, onMobilePaneChange,
} from '../state.js';
import { urgencyByCaseId, pinMatches, rowMatches, isToday, filterIsActive, URGENCY_BAND_LABEL } from '../map-model.js';
import {
    loadMap, toggleClusters, refilterMarkers, toggleCoverage, toggleWorkers, toggleLastReports, STATUS_TOKEN,
    focusCaseOnMap, setSelectedCase, LOCATION_SOURCE_LABEL,
} from './map-leaflet.js';
import { GeoPanel } from './geo-panel.js';
import { ClustersPanel } from './clusters-panel.js';

const h = webjsx.createElement;

const mapStateRef = { current: null };
let options = { species: [], types: [], statuses: [] };
let summary = { unresolvedCount: 0, unresolved: [], truncated: false, cap: 0, totalConsidered: 0 };
let error = null;
// Distinguishes "the request failed" from "it succeeded and there is genuinely
// nothing" -- rendering both as an empty map told the operator nothing about
// which had happened. Null until the first attempt resolves either way.
let loadedOnce = false;
let lastUpdatedAt = null;
// How many queue rows are shown. A silent slice(0,5) meant the rail head could
// read "14 need a person" above a list of 5, with nothing on screen explaining
// the gap -- on a triage queue in a disease-surveillance deployment, report 6
// being invisible is a safety problem, not a cosmetic one.
const QUEUE_PAGE = 8;
let queueShown = QUEUE_PAGE;

// One subscription, registered at module load: every path that opens a case --
// the queue, a pin popup, the unresolved list, the case list, keyboard Enter,
// a hash deep link -- goes through setActiveId, so all of them now move the
// map. Previously only the queue did, and the view stopped answering "where"
// on every other route into a case.
onActiveIdChange((id) => {
    if (!mapStateRef.current) return;
    setSelectedCase(mapStateRef.current, id);
    if (id != null) focusCaseOnMap(mapStateRef.current, id);
});

// The markers are imperative Leaflet objects, so unlike the rail they are not
// re-rendered by schedule(). They carry the urgency channel, which comes from
// the attention list, which arrives AFTER the first map load and then refreshes
// on its own 30s poll -- so without this the pins were built from an empty
// attention list and stayed at urgency 0 for the life of the page.
//
// Rebuild only when the urgency assignment actually changed. Rebuilding on
// every 30s poll would collapse the marker clusters and close a popup the
// operator has open, for a result identical to what is already on screen.
// The phone's map/list toggle hides the map pane with display:none, and a
// Leaflet map whose container goes to 0x0 and back does not reliably come back
// to the same view -- measured live, map -> list -> map returned at a different
// centre, so an operator lost the district they had navigated to just by
// glancing at the queue. Capture the view while the container is still real,
// restore it once layout has settled.
onMobilePaneChange(() => {
    const ms = mapStateRef.current;
    if (!ms || !ms.map) return;
    let view;
    try { view = { center: ms.map.getCenter(), zoom: ms.map.getZoom() }; } catch { return; }
    // Two frames: one for webjsx to apply the class, one for the browser to
    // finish layout, so invalidateSize measures the real box and not the
    // mid-transition one.
    const restore = () => {
        try {
            ms.map.invalidateSize({ animate: false });
            ms.map.setView(view.center, view.zoom, { animate: false });
        } catch { /* pane torn down mid-toggle */ }
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

// Collapses overlapping loads into one. Measured live on a real boot: the map
// payload was fetched THREE times before the page settled, because several
// renders land in quick succession during boot, each one can hand
// onMountCanvas a fresh canvas element, and each of those called refresh().
// On the rural link this deployment targets, paying for the same payload three
// times before the operator sees anything is not a rounding error.
let inFlight = false;
function refresh() {
    if (inFlight) return;
    inFlight = true;
    error = null;
    // finally, not a callback: loadMap returns early without calling ANY
    // callback when the canvas element is not in the DOM yet, and clearing the
    // flag only from onSummary/onError would latch it true forever on that
    // path -- the map would then never load again for the life of the page.
    loadMap(mapStateRef, document.getElementById('ds-map-canvas'), state.mapFilter, state.mapFilter.days, {
        onOptions: (o) => { options = o; schedule(); },
        onSummary: (s) => { summary = s; loadedOnce = true; lastUpdatedAt = Date.now(); schedule(); },
        onError: (msg) => { error = msg; loadedOnce = true; schedule(); },
    }).finally(() => { inFlight = false; });
}

function agoText(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 10) return 'just now';
    if (s < 60) return s + 's ago';
    const m = Math.round(s / 60);
    return m < 60 ? m + 'm ago' : Math.round(m / 60) + 'h ago';
}

function livePins() {
    return (mapStateRef.current && mapStateRef.current.pins) || [];
}

function pinsById() {
    const m = new Map();
    for (const p of livePins()) m.set(p.id, p);
    return m;
}

function currentExtent() {
    const ms = mapStateRef.current;
    if (!ms || !ms.map || !state.mapFilter.inView) return null;
    try { return ms.map.getBounds(); } catch { return null; }
}

// ---- rail head ----------------------------------------------------------

// The time window is the control that changes what the map MEANS -- an
// all-time view of a surveillance map buries a live outbreak under two years
// of closed reports -- so it is always visible, never behind a disclosure. It
// is also the only filter that refetches from the server; the rest narrow what
// is already loaded, which is why it is not grouped with them.
function timeControl() {
    const opts = [{ v: '0', label: 'All time' }, { v: '7', label: 'This week' }, { v: '30', label: 'This month' }];
    return h('div', { class: 'ds-seg', role: 'group', 'aria-label': 'Time window' },
        ...opts.map((o) => h('button', {
            key: o.v, type: 'button', class: 'ds-seg-btn' + (state.mapFilter.days === o.v ? ' is-on' : ''),
            'aria-pressed': state.mapFilter.days === o.v ? 'true' : 'false',
            onclick: () => { if (state.mapFilter.days === o.v) return; setMapFilter({ days: o.v }); refresh(); },
        }, o.label)));
}

// At most three, and every one of them DOES something. The previous version
// rendered four .ds-stat-card tiles stating numbers you could not act on --
// "Needs attention 3" with the subtitle "see below", which is the opposite of
// bottom-line-up-front: it told the operator the answer was somewhere else.
// The number is the filter, so clicking it applies the filter, to the map and
// the rail together (one predicate in map-model.js, never two).
function filterChips() {
    const pins = livePins();
    const attentionCount = (state.attention || []).length;
    const newToday = pins.filter((p) => isToday(p.created_at)).length;
    const ex = currentExtent();
    const inViewCount = (() => {
        const ms = mapStateRef.current;
        if (!ms || !ms.map) return null;
        try {
            const b = ms.map.getBounds();
            return pins.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && b.contains([p.lat, p.lon])).length;
        } catch { return null; }
    })();

    const chip = (key, label, count, on, onClick, title) => h('button', {
        key, type: 'button', title,
        class: 'ds-fchip' + (on ? ' is-on' : '') + (count === 0 ? ' is-empty' : ''),
        'aria-pressed': on ? 'true' : 'false',
        onclick: onClick,
    }, h('span', { class: 'ds-fchip-n' }, String(count)), h('span', { class: 'ds-fchip-l' }, label));

    const f = state.mapFilter;
    return h('div', { class: 'ds-fchips' },
        chip('attn', 'need a person', attentionCount, f.band === 'attention',
            () => { setMapFilter({ band: f.band === 'attention' ? null : 'attention' }); applyFilterToMap(); },
            'Show only the reports the guardrails are chasing'),
        chip('today', 'new today', newToday, f.band === 'today',
            () => { setMapFilter({ band: f.band === 'today' ? null : 'today' }); applyFilterToMap(); },
            'Show only reports that came in today'),
        // Extent narrowing is offered as a chip rather than applied silently on
        // every pan: a list that quietly changes under an operator who was only
        // moving the map is a filter they cannot see and cannot undo.
        inViewCount == null ? null : chip('view', 'in this view', inViewCount, f.inView,
            () => { setMapFilter({ inView: !f.inView }); applyFilterToMap(); },
            'Narrow the list to the part of the map you are looking at'),
        filterIsActive(f)
            ? h('button', { key: 'clr', type: 'button', class: 'ds-fchip-clear', onclick: () => { clearMapFilter(); applyFilterToMap(); } }, 'Clear')
            : null,
        ex ? null : null);
}

function applyFilterToMap() {
    if (mapStateRef.current) refilterMarkers(mapStateRef.current, state.mapFilter);
    schedule();
}

// ---- rail body ----------------------------------------------------------

// Exported so keyboard triage walks the list the operator is actually looking
// at. j/k were wired to state.allCases unconditionally, which was correct when
// the case list was home and wrong the moment the map became home: the keys
// walked a list that was not on screen.
export function visibleQueueRows() { return queueRows(); }

function queueRows() {
    const urgency = urgencyByCaseId();
    const byId = pinsById();
    const ex = currentExtent();
    return (state.attention || []).filter((c) => rowMatches(c, byId, state.mapFilter, urgency, ex));
}

function attentionFeed() {
    const all = queueRows();
    if (!all.length) {
        const why = filterIsActive(state.mapFilter)
            ? 'No reports match the filters you have on. Clear them to see the rest.'
            : 'Nothing needs attention right now.';
        return h('div', { class: 'triage' }, h('div', { class: 'calm' }, why));
    }
    const rows = all.slice(0, queueShown);
    const urgency = urgencyByCaseId();
    const pick = (id) => setActiveId(id);
    return h('div', { class: 'ds-map-attention-feed' },
        ...rows.map((c) => {
            const band = urgency.get(c.id) || 1;
            return h('div', {
                key: c.id, class: 'tcase heat-' + band + (state.activeId === c.id ? ' active' : ''),
                onclick: () => pick(c.id),
                role: 'button', tabindex: '0',
                'aria-label': `${c.ref}: ${URGENCY_BAND_LABEL[band] || ''}`,
                onkeydown: (e) => {
                    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); pick(c.id); }
                },
            },
                h('div', { class: 'tcase-why' }, h('b', {}, c.ref), ' ', c.reason || ''),
                h('div', { class: 'tcase-meta' }, c.subject || ''));
        }),
        // The count is stated on the list itself, next to the control that
        // reveals the rest -- so a capped list can never silently disagree with
        // the chip above it again.
        all.length > rows.length
            ? h('button', {
                key: 'more', type: 'button', class: 'ds-queue-more',
                onclick: () => { queueShown = all.length; schedule(); },
            }, `Show all ${all.length}`)
            : (queueShown > QUEUE_PAGE && all.length > QUEUE_PAGE
                ? h('button', {
                    key: 'less', type: 'button', class: 'ds-queue-more',
                    onclick: () => { queueShown = QUEUE_PAGE; schedule(); },
                }, 'Show fewer')
                : null));
}

function mapFilterRow() {
    const f = state.mapFilter;
    return h('div', { class: 'ds-map-filters' },
        Select({
            key: 'sp', placeholder: 'all species', value: f.species,
            options: options.species, onChange: (v) => { setMapFilter({ species: v }); applyFilterToMap(); },
        }),
        Select({
            key: 'ty', placeholder: 'all types', value: f.type,
            options: options.types, onChange: (v) => { setMapFilter({ type: v }); applyFilterToMap(); },
        }),
        Select({
            key: 'st', placeholder: 'all statuses', value: f.status,
            options: options.statuses, onChange: (v) => { setMapFilter({ status: v }); applyFilterToMap(); },
        }));
}

function mapOverlayRow() {
    const ms = mapStateRef.current;
    const tog = (key, label, on, onClick) => Chip({
        key, tone: on ? 'accent' : '',
        children: h('button', { type: 'button', class: 'ds-chip-btn', 'aria-pressed': on ? 'true' : 'false', onclick: onClick }, label),
    });
    return h('div', { class: 'ds-map-overlays' },
        tog('cl', 'Clusters', !!(ms && ms.showClusters), () => { toggleClusters(ms, state.mapFilter); schedule(); }),
        tog('cov', 'Coverage', !!(ms && ms.showCoverage), async () => { await toggleCoverage(ms); schedule(); }),
        tog('wk', 'Workers', !!(ms && ms.showWorkers), async () => { await toggleWorkers(ms); schedule(); }),
        tog('lr', 'Last reported', !!(ms && ms.showLastReports), async () => { await toggleLastReports(ms); schedule(); }));
}

function mapUnresolvedNoteText() {
    return summary.unresolvedCount
        ? `${summary.unresolvedCount} report(s) have no placeable location yet (no GPS, and the location text did not match a known area) -- they are not shown on the map.`
          + (summary.truncated ? ` Showing the most recent ${summary.cap} of ${summary.totalConsidered} considered.` : '')
        : (summary.truncated ? `Showing the most recent ${summary.cap} of ${summary.totalConsidered} considered.` : '');
}

function mapUnresolvedList() {
    return h('div', { class: 'ds-map-unresolved-list' }, ...(summary.unresolved || []).map((p, i) =>
        h('div', {
            key: i, class: 'ds-map-unresolved-row', role: 'button', tabindex: '0',
            onclick: () => setActiveId(p.id),
            onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveId(p.id); } },
        },
            h('b', {}, p.ref),
            ' ', h('span', { class: 'ds-muted' }, p.status),
            p.species ? ' -- ' + p.species : '',
            p.location ? ` (${p.location})` : '',
            p.symptoms ? ' -- ' + p.symptoms : '')));
}

// Collapsed, never dropped: a report with no placeable coordinate is a
// surveillance blind spot, not noise, so it stays one labelled click away with
// its count on the summary line. It is also deliberately NOT reachable by the
// "in this view" chip -- a case with no position is not outside the viewport,
// it is nowhere, and a spatial filter must not be what makes it disappear.
function mapUnresolvedDisclosure() {
    if (!summary.unresolvedCount && !summary.truncated) return [];
    return [h('details', { class: 'ds-rail-disclosure' },
        h('summary', {}, `Reports with no location (${summary.unresolvedCount || 0})`),
        h('div', { class: 'ds-rail-disclosure-body' },
            h('div', { class: 'ds-map-unresolved-note' }, mapUnresolvedNoteText()),
            mapUnresolvedList()))];
}

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

function mapCanvas() {
    // A stable key so webjsx PRESERVES this node across the poll-driven
    // re-renders instead of replacing it. Without one, every re-render handed
    // onMountCanvas a brand-new element, which tore down the Leaflet instance
    // and rebuilt it -- refetching tiles and losing the operator's viewport.
    // The live-container guard in onMountCanvas stays as the backstop for the
    // genuine remount case (switching home views and back).
    const canvas = h('div', { id: 'ds-map-canvas', class: 'ds-map-canvas', key: 'ds-map-canvas' });
    // webjsx has no ref callback; onMountCanvas is idempotent (it guards on the
    // LIVE Leaflet container), so calling it every render is safe.
    queueMicrotask(() => onMountCanvas(document.getElementById('ds-map-canvas')));
    return canvas;
}

// The canvas div carries no webjsx `key`, so every re-render (a background
// poll's schedule(), not just a genuine remount) replaces it with a FRESH DOM
// node. Guard on the LIVE element: Leaflet's own map.getContainer() names which
// DOM node it is actually bound to, so a canvas swap is detected and re-mounted
// while the SAME persisted element across a no-op re-render is left alone. A
// one-shot `mounted` boolean (an earlier version) latched on first render and
// the map vanished within one poll interval.
function onMountCanvas(el) {
    if (!el) return;
    if (mapStateRef.current && mapStateRef.current.map.getContainer() === el) return;
    if (mapStateRef.current) {
        try { mapStateRef.current.sizeObserver?.disconnect(); } catch { /* already gone */ }
        mapStateRef.current.map.remove(); mapStateRef.current = null;
    }
    refresh();
}

// A tile failure and a data failure look identical on screen -- pins on grey,
// or nothing on grey -- so say which happened. The distinction matters on a
// rural link, where the tiles are the thing most likely to be unreachable
// while the API is fine.
function mapStateNote() {
    if (error) return { kind: 'error', text: error };
    if (!loadedOnce) return null;
    const pins = livePins();
    if (!pins.length) {
        return summary.unresolvedCount
            ? { kind: 'info', text: `Nothing can be placed on the map yet -- all ${summary.unresolvedCount} report(s) are missing a usable location. They are listed below.` }
            : { kind: 'info', text: 'No reports in this time window yet.' };
    }
    const visible = pins.filter((p) => pinMatches(p, state.mapFilter, urgencyByCaseId(), currentExtent()));
    if (!visible.length) return { kind: 'info', text: 'No reports match the filters you have on.' };
    return null;
}

export function MapPanel() {
    const note = mapStateNote();
    return h('div', { class: 'ds-map-shell' },
        mapCanvas(),
        h('div', { class: 'ds-map-chrome' }, mapLegend()),
        note
            ? h('div', { class: 'ds-map-overlay-error', role: note.kind === 'error' ? 'alert' : 'status' },
                Alert({ kind: note.kind, children: note.text }))
            : null);
}

// ---- the rail -----------------------------------------------------------

// The rail's contents when no case is open. Rendered by
// views/map-command-center.js into the SAME pane CaseDetailView uses, so the
// queue and the case detail are one rail with push-navigation rather than two
// columns competing for width -- at 1366px a third docked column left the map
// under 400px.
//
// railMode is how the two spatial rollups (Hotspots, Related reports) are
// reached now. They used to be full-page swaps that unmounted the map to show
// a table -- answering a "where" question by removing the only thing that can
// show where. Here the table sits in the rail and the map stays put beside it,
// with the matching map overlay switched on so the two agree.
const RAIL_MODES = {
    queue: { label: 'Needs a person', body: attentionFeed },
    clusters: { label: 'Related reports', body: () => ClustersPanel({ railed: true }) },
    geo: { label: 'Hotspots', body: () => GeoPanel({ railed: true }) },
};

function railModeTabs() {
    if (state.railMode === 'queue') return null;
    return h('div', { class: 'ds-rail-back' },
        Btn({
            variant: 'ghost',
            children: 'Back to the queue',
            onClick: () => { setRailMode('queue'); },
        }));
}

export function MapRail() {
    const mode = RAIL_MODES[state.railMode] || RAIL_MODES.queue;
    const lastUpdatedNote = lastUpdatedAt
        ? h('div', { class: 'ds-map-updated' }, 'Updated ' + agoText(lastUpdatedAt))
        : null;
    return h('div', { class: 'ds-map-rail' },
        h('div', { class: 'ds-rail-head' },
            h('div', { class: 'ds-rail-head-top' },
                h('h2', { class: 'ds-rail-title' }, mode.label),
                lastUpdatedNote),
            timeControl(),
            filterChips()),
        railModeTabs(),
        h('div', { class: 'ds-rail-body' },
            mode.body(),
            h('details', { class: 'ds-rail-disclosure' },
                h('summary', {}, 'Map options'),
                h('div', { class: 'ds-rail-disclosure-body' }, mapFilterRow(), mapOverlayRow())),
            ...mapUnresolvedDisclosure()));
}

// Read-only snapshot for diagnosing the class of bug this whole restructure
// fixes: the two halves of the view disagreeing about the same cases. Carries
// counts and view state only -- never a ref, subject, contact id or any other
// contact-supplied text, matching the PII-free-projection discipline every
// other operator-facing projection in casey follows.
export function mapDebugSnapshot() {
    const ms = mapStateRef.current;
    let bounds = null;
    try { bounds = ms && ms.map ? ms.map.getBounds().toBBoxString() : null; } catch { bounds = null; }
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
        pinsLoaded: livePins().length,
        pinsVisible: livePins().filter((p) => pinMatches(p, state.mapFilter, urgencyByCaseId(), currentExtent())).length,
        attentionTotal: (state.attention || []).length,
        queueMatching: queueRows().length,
        queueShown: Math.min(queueShown, queueRows().length),
        unresolvedCount: summary.unresolvedCount || 0,
        truncated: !!summary.truncated,
        lastUpdatedAt,
        loadedOnce,
        error,
    };
}
