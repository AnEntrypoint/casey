// RESPONSIBILITY: the rail's chrome -- the time window, the counted filter
// chips, the worst-first queue, the map options, and the no-location
// disclosure.
//
// The rail is where everything that is NOT the map picture lives. Counts,
// filters, overlays and the queue dock here and are never floated over the
// canvas (mapuipatterns' rule for situational-awareness domains: do not cover
// potentially important data with floating panels; the measurable version of
// the failure here was pins fitted underneath an opaque queue card -- on
// screen, but unreadable and unclickable).
//
// It renders from map-view-state.js, the same store the pane reads, and from
// map-model.js's derivations, so the number on a chip and the number in the
// map's spoken text equivalent are the same number and not two.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Select } from '/design/src/components/content/fields.js';
import { Chip, Btn } from '/design/src/components/shell/atoms.js';
import {
    state, schedule, setActiveId, setMapFilter, clearMapFilter, setRailMode,
} from '../state.js';
import { urgencyByCaseId, filterIsActive, URGENCY_BAND_LABEL, QUEUE_NAME } from '../map-model.js';
import {
    mapStateRef, refresh, counts, queueRows, filterOptions, loadSummary,
    unresolvedSummaryText, unresolvedNoteText, isStale, updatedAt,
    QUEUE_PAGE, queueShownCount, setQueueShown,
} from './map-view-state.js';
import { toggleClusters, refilterMarkers, toggleCoverage, toggleWorkers, toggleLastReports, resetMapView } from './map-leaflet.js';
import { GeoPanel } from './geo-panel.js';
import { ClustersPanel } from './clusters-panel.js';
// One definition of the counted filter chip, shared with the case-list home
// view. Both surfaces render the same control and it must not be able to drift
// on one of them -- the same rule map-model.js enforces for the derivations
// these chips apply.
import { FilterChip, ClearChip } from '../components/filter-chip.js';

const h = webjsx.createElement;

// Finer than format.js's fmtDur, deliberately: this label answers "is this
// page still listening", so the first minute is exactly where the resolution
// has to be. fmtDur renders the whole of it as "0m".
function agoText(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 10) return 'just now';
    if (s < 60) return s + 's ago';
    const m = Math.round(s / 60);
    return m < 60 ? m + 'm ago' : Math.round(m / 60) + 'h ago';
}

function applyFilterToMap() {
    if (mapStateRef.current) refilterMarkers(mapStateRef.current, state.mapFilter);
    schedule();
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
    const { attention: attentionCount, today: newToday, inView: inViewCount } = counts();

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

// ---- the worst-first queue ----------------------------------------------

// Exported so keyboard triage walks the list the operator is actually looking
// at. j/k were wired to state.allCases unconditionally, which was correct when
// the case list was home and wrong the moment the map became home: the keys
// walked a list that was not on screen.
export function visibleQueueRows() { return queueRows(); }

function attentionFeed() {
    const all = queueRows();
    if (!all.length) {
        const why = filterIsActive(state.mapFilter)
            ? 'No reports match the filters you have on. Clear them to see the rest.'
            : 'Nothing needs attention right now.';
        return h('div', { class: 'triage' }, h('div', { class: 'calm' }, why));
    }
    const shown = queueShownCount();
    const rows = all.slice(0, shown);
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
                onclick: () => { setQueueShown(all.length); },
            }, `Show all ${all.length}`)
            : (shown > QUEUE_PAGE && all.length > QUEUE_PAGE
                ? h('button', {
                    key: 'less', type: 'button', class: 'ds-queue-more',
                    onclick: () => { setQueueShown(QUEUE_PAGE); },
                }, 'Show fewer')
                : null));
}

// ---- map options --------------------------------------------------------

function mapFilterRow() {
    const f = state.mapFilter;
    const options = filterOptions();
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

// ---- the reports that could not be plotted ------------------------------

function mapUnresolvedList() {
    return h('div', { class: 'ds-map-unresolved-list' }, ...(loadSummary().unresolved || []).map((p, i) =>
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
    const summary = loadSummary();
    if (!summary.unresolvedCount && !summary.truncated) return [];
    return [h('details', { class: 'ds-rail-disclosure' },
        h('summary', {}, unresolvedSummaryText()),
        h('div', { class: 'ds-rail-disclosure-body' },
            h('div', { class: 'ds-map-unresolved-note' }, unresolvedNoteText()),
            mapUnresolvedList()))];
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
    const at = updatedAt();
    const lastUpdatedNote = at
        ? h('div', {
            class: 'ds-map-updated' + (stale ? ' is-stale' : ''),
            role: stale ? 'status' : null,
            title: stale
                ? 'This view has stopped refreshing. Reload the page to get the current picture.'
                : null,
        }, (stale ? 'Not refreshing -- last updated ' : 'Updated ') + agoText(at))
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
