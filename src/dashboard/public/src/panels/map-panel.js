// Map shell + the docked rail beside it.
//
// The canvas is the whole pane, and the ONLY things allowed to sit on it are
// the legend and an error alert. Everything else -- counts, the worst-first
// queue, filters, overlays, the no-location list -- is docked in the rail.
// The pane also carries the map's heading and its text equivalent, both
// `sr-only`: they occupy no space and cover no pin, and they are what the
// canvas is named and described by for a reader who cannot see it.
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
import { urgencyByCaseId, pinMatches, rowMatches, isToday, filterIsActive, URGENCY_BAND_LABEL, QUEUE_NAME } from '../map-model.js';
import {
    loadMap, toggleClusters, refilterMarkers, toggleCoverage, toggleWorkers, toggleLastReports, STATUS_TOKEN,
    focusCaseOnMap, setSelectedCase, resetMapView, LOCATION_SOURCE_LABEL,
    clusterNoteForCase, dispatchForCase,
} from './map-leaflet.js';
import { GeoPanel } from './geo-panel.js';
import { ClustersPanel } from './clusters-panel.js';
// One definition of the counted filter chip, shared with the case-list home
// view. Both surfaces render the same control and it must not be able to drift
// on one of them -- the same rule map-model.js enforces for the derivations
// these chips apply.
import { FilterChip, ClearChip } from '../components/filter-chip.js';

const h = webjsx.createElement;

const mapStateRef = { current: null };
let options = { species: [], types: [], statuses: [] };
let summary = { unresolvedCount: 0, unresolved: [], truncated: false, cap: 0, totalConsidered: 0 };
let error = null;
// Distinguishes "the request failed" from "it succeeded and there is genuinely
// nothing" -- rendering both as an empty map told the operator nothing about
// which had happened. False until the first attempt resolves either way.
let loadedOnce = false;
let lastUpdatedAt = null;
// How many queue rows are shown. A silent slice(0,5) meant the rail head could
// read "14 need a person" above a list of 5, with nothing on screen explaining
// the gap -- on a triage queue in a disease-surveillance deployment, report 6
// being invisible is a safety problem, not a cosmetic one.
const QUEUE_PAGE = 8;

// ONE name for the worst-first queue, everywhere it is referred to by name.
// It was called four different things across the UI plus a fifth in
// onboarding ("Needs a person", "Needs a person now", "Needs you now", "the
// inbox", "the queue"), which is five things for an operator to learn about
// one list. map-model.js imports this too, so the band label and the rail
// head can never drift apart again.
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

// The map's own pins were the ONE thing on this dashboard never refreshed.
// /api/map/cases was fetched once by loadMap() and never again, so on a
// surveillance map that is now the landing view, the pins were as old as the
// operator's login -- while a case list the map view does not even read was
// re-fetched every 5 seconds. A new report could sit unplotted for a whole
// shift. Exported so main.js can poll it only while the map is actually on
// screen; the marker-signature guard in map-leaflet.js is what makes a
// repeated call cheap, and the inFlight guard below still collapses overlaps.
export function refreshMapData() {
    refresh();
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
    return h('div', { class: 'ds-rail-controls' },
        h('div', { class: 'ds-seg', role: 'group', 'aria-label': 'Time window' },
            ...opts.map((o) => h('button', {
                key: o.v, type: 'button', class: 'ds-seg-btn' + (state.mapFilter.days === o.v ? ' is-on' : ''),
                'aria-pressed': state.mapFilter.days === o.v ? 'true' : 'false',
                onclick: () => { if (state.mapFilter.days === o.v) return; setMapFilter({ days: o.v }); refresh(); },
            }, o.label))),
        // In the rail, not on the canvas: only the legend and the state note are
        // allowed to sit over the map. An operator who has zoomed into one
        // district previously had no way back to the whole picture except a page
        // reload, which re-buys the map payload and every tile.
        h('button', {
            key: 'reset', type: 'button', class: 'ds-rail-reset',
            title: 'Move the map back to show every report',
            onclick: () => { resetMapView(mapStateRef.current); },
        }, 'Show all'));
}

// At most three, and every one of them DOES something. The previous version
// rendered four .ds-stat-card tiles stating numbers you could not act on --
// "Needs attention 3" with the subtitle "see below", which is the opposite of
// bottom-line-up-front: it told the operator the answer was somewhere else.
// The number is the filter, so clicking it applies the filter, to the map and
// the rail together (one predicate in map-model.js, never two).
function filterChips() {
    const { attention: attentionCount, today: newToday, inView: inViewCount } = mapCounts();

    const chip = (key, label, count, on, onClick, title) => FilterChip({ key, label, count, on, onClick, title });

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
            ? ClearChip({ onClick: () => { clearMapFilter(); applyFilterToMap(); } })
            : null);
}

function applyFilterToMap() {
    if (mapStateRef.current) refilterMarkers(mapStateRef.current, state.mapFilter);
    schedule();
}

// ---- the counts, derived once -------------------------------------------

// Every number this panel states -- on a chip, in the map's spoken text
// equivalent, in the state note, in the debug snapshot -- is counted here, in
// one place, over map-model.js's shared predicate and shared urgency ladder.
// The chips and the text equivalent are two renderings of the same screen for
// two different readers, so a second count for either is the same defect as a
// second copy of the predicate: the map and the words about it would be able
// to disagree.
function mapCounts() {
    const pins = livePins();
    const urgency = urgencyByCaseId();
    const extent = currentExtent();
    const visible = pins.filter((p) => pinMatches(p, state.mapFilter, urgency, extent));
    const ms = mapStateRef.current;
    let inView = null;
    if (ms && ms.map) {
        try {
            const b = ms.map.getBounds();
            inView = pins.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && b.contains([p.lat, p.lon])).length;
        } catch { inView = null; }
    }
    // Band 0 is a real answer, not a gap: a pin absent from the attention list
    // is one nothing is chasing (map-model.js), so it is counted and named
    // rather than silently missing from the urgency breakdown.
    const bands = { 3: 0, 2: 0, 1: 0, 0: 0 };
    for (const p of visible) bands[urgency.get(p.id) || 0] += 1;
    return {
        plotted: pins.length,
        visible: visible.length,
        inView,
        bands,
        attention: (state.attention || []).length,
        today: pins.filter((p) => isToday(p.created_at)).length,
    };
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
                // The report is the row. Its subject leads, at the row's
                // largest type; the ref and the ranking reason are what is
                // said ABOUT it and sit under it. Led the other way round,
                // six of eight rows opened with the identical sentence
                // ("A new message came in.") and the one line that told them
                // apart rendered at the smallest size on the page.
                h('div', { class: 'tcase-why' }, c.subject || c.ref),
                h('div', { class: 'tcase-meta' }, c.ref),
                c.reason ? h('div', { class: 'tcase-reason' }, c.reason) : null);
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

// Each toggle says what it will draw. The four labels are the overlay's name,
// which is what an operator who already knows the map reads at a glance -- but
// "Coverage" and "Clusters" name nothing recognisable to the secretarial and
// AHT staff this deployment is for, and unlike the filter chips beside them
// these four shipped with no explanatory title at all. The title is the
// sentence; the label stays short.
function mapOverlayRow() {
    const ms = mapStateRef.current;
    const tog = (key, label, title, on, onClick) => Chip({
        key, tone: on ? 'accent' : '',
        children: h('button', {
            type: 'button', class: 'ds-chip-btn', title,
            'aria-pressed': on ? 'true' : 'false', onclick: onClick,
        }, label),
    });
    return h('div', { class: 'ds-map-overlays' },
        tog('cl', 'Clusters', 'Draw a line between reports that look like the same outbreak',
            !!(ms && ms.showClusters), () => { toggleClusters(ms, state.mapFilter); schedule(); }),
        tog('cov', 'Coverage', 'Ring the areas each operator has been working in',
            !!(ms && ms.showCoverage), async () => { await toggleCoverage(ms); schedule(); }),
        tog('wk', 'Workers', 'Show where field workers last checked in from',
            !!(ms && ms.showWorkers), async () => { await toggleWorkers(ms); schedule(); }),
        tog('lr', 'Last reported', 'Show the last place each contact reported from',
            !!(ms && ms.showLastReports), async () => { await toggleLastReports(ms); schedule(); }));
}

// The COLLAPSED line is the only thing on screen while this disclosure is
// shut, so every fact that must not be silent has to be in it. It used to
// carry the no-location count alone, which meant a capped load with no
// no-location reports rendered "Reports with no location (0)" -- an operator
// reads that zero and never opens it, and the cap statement sitting inside
// was never seen. A cap is stated with its true total beside it or it is not
// stated, and that is a safety property here, not a cosmetic one.
function mapUnresolvedSummaryText() {
    const parts = [];
    if (summary.unresolvedCount) parts.push(`Reports with no location (${summary.unresolvedCount})`);
    if (summary.truncated) parts.push(`Only ${summary.cap} of ${summary.totalConsidered} reports loaded`);
    return parts.join(' -- ');
}

// The expanded body says WHY each of those two facts is true. It no longer
// repeats the counts the summary above it already states.
function mapUnresolvedNoteText() {
    const parts = [];
    if (summary.unresolvedCount) parts.push('No GPS, and the location text did not match a known area, so these cannot be drawn on the map.');
    if (summary.truncated) parts.push('The rest are not loaded at all, so they are not on this screen and not in the list below.');
    return parts.join(' ');
}

function mapUnresolvedList() {
    return h('div', { class: 'ds-map-unresolved-list' }, ...(summary.unresolved || []).map((p, i) =>
        h('div', {
            key: i, class: 'ds-map-unresolved-row', role: 'button', tabindex: '0',
            onclick: () => setActiveId(p.id),
            onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveId(p.id); } },
        },
            h('b', {}, p.ref),
            // Same humanisation the legend on this screen already applies to
            // the identical values -- a stage never reaches the operator as
            // its stored snake_case key.
            ' ', h('span', { class: 'ds-muted' }, String(p.status || '').replace(/_/g, ' ')),
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
        h('summary', {}, mapUnresolvedSummaryText()),
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
//
// Ordered by what the operator most needs to know, and only ever ONE note,
// because the canvas is allowed exactly two occupants (this and the legend)
// and a stack of alerts over a situational-awareness map is the floating-panel
// anti-pattern this layout exists to avoid. A data failure outranks an empty
// result, which outranks a missing backdrop -- a basemap outage is the least
// harmful of the three because every report is still plotted and still
// clickable on top of the grey.
function mapStateNote() {
    if (error) return { kind: 'error', text: error };
    if (!loadedOnce) return null;
    const counts = mapCounts();
    if (!counts.plotted) {
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
    if (!counts.visible) return { kind: 'info', text: 'No reports match the filters you have on.' };
    if (mapStateRef.current && mapStateRef.current.tilesFailing) {
        return { kind: 'warn', text: 'The map background is not loading -- the reports below are still correct and still up to date, only the map picture behind them is missing.' };
    }
    return null;
}

// How long before "Updated 4m ago" stops being a reassurance and starts being
// a claim the page cannot support. The map data refreshes on a poll; when that
// poll dies the timestamp simply keeps ageing, and an operator reading a
// worst-first triage queue has no way to tell a quiet morning from a page that
// stopped listening an hour ago. Stale data on screen is labelled stale.
const STALE_AFTER_MS = 3 * 60e3;

function isStale() {
    return lastUpdatedAt != null && (Date.now() - lastUpdatedAt) > STALE_AFTER_MS;
}

// The staleness label is the one thing on this panel that has to change while
// NOTHING else is happening -- if the polls are dead there is no other event
// left to trigger a render, which is exactly the situation being reported. So
// it gets its own low-frequency ticker, and that ticker re-renders only on the
// fresh -> stale EDGE rather than every tick, so a healthy page pays nothing.
let wasStale = false;
setInterval(() => {
    const now = isStale();
    if (now === wasStale) return;
    wasStale = now;
    schedule();
}, 30e3);

// ---- what the map says to someone who cannot see it ----------------------

// The ids the canvas is named and described by. Named constants because three
// separate nodes have to agree on them and a typo in any one silently drops
// the name or the description with nothing on screen to show for it.
const MAP_HEADING_ID = 'ds-map-heading';
const MAP_SUMMARY_ID = 'ds-map-summary';

// The map's text equivalent: what it shows, how much of it, and the same
// counts the rail states as chips -- every one of them from mapCounts(), so
// the sentence and the numbers beside it cannot disagree. It is visually
// hidden because the map itself already answers all of this for anyone who
// can see it; repeating it on screen would be the redundant second copy the
// rail's chips already rule out.
function mapTextEquivalent() {
    if (error) return 'The map could not load: ' + error;
    if (!loadedOnce) return 'The map is still loading.';
    const c = mapCounts();
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
    const missing = mapUnresolvedSummaryText();
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
    queue: { label: QUEUE_NAME, body: attentionFeed },
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
    // Says which of the two it is, in words, rather than leaving a quietly
    // ageing "Updated 41m ago" to be read as if it were current.
    const stale = isStale();
    const lastUpdatedNote = lastUpdatedAt
        ? h('div', {
            class: 'ds-map-updated' + (stale ? ' is-stale' : ''),
            role: stale ? 'status' : null,
            title: stale
                ? 'This view has stopped refreshing. Reload the page to get the current picture.'
                : null,
        }, (stale ? 'Not refreshing -- last updated ' : 'Updated ') + agoText(lastUpdatedAt))
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

// ---- what the pin popup used to be the only home for ---------------------

// The pin popup is gone (see map-leaflet.js), so the two things it ALONE could
// reach are surfaced here, bound to the live map instance, for the case detail
// in the rail to render. A facade on purpose: the case detail asks by case id
// and never learns that a Leaflet instance, a pin list or a cluster index
// exist -- so it stays renderable on the case-list side of the app, where no
// map is mounted at all and both of these correctly resolve to "nothing".
export function clusterNoteFor(caseId) {
    return clusterNoteForCase(mapStateRef.current, caseId);
}

// Null when there is no live map: the picker ranks workers by distance from
// the case and reads its roster from the worker overlay, neither of which
// exists without one. The caller hides the action rather than offering a
// control that cannot work.
export function canDispatchFor(caseId) {
    return !!(mapStateRef.current && (mapStateRef.current.pins || []).some((p) => p.id === caseId));
}

export function dispatchWorkerFor(caseId) {
    return dispatchForCase(mapStateRef.current, caseId);
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
        pinsLoaded: mapCounts().plotted,
        pinsVisible: mapCounts().visible,
        attentionTotal: mapCounts().attention,
        queueMatching: queueRows().length,
        queueShown: Math.min(queueShown, queueRows().length),
        unresolvedCount: summary.unresolvedCount || 0,
        truncated: !!summary.truncated,
        lastUpdatedAt,
        loadedOnce,
        error,
    };
}
