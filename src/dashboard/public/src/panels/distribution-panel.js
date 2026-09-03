// Distribution panel -- species/symptom counts across open cases. Content-swap
// panel (state.activePanel === 'distribution'). Bars use Rail as the bar
// primitive (no raw-color div bar chart, per architecture spec section 1).

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel, Section } from '/design/src/components/content/panel.js';
import { Spinner, Alert } from '/design/src/components/content/feedback.js';
import { Btn, Lede } from '/design/src/components/shell/atoms.js';
import { state, schedule, closePanel } from '../state.js';
import { fetchDistribution } from '../api.js';

const h = webjsx.createElement;

let loaded = false, loading = false, error = null;

function ensureLoaded() {
    if (loaded || loading) return;
    loading = true;
    fetchDistribution().then((j) => {
        state._distribution = j;
        loaded = true; loading = false; error = null; schedule();
    }).catch((e) => { loaded = true; loading = false; error = e.message || 'distribution error'; schedule(); });
}

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
    ensureLoaded();
    const back = Btn({ variant: 'ghost', children: 'Back to cases', onClick: closePanel });
    let body;
    if (loading && !loaded) body = Spinner({ label: 'loading distribution' });
    else if (error) body = Alert({ kind: 'error', children: 'Distribution error: ' + error });
    else {
        const j = state._distribution;
        const species = (j && j.species) || [], symptoms = (j && j.symptoms) || [];
        if (!species.length && !symptoms.length) body = Alert({ kind: 'info', children: 'No species or symptom data recorded yet.' });
        else {
            const maxSp = species.length ? species[0].count : 0;
            const maxSym = symptoms.length ? symptoms[0].count : 0;
            body = h('div', {},
                Lede({ children: `${j.total_cases} open case(s), ${j.cases_with_species_or_symptom} with species or symptoms recorded` }),
                species.length ? Section({ title: 'Species', children: [barRows(species, maxSp)] }) : null,
                symptoms.length ? Section({ title: 'Symptoms', children: [barRows(symptoms, maxSym)] }) : null);
        }
    }
    return Panel({ title: 'Distribution', children: [back, body] });
}
