// Distribution panel -- species/symptom counts across open cases. Content-swap
// panel (state.activePanel === 'distribution'). Bars use Rail as the bar
// primitive (no raw-color div bar chart, per architecture spec section 1).

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel, Section } from '/design/src/components/content/panel.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { Lede } from '/design/src/components/shell/atoms.js';
import { state } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchDistribution } from '../api.js';

const h = webjsx.createElement;

const loader = createPanelLoader({
    what: 'the breakdown',
    label: 'loading distribution',
    fetch: fetchDistribution,
    apply: (j) => { state._distribution = j; },
});

function barRows(rows, max) {
    return h('div', { class: 'ds-dist-group-body' }, ...rows.map((r, i) => {
        const pct = max ? Math.round((100 * r.count) / max) : 0;
        return h('div', { key: i, class: 'ds-dist-row' },
            h('span', { class: 'ds-dist-token' }, r.token),
            h('span', { class: 'ds-dist-bar-track' }, h('span', { class: 'ds-dist-bar-fill', style: `width:${pct}%` })),
            h('span', { class: 'ds-dist-count' }, String(r.count)));
    }));
}

export function DistributionPanel() {
    loader.ensureLoaded();
    const body = loader.slot(() => {
        const j = state._distribution;
        const species = (j && j.species) || [], symptoms = (j && j.symptoms) || [];
        if (!species.length && !symptoms.length) return Alert({ kind: 'info', children: 'No species or symptom data recorded yet.' });
        const maxSp = species.length ? species[0].count : 0;
        const maxSym = symptoms.length ? symptoms[0].count : 0;
        return h('div', {},
            Lede({ children: `${j.total_cases} open case(s), ${j.cases_with_species_or_symptom} with species or symptoms recorded` }),
            species.length ? Section({ title: 'Species', children: [barRows(species, maxSp)] }) : null,
            symptoms.length ? Section({ title: 'Symptoms', children: [barRows(symptoms, maxSym)] }) : null);
    });
    return Panel({ children: [body] });
}
