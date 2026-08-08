// Geo panel -- hotspots by area. Content-swap panel (state.activePanel ===
// 'geo'). Table-based, per architecture spec section 1.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { Spinner, Alert } from '/design/src/components/content/feedback.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { state, schedule, closePanel } from '../state.js';
import { fetchGeo } from '../api.js';
import { fmtTime } from '../format.js';

const h = webjsx.createElement;

let loaded = false, loading = false, error = null;

function ensureLoaded() {
    if (loaded || loading) return;
    loading = true;
    fetchGeo().then((j) => {
        state._geo = j;
        loaded = true; loading = false; error = null; schedule();
    }).catch((e) => { loaded = true; loading = false; error = e.message || 'geo error'; schedule(); });
}

function mixOf(p) {
    return Object.entries(p.species || {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([s, n]) => `${s} x${n}`).join(', ') || '--';
}

export function GeoPanel() {
    ensureLoaded();
    const back = Btn({ variant: 'ghost', children: 'Back to cases', onClick: closePanel });
    let body;
    if (loading && !loaded) body = Spinner({ label: 'loading hotspots' });
    else if (error) body = Alert({ kind: 'error', children: 'Hotspots error: ' + error });
    else {
        const places = (state._geo && state._geo.places) || [];
        body = places.length
            ? Table({
                headers: ['Place', 'Count', 'Species mix', 'Latest'],
                rows: places.map((p) => [p.place, String(p.count), mixOf(p), p.latest ? fmtTime(p.latest) : '']),
            })
            : Alert({ kind: 'info', children: 'No location data yet.' });
    }
    return Panel({ title: 'Hotspots', children: [back, body] });
}
