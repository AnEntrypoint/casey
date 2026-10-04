import { setActiveId } from '../state.js';
import { urgencyByCaseId, pinMatches, LOCATION_SOURCE_VALUES } from '../map-model.js';
import { renderClusterLines } from './map-overlays.js';
import { stageLabel } from '../format.js';
import { EntityLabel } from '../vocabulary.js';

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
    const sig = markerSignature(mapState, filters, urgencyByCaseId());
    if (mapState.markerLayer && sig === mapState.markerSig) return;
    mapState.markerSig = sig;
    if (mapState.markerLayer) map.removeLayer(mapState.markerLayer);
    const urgency = urgencyByCaseId();
    const filtered = mapState.pins.filter((p) => pinMatches(p, filters, urgency, null));
    const layer = window.L.markerClusterGroup({ maxClusterRadius: 40 });
    mapState.markerById = new Map();
    for (const p of filtered) {
        const u = urgency.get(p.id) || 0;
        const m = window.L.marker([p.lat, p.lon], {
            icon: mapMarkerIcon(STATUS_TOKEN[p.status] || '--fg-3', p.location_source, u, mapState.selectedId === p.id),
            zIndexOffset: u * 1000,
            title: `${p.ref} -- ${stageLabel(p.status)}${Number.isFinite(p.location_confidence) ? ` -- pin ${p.location_confidence}% sure` : ''}`,
        });
        m.on('add', () => {
            const el = m.getElement();
            if (el) el.setAttribute('aria-label', `${EntityLabel()} ${p.ref}, ${stageLabel(p.status)}${Number.isFinite(p.location_confidence) ? `, pin ${p.location_confidence}% sure` : ''}`);
        });
        m.on('click', () => setActiveId(p.id));
        mapState.markerById.set(p.id, m);
        layer.addLayer(m);
    }
    map.addLayer(layer);
    mapState.markerLayer = layer;
    renderClusterLines(mapState, filtered);
}

export function setSelectedCase(mapState, id) {
    if (!mapState) return;
    const prev = mapState.selectedId;
    if (prev === id) return;
    mapState.selectedId = id;
    for (const target of [prev, id]) {
        if (target == null) continue;
        const m = mapState.markerById && mapState.markerById.get(target);
        if (!m) continue;
        const el = m.getElement && m.getElement();
        const dot = el && el.querySelector('.ds-map-marker-dot');
        if (!dot) continue;
        if (target === id) dot.setAttribute('data-selected', '1');
        else dot.removeAttribute('data-selected');
    }
}
