import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel, Section } from '/design/src/components/content/panel.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { BarChart } from '/design/src/components/content/charts.js';
import { Lede } from '/design/src/components/shell/atoms.js';
import { state } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchDistribution } from '../api.js';
import { countOf } from '../vocabulary.js';
import { word } from '../words.js';

const h = webjsx.createElement;

const loader = createPanelLoader({
    what: () => word('ui.distribution_panel_what'),
    label: () => word('ui.distribution_panel_loading'),
    fetch: fetchDistribution,
    apply: (j) => { state._distribution = j; },
});

function barRows(rows) {
    return BarChart({ items: rows.map((r) => ({ label: r.token, value: r.count })) });
}

export function DistributionPanel() {
    loader.ensureLoaded();
    const body = loader.slot(() => {
        const j = state._distribution;
        const species = (j && j.species) || [], symptoms = (j && j.symptoms) || [];
        if (!species.length && !symptoms.length) return Alert({ kind: 'info', children: word('ui.distribution_panel_none') });
        return h('div', {},
            Lede({ children: word('ui.distribution_panel_lede', {
                summary: countOf(j.total_cases, word('ui.distribution_panel_open_entity'), word('ui.distribution_panel_open_entity_plural')),
                count: j.cases_with_species_or_symptom,
            }) }),
            species.length ? Section({ title: word('ui.distribution_panel_species'), children: [barRows(species)] }) : null,
            symptoms.length ? Section({ title: word('ui.distribution_panel_symptoms'), children: [barRows(symptoms)] }) : null);
    });
    return Panel({ children: [body] });
}
