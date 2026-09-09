// RESPONSIBILITY: the map view's live state -- the Leaflet handle, the last
// load's summary and options, the single collapsed loader, and every count
// read off them -- shared by the map pane and the rail beside it.
//
// It exists because the pane and the rail are two renderings of ONE view, not
// two views. They must state the same numbers at the same moment, so they read
// one store rather than each holding their own; the same argument map-model.js
// makes for the derivations, applied one level up to the state those
// derivations run over. Nothing here renders anything: it holds state, loads
// it, and answers questions about it.

import {
    state, schedule, onActiveIdChange, onAttentionChange, onMobilePaneChange,
} from '../state.js';
import { urgencyByCaseId, mapCounts, queueRows as queueRowsFor } from '../map-model.js';
import { loadMap, focusCaseOnMap, refilterMarkers } from './map-leaflet.js';
import { setSelectedCase } from './map-markers.js';
import { openDispatchPicker } from './dispatch-picker.js';

// The live Leaflet instance, or {current:null} before the canvas mounts. Passed
// by reference into loadMap so the driver can create it once and every reader
// here sees the same object.
export const mapStateRef = { current: null };

let options = { species: [], types: [], statuses: [] };
let summary = { unresolvedCount: 0, unresolved: [], truncated: false, cap: 0, totalConsidered: 0 };
let error = null;
// Distinguishes "the request failed" from "it succeeded and there is genuinely
// nothing" -- rendering both as an empty map told the operator nothing about
// which had happened. False until the first attempt resolves either way.
let loadedOnce = false;
let lastUpdatedAt = null;

// How many queue rows the rail shows. A silent slice(0,5) meant the rail head
// could read "14 need a person" above a list of 5, with nothing on screen
// explaining the gap -- on a triage queue in a disease-surveillance deployment,
// report 6 being invisible is a safety problem, not a cosmetic one.
export const QUEUE_PAGE = 8;
let queueShown = QUEUE_PAGE;

export const filterOptions = () => options;
export const loadSummary = () => summary;
export const loadError = () => error;
export const hasLoadedOnce = () => loadedOnce;
export const updatedAt = () => lastUpdatedAt;
export const queueShownCount = () => queueShown;
export const setQueueShown = (n) => { queueShown = n; schedule(); };

// ---- the one load -------------------------------------------------------

// Collapses overlapping loads into one. Measured live on a real boot: the map
// payload was fetched THREE times before the page settled, because several
// renders land in quick succession during boot, each one can hand
// onMountCanvas a fresh canvas element, and each of those called refresh().
// On the rural link this deployment targets, paying for the same payload three
// times before the operator sees anything is not a rounding error.
let inFlight = false;
export function refresh() {
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
// screen; the marker-signature guard in map-markers.js is what makes a
// repeated call cheap, and the inFlight guard above still collapses overlaps.
export function refreshMapData() {
    refresh();
}

// Called by the canvas mount when the Leaflet instance is discarded, so the
// next render rebuilds it from scratch rather than against a dead container.
export function discardMap() {
    const ms = mapStateRef.current;
    if (!ms) return;
    try { ms.sizeObserver?.disconnect(); } catch { /* already gone */ }
    ms.map.remove();
    mapStateRef.current = null;
}

// ---- what both halves count over ----------------------------------------

export function livePins() {
    return (mapStateRef.current && mapStateRef.current.pins) || [];
}

// The map's RAW viewport, or null when no map is mounted. Whether it NARROWS
// anything is map-model.js's decision (only when the operator turned `inView`
// on); this only reports where the map is looking.
export function mapBounds() {
    const ms = mapStateRef.current;
    if (!ms || !ms.map) return null;
    try { return ms.map.getBounds(); } catch { return null; }
}

export function counts() { return mapCounts(livePins(), mapBounds()); }
export function queueRows() { return queueRowsFor(livePins(), mapBounds()); }

// ---- what the load summary states ---------------------------------------

// The COLLAPSED line is the only thing on screen while the rail's disclosure is
// shut, so every fact that must not be silent has to be in it. It used to carry
// the no-location count alone, which meant a capped load with no no-location
// reports rendered "Reports with no location (0)" -- an operator reads that
// zero and never opens it, and the cap statement sitting inside was never seen.
// A cap is stated with its true total beside it or it is not stated, and that
// is a safety property here, not a cosmetic one.
//
// The rail's disclosure and the map's spoken text equivalent both say this, and
// they say it in the same words because they read this one function -- a second
// wording of a surveillance blind spot is a second thing to keep in step.
export function unresolvedSummaryText() {
    const parts = [];
    if (summary.unresolvedCount) parts.push(`Reports with no location (${summary.unresolvedCount})`);
    if (summary.truncated) parts.push(`Only ${summary.cap} of ${summary.totalConsidered} reports loaded`);
    return parts.join(' -- ');
}

// The expanded body says WHY each of those two facts is true. It does not
// repeat the counts the summary above it already states.
export function unresolvedNoteText() {
    const parts = [];
    if (summary.unresolvedCount) parts.push('No GPS, and the location text did not match a known area, so these cannot be drawn on the map.');
    if (summary.truncated) parts.push('The rest are not loaded at all, so they are not on this screen and not in the list below.');
    return parts.join(' ');
}

// ---- staleness ----------------------------------------------------------

// How long before "Updated 4m ago" stops being a reassurance and starts being
// a claim the page cannot support. The map data refreshes on a poll; when that
// poll dies the timestamp simply keeps ageing, and an operator reading a
// worst-first triage queue has no way to tell a quiet morning from a page that
// stopped listening an hour ago. Stale data on screen is labelled stale.
const STALE_AFTER_MS = 3 * 60e3;

export function isStale() {
    return lastUpdatedAt != null && (Date.now() - lastUpdatedAt) > STALE_AFTER_MS;
}

// The staleness label is the one thing on this view that has to change while
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

// ---- subscriptions ------------------------------------------------------

// One subscription, registered at module load: every path that opens a case --
// the queue, a pin, the unresolved list, the case list, keyboard Enter, a hash
// deep link -- goes through setActiveId, so all of them move the map.
// Previously only the queue did, and the view stopped answering "where" on
// every other route into a case.
onActiveIdChange((id) => {
    if (!mapStateRef.current) return;
    setSelectedCase(mapStateRef.current, id);
    if (id != null) focusCaseOnMap(mapStateRef.current, id);
});

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

// The markers are imperative Leaflet objects, so unlike the rail they are not
// re-rendered by schedule(). They carry the urgency channel, which comes from
// the attention list, which arrives AFTER the first map load and then refreshes
// on its own 30s poll -- so without this the pins were built from an empty
// attention list and stayed at urgency 0 for the life of the page.
//
// Rebuild only when the urgency assignment actually changed. Rebuilding on
// every 30s poll would collapse the marker clusters and close a popup the
// operator has open, for a result identical to what is already on screen.
let lastUrgencySig = '';
onAttentionChange(() => {
    const sig = [...urgencyByCaseId().entries()].sort().map(([k, v]) => k + ':' + v).join(',');
    if (sig === lastUrgencySig) return;
    lastUrgencySig = sig;
    if (mapStateRef.current) refilterMarkers(mapStateRef.current, state.mapFilter);
});

// ---- what the pin popup used to be the only home for ---------------------

// The pin popup is gone (see map-leaflet.js), so the two things it ALONE could
// reach are surfaced here, bound to the live map instance, for the case detail
// in the rail to render. A facade on purpose: the case detail asks by case id
// and never learns that a Leaflet instance, a pin list or a cluster index
// exist -- so it stays renderable on the case-list side of the app, where no
// map is mounted at all and both of these correctly resolve to "nothing".

// The cluster linkage (computed server-side by clusters.js buildClusters and
// shipped in /api/map/cases) answers "what is going on HERE" rather than "what
// is this one pin" -- Ushahidi's cluster-summary pattern.
export function clusterNoteFor(caseId) {
    const ms = mapStateRef.current;
    if (!ms) return null;
    const p = (ms.pins || []).find((x) => x.id === caseId);
    if (!p || p.cluster == null) return null;
    const info = ms.clusters ? ms.clusters[p.cluster] : null;
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

// Null when there is no live map: the picker ranks workers by distance from
// the case and reads its roster from the worker overlay, neither of which
// exists without one. The caller hides the action rather than offering a
// control that cannot work.
export function canDispatchFor(caseId) {
    return !!(mapStateRef.current && (mapStateRef.current.pins || []).some((p) => p.id === caseId));
}

// Resolves the case's own coordinate so the picker can rank workers by
// distance, exactly as the popup's link did. A case with no placeable
// coordinate still dispatches -- it just ranks unsorted rather than refusing,
// since "no GPS yet" is a routine state here, not an error.
export function dispatchWorkerFor(caseId) {
    const ms = mapStateRef.current;
    if (!ms) return;
    const p = (ms.pins || []).find((x) => x.id === caseId);
    return openDispatchPicker(ms, caseId, p ? p.lat : null, p ? p.lon : null);
}

// ---- diagnosis ----------------------------------------------------------

// Read-only snapshot for diagnosing the class of bug this whole restructure
// fixes: the two halves of the view disagreeing about the same cases. Carries
// counts and view state only -- never a ref, subject, contact id or any other
// contact-supplied text, matching the PII-free-projection discipline every
// other operator-facing projection in casey follows.
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
