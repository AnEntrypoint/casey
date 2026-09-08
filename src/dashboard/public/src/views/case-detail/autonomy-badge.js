// autonomy-badge.js -- autonomy mode (auto/assisted/observe) Pill plus an
// inline explanation Tooltip (ux-case-detail-autonomy-mode-explanation): what
// each mode actually does, static copy, so an operator never has to guess
// from the raw enum name.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Pill } from '/design/src/components/shell.js';
import { Tooltip } from '/design/src/components/overlay-primitives.js';
import { state } from '../../state.js';
const h = webjsx.createElement;

// The product name is the deployment's own (dashboard_ui.brand), never the
// literal 'casey', and the prose reads as prose rather than carrying the
// source tree's ASCII double-hyphen convention onto an operator's screen.
const AUTONOMY_COPY = {
    auto: '{brand} replies to the contact on its own, no review needed.',
    assisted: '{brand} drafts a reply and waits for a person to approve or discard it before it sends.',
    observe: '{brand} only logs what happens. It never replies; a person must reply by hand.',
};

export function AutonomyBadge({ autonomy, key } = {}) {
    const brand = state.config?.dashboard_ui?.brand || 'casey';
    const copy = (AUTONOMY_COPY[autonomy] || 'Who answers the contact.').replace(/\{brand\}/g, brand);
    return h('span', { key, class: 'casey-autonomy-badge' },
        Tooltip({
            content: copy,
            children: Pill({ tone: autonomy === 'auto' ? 'accent' : 'muted', children: 'Who answers: ' + autonomy })
        })
    );
}
