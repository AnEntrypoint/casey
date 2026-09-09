// OnboardingOverlay -- the first thing a new operator sees, shown once per
// browser (localStorage-gated) and reopenable from the help overlay's "Show
// me the first-shift steps again" link. Built on dialog-shell.js's Dialog,
// not Popover/CommandPalette (those are trigger-anchored/global-shortcut
// patterns; this is an explicit full-viewport modal that must be reachable
// with no prior trigger element on first paint).
//
// WHAT THIS IS AND WHAT SkillsOverlay IS. These two used to be the same
// overlay twice -- both three-item first-run explainers, both closing with
// "reopen from the ? help", fired one after the other at somebody's first
// login. They are now split by WHEN they are true rather than by count:
//
//   this one   -- the working loop, on your very first shift: open, claim,
//                 answer. It is per-BROWSER, it is prose, and there is
//                 nothing to tick. You read it once and start.
//   Skills     -- speed, once the loop is second nature. It is per-OPERATOR,
//                 it is a checklist you tick as you learn each move, and it
//                 never claims to teach the job.
//
// Neither one repeats the other's content and neither one is a summary of the
// help card. Keep it that way: if a line here would also be true on the other
// screen, it belongs on exactly one of them.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn, Lede } from '/design/src/components/shell/atoms.js';
import { Dialog } from './dialog-shell.js';
import { QUEUE_NAME } from '../map-model.js';
const h = webjsx.createElement;

const KEY = 'casey_onboarded';

export function onboarded() {
    try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function markOnboarded() {
    try { localStorage.setItem(KEY, '1'); } catch { /* private browsing / quota: never blocks close */ }
}

/**
 * @param {Object} props
 * @param {boolean} props.open
 * @param {Function} props.onClose - called on dismiss; caller marks onboarded() and re-schedules.
 */
export function OnboardingOverlay({ open, onClose } = {}) {
    return Dialog({
        open, onClose,
        id: 'onboarding',
        title: 'Your first shift',
        footer: Btn({ variant: 'primary', onClick: onClose, children: 'Start working' }),
        children: [
            Lede({ children: 'The whole job is one loop, repeated. Work the top of the list down.' }),
            h('ol', { key: 'steps', class: 'ds-onboard-steps' },
                h('li', { key: '1' }, h('b', {}, `Open the top of the "${QUEUE_NAME}" list.`), ' It is the list beside the map. The report that needs somebody most is always at the top, and the line under each one says why it is there.'),
                h('li', { key: '2' }, h('b', {}, 'Press Claim.'), ' It is the first button on the open report. Claiming puts your name on it so nobody else answers the same person, and the button is replaced by the word Yours.'),
                h('li', { key: '3' }, h('b', {}, 'Answer, then move the stage.'), ' Type in the reply box and press Send reply. A note comes back saying whether it reached the person, so read it rather than assuming. When you are finished with the report, use the arrow buttons under Change the stage, such as -> Done.')
            ),
            h('p', { key: 'foot', class: 'ds-dialog-foot-note' }, 'Your name comes from the account you signed in with; there is nothing to pick. For everything else on this screen, press ', h('b', {}, '?'), ' at any time.')
        ]
    });
}
