// progress.js -- stage progress indicator (ux-case-detail-progress-indicator).
// A horizontal step sequence across the case's thatcher workflow `status`
// (new/triaging/in_progress/waiting/resolved/closed), current stage
// highlighted, simple-mode relabeling applied via stageLabel(). Reuses the
// design system's Dot/Rail primitives rather than inventing a bespoke
// stepper shape.
//
// WHY THIS RAIL SURVIVED A SWEEP THAT CUT EVERY CHIP AROUND IT. It is not a
// status label wearing a shape. Six named stages in order, with one marked,
// says both where the report is AND how much is left after it -- and the
// second half is the part no sentence says without listing the sequence out
// loud anyway. The stage chip that used to sit in the heading said only the
// first half, in a second vocabulary, two lines above this; that one went.
//
// THE 'unknown' RAIL WENT TOO, and it was the real defect here. A case whose
// status is not in the pipeline at all -- a deleted one, or a stage a
// deployment added to thatcher.config.yml -- rendered six identical grey dots
// labelled New..Closed with NO mark anywhere: a progress indicator that
// silently indicates nothing, on the one case where the operator most needs
// telling that something unusual is true. It now says the stage in words
// instead of drawing a rail it cannot honestly position anybody on.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Dot } from '/design/src/components/shell.js';
import { stageLabel } from '../../format.js';
const h = webjsx.createElement;

const PIPELINE = ['new', 'triaging', 'in_progress', 'waiting', 'resolved', 'closed'];

export function CaseProgress({ status, key } = {}) {
    const idx = PIPELINE.indexOf(status);
    if (idx < 0) {
        return h('p', { key, class: 'casey-progress-offpipeline casey-hint' },
            status
                ? 'This report is at ' + stageLabel(status) + ', which is not one of the usual stages.'
                : 'This report has no stage recorded.');
    }
    return h('div', { key, class: 'casey-progress', role: 'group', 'aria-label': 'case stage progress' },
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
