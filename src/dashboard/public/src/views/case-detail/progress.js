// progress.js -- stage progress indicator (ux-case-detail-progress-indicator).
// A horizontal step sequence across the case's thatcher workflow `status`
// (new/triaging/in_progress/waiting/resolved/closed), current stage
// highlighted, simple-mode relabeling applied via stageLabel(). Reuses the
// design system's Dot/Rail primitives rather than inventing a bespoke
// stepper shape.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Dot } from '/design/src/components/shell.js';
import { stageLabel } from '../../format.js';
const h = webjsx.createElement;

const PIPELINE = ['new', 'triaging', 'in_progress', 'waiting', 'resolved', 'closed'];

export function CaseProgress({ status, key } = {}) {
    const idx = PIPELINE.indexOf(status);
    return h('div', { key, class: 'casey-progress', role: 'group', 'aria-label': 'case stage progress' },
        ...PIPELINE.map((s, i) => {
            const state = idx < 0 ? 'unknown' : (i < idx ? 'done' : (i === idx ? 'active' : 'pending'));
            return h('div', { key: s, class: 'casey-progress-step casey-progress-step--' + state },
                h('span', { class: 'casey-progress-dot' }, Dot({ tone: state === 'active' || state === 'done' ? 'on' : 'off' })),
                h('span', { class: 'casey-progress-label' }, stageLabel(s)),
                i < PIPELINE.length - 1 ? h('span', { class: 'casey-progress-line', 'aria-hidden': 'true' }) : null
            );
        })
    );
}
