import * as webjsx from '/design/vendor/webjsx/index.js';
import { Dot } from '/design/src/components/shell.js';
import { stageLabel } from '../../format.js';
import { entityLabel } from '../../vocabulary.js';
import { word } from '../../words.js';
const h = webjsx.createElement;

const PIPELINE = ['new', 'triaging', 'in_progress', 'waiting', 'resolved', 'closed'];

export function CaseProgress({ status, key } = {}) {
    const idx = PIPELINE.indexOf(status);
    if (idx < 0) {
        return h('p', { key, class: 'casey-progress-offpipeline casey-hint' },
            status
                ? word('ui.progress_off_stage', { entity: entityLabel(), stage: stageLabel(status) })
                : word('ui.progress_no_stage', { entity: entityLabel() }));
    }
    return h('div', { key, class: 'casey-progress', role: 'group', 'aria-label': word('ui.progress_group', { entity: entityLabel() }) },
        ...PIPELINE.map((s, i) => {
            const state = i < idx ? 'done' : (i === idx ? 'active' : 'pending');
            return h('div', { key: s, class: 'casey-progress-step casey-progress-step--' + state },
                h('span', { class: 'casey-progress-dot casey-progress-dot--' + state }, Dot({ tone: state === 'active' || state === 'done' ? 'on' : 'off' })),
                h('span', { class: 'casey-progress-label' }, stageLabel(s)),
                i < PIPELINE.length - 1 ? h('span', { class: 'casey-progress-line', 'aria-hidden': 'true' }) : null
            );
        })
    );
}
