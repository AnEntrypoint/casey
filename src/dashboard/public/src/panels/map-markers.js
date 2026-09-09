// RESPONSIBILITY: the pin -- the three visual channels it encodes, and the
// clustered marker layer built from them.
//
// Everything here is a function of the pin set and the filter; nothing here
// creates, frames or resizes the map (map-leaflet.js) and nothing here decides
// which pins pass (map-model.js). Marker CLUSTERING lives here rather than in
// the overlays because a cluster group is the marker layer itself, not a layer
// drawn beside it: pins go into the group and Leaflet decides when to collapse
// them.

import { setActiveId } from '../state.js';
import { urgencyByCaseId, pinMatches, LOCATION_SOURCE_VALUES } from '../map-model.js';
import { renderClusterLines } from './map-overlays.js';

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
// so it is one of six literals; urgency is a number this module computed; and
// location_source is whitelisted (map-model.js's LOCATION_SOURCE_VALUES) rather
// than passed through, because it arrives from the store and an unrecognised
// value would otherwise be written straight into an attribute. Nothing on a pin
// is contact-authored text, and this keeps it that way by construction -- the
// CSS only matches the known values anyway, so an unknown one has no rendering
// to lose.
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

export function renderMapMarkers(mapState, filters) {
    const { map } = mapState;
    // Computed before anything is torn down: this is what makes a periodic
    // refresh of the pins affordable at all. Without it, polling the map data
    // to keep a surveillance view current would collapse the operator's
    // clusters on every tick even when not one report had changed.
    const sig = markerSignature(mapState, filters, urgencyByCaseId());
    if (mapState.markerLayer && sig === mapState.markerSig) return;
    mapState.markerSig = sig;
    if (mapState.markerLayer) map.removeLayer(mapState.markerLayer);
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
        // onActiveIdChange subscription in map-view-state.js. Before this, a pin
        // click opened an overlay that covered the neighbouring pins and put a
        // second "Open case" click between the operator and the report.
        m.on('click', () => setActiveId(p.id));
        mapState.markerById.set(p.id, m);
        layer.addLayer(m);
    }
    map.addLayer(layer);
    mapState.markerLayer = layer;
    // The cluster-link lines are a function of the same filtered set, so they
    // are redrawn from here rather than from the overlay toggle -- a line to a
    // report the filter has hidden points at a pin that is not on the map.
    renderClusterLines(mapState, filtered);
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
