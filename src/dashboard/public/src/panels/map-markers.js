import { setActiveId } from '../state.js';
import { urgencyByCaseId, pinMatches, LOCATION_SOURCE_VALUES } from '../map-model.js';
import { renderClusterLines } from './map-overlays.js';
import { stageLabel } from '../format.js';
import { EntityLabel } from '../vocabulary.js';
import { word } from '../words.js';

export const STATUS_TOKEN = {
    new: '--sky',
    triaging: '--amber',
    in_progress: '--purple-2',
    waiting: '--accent',
    resolved: '--green',
    closed: '--fg-3',
};

const URGENCY_SIZE = { 0: 14, 1: 14, 2: 18, 3: 22 };

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

function markerSignature(mapState, filters, urgency) {
    const f = filters || {};
    return [f.species || '', f.type || '', f.status || '', f.band || '', mapState.showClusters ? 1 : 0]
        .concat((mapState.pins || []).map((p) => `${p.id}:${p.status}:${p.lat}:${p.lon}:${p.location_source}:${p.location_confidence}:${urgency.get(p.id) || 0}`))
        .join('|');
}

export function renderMapMarkers(mapState, filters) {
    const { map } = mapState;
    const urgency = urgencyByCaseId();
    const sig = markerSignature(mapState, filters, urgency);
    if (mapState.markerLayer && sig === mapState.markerSig) return;
    mapState.markerSig = sig;
    if (!mapState.markerLayer || !map.hasLayer(mapState.markerLayer)) {
        mapState.markerLayer = window.L.markerClusterGroup({ maxClusterRadius: 40 });
        mapState.markerById = new Map();
        map.addLayer(mapState.markerLayer);
    }
    const layer = mapState.markerLayer;
    const filtered = mapState.pins.filter((p) => pinMatches(p, filters, urgency, null));
    const wanted = new Set(filtered.map((p) => p.id));
    const stale = [];
    for (const [id, entry] of mapState.markerById) {
        if (wanted.has(id)) continue;
        stale.push(entry.marker);
        mapState.markerById.delete(id);
    }
    const fresh = [];
    for (const p of filtered) {
        const u = urgency.get(p.id) || 0;
        const selected = mapState.selectedId === p.id;
        const iconSig = [p.ref, p.status, p.location_source, p.location_confidence, p.lat, p.lon, u, selected ? 1 : 0].join('|');
        const prev = mapState.markerById.get(p.id);
        if (prev && prev.sig === iconSig) continue;
        if (prev) stale.push(prev.marker);
        const pinSure = Number.isFinite(p.location_confidence);
        const m = window.L.marker([p.lat, p.lon], {
            icon: mapMarkerIcon(STATUS_TOKEN[p.status] || '--fg-3', p.location_source, u, selected),
            zIndexOffset: u * 1000,
            title: `${p.ref} -- ${stageLabel(p.status)}` + (pinSure ? word('ui.map_markers_pin_sure', { confidence: p.location_confidence }) : ''),
        });
        m.on('add', () => {
            const el = m.getElement();
            if (el) el.setAttribute('aria-label', word('ui.map_markers_aria', {
                entity: EntityLabel(),
                ref: p.ref,
                stage: stageLabel(p.status),
                pin: pinSure ? word('ui.map_markers_pin_aria', { confidence: p.location_confidence }) : '',
            }));
        });
        m.on('click', () => setActiveId(p.id));
        mapState.markerById.set(p.id, { marker: m, sig: iconSig });
        fresh.push(m);
    }
    if (stale.length) layer.removeLayers(stale);
    if (fresh.length) layer.addLayers(fresh);
    renderClusterLines(mapState, filtered);
}

export function setSelectedCase(mapState, id) {
    if (!mapState) return;
    const prev = mapState.selectedId;
    if (prev === id) return;
    mapState.selectedId = id;
    for (const target of [prev, id]) {
        if (target == null) continue;
        const entry = mapState.markerById && mapState.markerById.get(target);
        const m = entry && entry.marker;
        if (!m) continue;
        const el = m.getElement && m.getElement();
        const dot = el && el.querySelector('.ds-map-marker-dot');
        if (!dot) continue;
        if (target === id) dot.setAttribute('data-selected', '1');
        else dot.removeAttribute('data-selected');
    }
}
