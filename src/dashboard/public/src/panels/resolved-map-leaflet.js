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

export function drawDots(drv, dots, colourFor) {
    drv.layer.clearLayers();
    for (const p of dots) {
        L().circleMarker([p.lat, p.lon], {
            radius: 6, weight: 1, color: colourFor(p.disease), fillColor: colourFor(p.disease), fillOpacity: 0.75,
        }).bindTooltip(`${p.disease} - ${p.species}${p.advice && p.advice[0] !== 'Not stated' ? ' - advice: ' + p.advice.join(', ') : ''} - week of ${p.resolved_at}`).addTo(drv.layer);
    }
}

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

export function drawBubbles(drv, areas, colour) {
    drv.layer.clearLayers();
    const max = areas.reduce((m, a) => Math.max(m, a.count), 1);
    for (const a of areas) {
        L().circleMarker([a.lat, a.lon], {
            radius: 8 + 28 * Math.sqrt(a.count / max), weight: 2, color: colour, fillColor: colour, fillOpacity: 0.35,
        }).bindTooltip(`${a.region}: ${a.count} signed-off ${a.count === 1 ? 'case' : 'cases'}${a.top_disease ? ', mostly ' + a.top_disease : ''}`).addTo(drv.layer);
    }
}


export function fitOnce(drv, fitKey, points) {
    if (drv.fitted === fitKey || !points.length) return;
    drv.fitted = fitKey;
    try { drv.map.fitBounds(L().latLngBounds(points.map((p) => [p.lat, p.lon])), { maxZoom: 11, padding: [24, 24], animate: false }); } catch {  }
}
