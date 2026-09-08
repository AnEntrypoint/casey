// Hotspots by area: which places are producing reports, and what mix. Rendered
// two ways -- docked in the map rail beside the pins (railed), and as a
// content-swap page whose title and back control come from app-view.js's
// PanelSwap head, not from here.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { Spinner, Alert } from '/design/src/components/content/feedback.js';
import { state, schedule } from '../state.js';
import { panelError } from './panel-error.js';
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
    }).catch((e) => { loaded = true; loading = false; error = panelError('the hotspots', e); schedule(); });
}

function mixOf(p) {
    return Object.entries(p.species || {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([s, n]) => `${s} x${n}`).join(', ') || '--';
}

// railed=true renders the table alone, for the map view's rail (see
// map-panel.js MapRail). Hotspots answers a WHERE question, so swapping the
// map out to show it as a full-page table was answering "where" by unmounting
// the only thing that can show where. In the rail the numbers sit beside the
// map instead of replacing it, and the panel keeps every column it had.
export function GeoPanel({ railed = false } = {}) {
    ensureLoaded();
    let body;
    if (loading && !loaded) body = Spinner({ label: 'loading hotspots' });
    else if (error) body = Alert({ kind: 'error', children: error });
    else {
        const places = (state._geo && state._geo.places) || [];
        body = places.length
            ? Table({
                headers: ['Place', 'Count', 'Species mix', 'Latest'],
                rows: places.map((p) => [p.place, String(p.count), mixOf(p), p.latest ? fmtTime(p.latest) : '']),
            })
            : Alert({ kind: 'info', children: 'No location data yet.' });
    }
    if (railed) return body;
    // Body only, like every other registered panel. This module used to add its
    // own 'Back to cases' button and its own 'Hotspots' title on top of the
    // ones app-view.js's PanelSwap head already renders for every panel, so the
    // page carried two back controls that disagreed about where back was -- the
    // head correctly said "Back to the map" from the map home view while this
    // one said "Back to cases" directly under it -- and two headings. The head
    // also takes its title from the nav item the operator clicked, so a
    // deployer's dashboard_ui.nav.relabel renames the page; this hardcoded
    // 'Hotspots' ignored it.
    return Panel({ children: [body] });
}
