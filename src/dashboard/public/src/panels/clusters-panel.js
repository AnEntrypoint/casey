// Reports that look like the same situation, grouped by /api/clusters.
// Rendered two ways -- docked in the map rail beside the pins (railed), and as
// a content-swap page whose title and back control come from app-view.js's
// PanelSwap head, not from here.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Spinner, Alert } from '/design/src/components/content/feedback.js';
import { Chip } from '/design/src/components/shell/atoms.js';
import { state, schedule, setActiveId } from '../state.js';
import { panelError } from './panel-error.js';
import { fetchClusters } from '../api.js';

const h = webjsx.createElement;

let loaded = false, loading = false, error = null;

function ensureLoaded() {
    if (loaded || loading) return;
    loading = true;
    fetchClusters().then((j) => {
        state._clusters = j;
        loaded = true; loading = false; error = null; schedule();
    }).catch((e) => { loaded = true; loading = false; error = panelError('the related reports', e); schedule(); });
}

function clusterRow(c, i) {
    const loc = (c.location || []).join(', ');
    const sp = (c.species || []).join(', ');
    const sym = (c.symptoms || []).join(', ');
    const reported = (c.reported_disease_names || []).join(', ');
    return h('div', { key: i, class: 'ds-cluster-row' },
        h('div', { class: 'ds-cluster-head' },
            h('b', {}, `${c.count} cases`),
            loc ? h('span', {}, ' near ' + loc) : null,
            sp ? h('span', {}, ' -- ' + sp) : null),
        sym ? h('div', { class: 'ds-cluster-sub' }, 'symptoms: ' + sym) : null,
        reported ? h('div', { class: 'ds-cluster-sub', title: 'Named by the worker/farmer, not a lab result' }, 'as reported: ' + reported) : null,
        h('div', { class: 'ds-cluster-chips' }, ...(c.members || []).map((m, j) =>
            Chip({
                key: j, tone: 'accent',
                children: h('button', {
                    type: 'button', class: 'ds-chip-btn',
                    title: (m.case_type && m.case_type !== 'unset' ? m.case_type + ': ' : '') + (m.subject || ''),
                    onclick: () => { setActiveId(m.id); },
                }, m.ref),
            }))));
}

// railed=true renders the groups alone, for the map view's rail. Same reason
// as GeoPanel: a cluster is "these reports are near each other and look
// alike", which is a spatial claim -- and the map already draws the links
// between members (map-leaflet.js's cluster polylines). Showing the list in
// the rail lets the two agree on screen instead of living in two unrelated
// presentations that can drift apart.
export function ClustersPanel({ railed = false } = {}) {
    ensureLoaded();
    let body;
    if (loading && !loaded) body = Spinner({ label: 'loading related-case groups' });
    else if (error) body = Alert({ kind: 'error', children: error });
    else {
        const cl = (state._clusters && state._clusters.clusters) || [];
        body = cl.length
            ? h('div', {}, ...cl.map(clusterRow))
            : Alert({ kind: 'info', children: 'No related-looking groups right now.' });
    }
    if (railed) return body;
    // Body only, like every other registered panel. This module used to add its
    // own 'Back to cases' button and its own 'Related reports' title on top of
    // the ones app-view.js's PanelSwap head already renders, so the page
    // carried two back controls that disagreed about where back was -- the head
    // correctly said "Back to the map" from the map home view while this one
    // said "Back to cases" directly under it -- and two headings.
    return Panel({ children: [body] });
}
