// RESPONSIBILITY: the Leaflet instance behind the resolved map -- create it once
// per canvas, and draw either the released dots or the released heat cells into
// it. Imperative and window.L only; no webjsx, no chrome (resolved-map-panel.js).
//
// It draws only what routes/reports-map.js released: dots already rounded to ~1 km
// and heat cells already at or over the small-group floor. Nothing here can place
// a report more exactly than the server did.

const L = () => window.L;

function tileUrl() {
    try {
        const el = document.querySelector('meta[name="casey-tile-url"]');
        const v = el && el.getAttribute('content');
        if (v) return v;
    } catch { /* no document */ }
    return '/tiles/{z}/{x}/{y}.png';
}

// Wild Coast / OR Tambo: the view before any dot arrives.
const HOME_VIEW = [[-31.6, 29.3], 8];

export function cssColour(el, token) {
    const v = el ? getComputedStyle(el).getPropertyValue(token).trim() : '';
    return v || '#888888';
}

// One driver per live canvas element; a swapped canvas gets a fresh map.
export function mountResolvedMap(canvas, prev) {
    if (!canvas || !L()) return null;
    if (prev && prev.canvas === canvas) return prev;
    if (prev && prev.map) prev.map.remove();
    canvas.innerHTML = '';
    const map = L().map(canvas, { zoomControl: true });
    map.setView(HOME_VIEW[0], HOME_VIEW[1]);
    L().tileLayer(tileUrl(), { maxZoom: 14, attribution: '(c) OpenStreetMap contributors' }).addTo(map);
    const layer = L().layerGroup().addTo(map);
    return { canvas, map, layer, fitted: '' };
}

// dots: [{lat, lon, disease, species, resolved_at}]; colourFor(disease) -> colour string.
export function drawDots(drv, dots, colourFor) {
    drv.layer.clearLayers();
    for (const p of dots) {
        L().circleMarker([p.lat, p.lon], {
            radius: 6, weight: 1, color: colourFor(p.disease), fillColor: colourFor(p.disease), fillOpacity: 0.75,
        }).bindTooltip(`${p.disease} - ${p.species} - week of ${p.resolved_at}`).addTo(drv.layer);
    }
}

// cells: [{lat, lon, count}] at cell_deg; opacity follows the count against the busiest cell.
export function drawHeat(drv, cells, cellDeg, colour) {
    drv.layer.clearLayers();
    const max = cells.reduce((m, c) => Math.max(m, c.count), 1);
    const half = cellDeg / 2;
    for (const c of cells) {
        L().rectangle([[c.lat - half, c.lon - half], [c.lat + half, c.lon + half]], {
            weight: 0, color: colour, fillColor: colour, fillOpacity: 0.15 + 0.7 * (c.count / max),
        }).bindTooltip(`${c.count} in this area`).addTo(drv.layer);
    }
}

// Fit once per "fitKey" (region/period change), never on every slider tick, so the reader's own zoom survives playback.
export function fitOnce(drv, fitKey, points) {
    if (drv.fitted === fitKey || !points.length) return;
    drv.fitted = fitKey;
    try { drv.map.fitBounds(L().latLngBounds(points.map((p) => [p.lat, p.lon])), { maxZoom: 11, padding: [24, 24], animate: false }); } catch { /* keep the home view */ }
}
