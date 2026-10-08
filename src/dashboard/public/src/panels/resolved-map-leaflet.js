import { schedule } from '../state.js';
import { word } from '../words.js';

const L = () => window.L;

function tileUrl() {
    try {
        const el = document.querySelector('meta[name="casey-tile-url"]');
        const v = el && el.getAttribute('content');
        if (v) return v;
    } catch {  }
    return '/tiles/{z}/{x}/{y}.png';
}

const HOME_VIEW = [[-31.6, 29.3], 8];

export function cssColour(el, token) {
    const v = el ? getComputedStyle(el).getPropertyValue(token).trim() : '';
    return v || '#888888';
}

const TILE_FAIL_RUN = 4;
export const DISEASE_MARKS = [
    { fill: true, dash: null },
    { fill: false, dash: null },
    { fill: false, dash: '1 3' },
    { fill: false, dash: '6 3' },
    { fill: false, dash: '2 2 6 2' },
    { fill: false, dash: '8 3 1 3' },
];

export function mountResolvedMap(canvas, prev) {
    if (!canvas || !L()) return null;
    if (prev && prev.canvas === canvas) return prev;
    if (prev && prev.map) prev.map.remove();
    canvas.innerHTML = '';
    const map = L().map(canvas, { zoomControl: true });
    map.setView(HOME_VIEW[0], HOME_VIEW[1]);
    const drv = { canvas, map, layer: null, fitted: '', tilesFailing: false };
    const tiles = L().tileLayer(tileUrl(), { maxZoom: 14, attribution: word('ui.resolved_map_leaflet_attribution') }).addTo(map);
    let tileFails = 0;
    tiles.on('tileerror', () => { tileFails += 1; if (tileFails >= TILE_FAIL_RUN && !drv.tilesFailing) { drv.tilesFailing = true; schedule(); } });
    tiles.on('tileload', () => { tileFails = 0; if (drv.tilesFailing) { drv.tilesFailing = false; schedule(); } });
    L().control.scale({ imperial: false }).addTo(map);
    drv.layer = L().layerGroup().addTo(map);
    return drv;
}

export function drawDots(drv, dots, styleFor) {
    drv.layer.clearLayers();
    const memo = new Map();
    const styleOf = (d) => { if (!memo.has(d)) memo.set(d, styleFor(d)); return memo.get(d); };
    for (const p of dots) {
        const s = styleOf(p.disease);
        L().circleMarker([p.lat, p.lon], {
            radius: 6, weight: s.mark.fill ? 1 : 3, color: s.colour, fillColor: s.colour,
            fillOpacity: s.mark.fill ? 0.75 : 0, dashArray: s.mark.dash,
        }).bindTooltip(word('ui.resolved_map_leaflet_dot', {
            disease: p.disease,
            species: p.species,
            advice: p.advice && p.advice[0] !== 'Not stated' ? word('ui.resolved_map_leaflet_advice', { advice: p.advice.join(', ') }) : '',
            week: p.resolved_at,
        })).addTo(drv.layer);
    }
}

export function drawHeat(drv, cells, cellDeg, colour) {
    drv.layer.clearLayers();
    const max = cells.reduce((m, c) => Math.max(m, c.count), 1);
    const half = cellDeg / 2;
    for (const c of cells) {
        L().rectangle([[c.lat - half, c.lon - half], [c.lat + half, c.lon + half]], {
            weight: 0, color: colour, fillColor: colour, fillOpacity: 0.15 + 0.7 * (c.count / max),
        }).bindTooltip(word('ui.resolved_map_leaflet_in_area', { count: c.count })).addTo(drv.layer);
    }
}

export function drawBubbles(drv, areas, colour) {
    drv.layer.clearLayers();
    const max = areas.reduce((m, a) => Math.max(m, a.count), 1);
    for (const a of areas) {
        L().circleMarker([a.lat, a.lon], {
            radius: 8 + 28 * Math.sqrt(a.count / max), weight: 2, color: colour, fillColor: colour, fillOpacity: 0.35,
        }).bindTooltip(word('ui.resolved_map_leaflet_bubble', {
            region: a.region,
            count: a.count,
            cases: word(a.count === 1 ? 'ui.resolved_map_leaflet_case' : 'ui.resolved_map_leaflet_cases'),
            mostly: a.top_disease ? word('ui.resolved_map_leaflet_mostly', { disease: a.top_disease }) : '',
        })).addTo(drv.layer);
    }
}


export function fitOnce(drv, fitKey, points) {
    if (drv.fitted === fitKey || !points.length) return;
    drv.fitted = fitKey;
    try { drv.map.fitBounds(L().latLngBounds(points.map((p) => [p.lat, p.lon])), { maxZoom: 11, padding: [24, 24], animate: false }); } catch {  }
}
