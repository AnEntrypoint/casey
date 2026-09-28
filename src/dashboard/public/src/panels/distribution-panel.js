// Distribution panel -- species/symptom counts across open cases. Content-swap
// panel (state.activePanel === 'distribution'). Bars are the kit's BarChart.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel, Section } from '/design/src/components/content/panel.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { BarChart } from '/design/src/components/content/charts.js';
import { Lede } from '/design/src/components/shell/atoms.js';
import { state } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchDistribution } from '../api.js';
import { countOf, entityLabel, entityLabelPlural } from '../vocabulary.js';

const h = webjsx.createElement;

const loader = createPanelLoader({
    what: 'the breakdown',
    label: 'loading distribution',
    fetch: fetchDistribution,
    apply: (j) => { state._distribution = j; },
});

// The kit's BarChart scales each bar against the largest value in its own set,
// which is exactly the per-group max the rows below are already sorted by.
function barRows(rows) {
    return BarChart({ items: rows.map((r) => ({ label: r.token, value: r.count })) });
}

export function DistributionPanel() {
    loader.ensureLoaded();
    const body = loader.slot(() => {
        const j = state._distribution;
        const species = (j && j.species) || [], symptoms = (j && j.symptoms) || [];
        if (!species.length && !symptoms.length) return Alert({ kind: 'info', children: 'No species or symptom data recorded yet.' });
        return h('div', {},
            Lede({ children: `${countOf(j.total_cases, 'open ' + entityLabel(), 'open ' + entityLabelPlural())}, ${j.cases_with_species_or_symptom} with species or symptoms recorded` }),
            species.length ? Section({ title: 'Species', children: [barRows(species)] }) : null,
            symptoms.length ? Section({ title: 'Symptoms', children: [barRows(symptoms)] }) : null);
    });
    return Panel({ children: [body] });
}
