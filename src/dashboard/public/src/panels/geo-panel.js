import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { state } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchGeo } from '../api.js';
import { fmtTime } from '../format.js';

const h = webjsx.createElement;

const loader = createPanelLoader({
    what: 'the hotspots',
    label: 'loading hotspots',
    fetch: fetchGeo,
    apply: (j) => { state._geo = j; },
});

function mixOf(p) {
    return Object.entries(p.species || {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([s, n]) => `${s} x${n}`).join(', ') || 'none recorded';
}

const PLACE_LABEL = {
    unknown: 'No area given',
    'other/sparse': 'Areas with too few reports to name',
};
const placeLabel = (place) => PLACE_LABEL[place] || place;

export function GeoPanel({ railed = false } = {}) {
    loader.ensureLoaded();
    const body = loader.slot(() => {
        const places = (state._geo && state._geo.places) || [];
        return places.length
            ? Table({
                headers: ['Place', 'Count', 'Species mix', 'Latest'],
                rows: places.map((p) => [placeLabel(p.place), String(p.count), mixOf(p), p.latest ? fmtTime(p.latest) : '']),
            })
            : Alert({ kind: 'info', children: 'No location data yet.' });
    });
    if (railed) return body;
    return Panel({ children: [body] });
}
