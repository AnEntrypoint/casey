import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { PillButton } from '../components/filter-chip.js';
import { state, setActiveId } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchClusters } from '../api.js';
import { caseTypeLabel } from '../format.js';
import { countOf } from '../vocabulary.js';
import { word } from '../words.js';

const h = webjsx.createElement;

const loader = createPanelLoader({
    what: () => word('ui.clusters_panel_what'),
    label: () => word('ui.clusters_panel_loading'),
    fetch: fetchClusters,
    apply: (j) => { state._clusters = j; },
});

function clusterRow(c, i) {
    const loc = (c.location || []).join(', ');
    const sp = (c.species || []).join(', ');
    const sym = (c.symptoms || []).join(', ');
    const reported = (c.reported_disease_names || []).join(', ');
    return h('div', { key: i, class: 'ds-cluster-row' },
        h('div', { class: 'ds-cluster-head' },
            h('b', {}, countOf(c.count)),
            loc ? h('span', {}, word('ui.clusters_panel_near', { location: loc })) : null,
            sp ? h('span', {}, ' -- ' + sp) : null),
        sym ? h('div', { class: 'ds-cluster-sub' }, word('ui.clusters_panel_symptoms', { symptoms: sym })) : null,
        reported ? h('div', { class: 'ds-cluster-sub', title: word('ui.clusters_panel_reported_title') }, word('ui.clusters_panel_as_reported', { names: reported })) : null,
        h('div', { class: 'ds-cluster-chips' }, ...(c.members || []).map((m, j) =>
            PillButton({
                key: j, children: m.ref,
                title: (m.case_type && m.case_type !== 'unset' ? caseTypeLabel(m.case_type) + ': ' : '') + (m.subject || ''),
                onClick: () => { setActiveId(m.id); },
            }))));
}

export function ClustersPanel({ railed = false } = {}) {
    loader.ensureLoaded();
    const body = loader.slot(() => {
        const cl = (state._clusters && state._clusters.clusters) || [];
        return cl.length
            ? h('div', {}, ...cl.map(clusterRow))
            : Alert({ kind: 'info', children: word('ui.clusters_panel_none') });
    });
    if (railed) return body;
    return Panel({ children: [body] });
}
