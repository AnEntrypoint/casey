// Clusters panel -- related-case review + merge CTA. Content-swap panel
// (state.activePanel === 'clusters'). Correlated groups from /api/clusters.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Spinner, Alert } from '/design/src/components/content/feedback.js';
import { Chip, Btn } from '/design/src/components/shell/atoms.js';
import { state, schedule, closePanel, setActiveId } from '../state.js';
import { fetchClusters } from '../api.js';

const h = webjsx.createElement;

let loaded = false, loading = false, error = null;

function ensureLoaded() {
    if (loaded || loading) return;
    loading = true;
    fetchClusters().then((j) => {
        state._clusters = j;
        loaded = true; loading = false; error = null; schedule();
    }).catch((e) => { loaded = true; loading = false; error = e.message || 'clusters error'; schedule(); });
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

export function ClustersPanel() {
    ensureLoaded();
    const back = Btn({ variant: 'ghost', children: 'Back to cases', onClick: closePanel });
    let body;
    if (loading && !loaded) body = Spinner({ label: 'loading related-case groups' });
    else if (error) body = Alert({ kind: 'error', children: 'Related-reports error: ' + error });
    else {
        const cl = (state._clusters && state._clusters.clusters) || [];
        body = cl.length
            ? h('div', {}, ...cl.map(clusterRow))
            : Alert({ kind: 'info', children: 'No related-looking groups right now.' });
    }
    return Panel({ title: 'Related reports', children: [back, body] });
}
