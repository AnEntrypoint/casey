// autonomy-badge.js -- autonomy mode (auto/assisted/observe) Pill plus an
// inline explanation Tooltip (ux-case-detail-autonomy-mode-explanation): what
// each mode actually does, static copy, so an operator never has to guess
// from the raw enum name.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Pill } from '/design/src/components/shell.js';
import { Tooltip } from '/design/src/components/overlay-primitives.js';
const h = webjsx.createElement;

const AUTONOMY_COPY = {
    auto: 'casey replies to the contact on its own, no review needed.',
    assisted: 'casey drafts a reply and waits for a person to approve or discard it before it sends.',
    observe: 'casey only logs what happens -- it never replies. A person must reply by hand.',
};

export function AutonomyBadge({ autonomy, key } = {}) {
    const copy = AUTONOMY_COPY[autonomy] || 'Who answers the contact.';
    return h('span', { key, class: 'casey-autonomy-badge' },
        Tooltip({
            content: copy,
            children: Pill({ tone: autonomy === 'auto' ? 'accent' : 'muted', children: 'Who answers: ' + autonomy })
        })
    );
}
