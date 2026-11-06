import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { state } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchGeo } from '../api.js';
import { fmtTime, NO_TIME_TEXT } from '../format.js';
import { word } from '../words.js';

const h = webjsx.createElement;

const loader = createPanelLoader({
    what: () => word('ui.geo_panel_what'),
    label: () => word('ui.geo_panel_loading'),
    fetch: fetchGeo,
    apply: (j) => { state._geo = j; },
});

function mixOf(p) {
    return Object.entries(p.species || {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([s, n]) => word('ui.geo_panel_species_count', { species: s, count: n })).join(', ') || word('ui.geo_panel_none_recorded');
}

const PLACE_KEY = {
    unknown: 'ui.geo_panel_place_unknown',
    'other/sparse': 'ui.geo_panel_place_sparse',
};
const placeLabel = (place) => (PLACE_KEY[place] ? word(PLACE_KEY[place]) : place);

export function GeoPanel({ railed = false } = {}) {
    loader.ensureLoaded();
    const body = loader.slot(() => {
        const places = (state._geo && state._geo.places) || [];
        return places.length
            ? Table({
                headers: [word('ui.geo_panel_h_place'), word('ui.geo_panel_h_count'), word('ui.geo_panel_h_mix'), word('ui.geo_panel_h_latest')],
                rows: places.map((p) => [placeLabel(p.place), String(p.count), mixOf(p), fmtTime(p.latest) || NO_TIME_TEXT]),
            })
            : Alert({ kind: 'info', children: word('ui.geo_panel_none') });
    });
    if (railed) return body;
    return Panel({ children: [body] });
}
