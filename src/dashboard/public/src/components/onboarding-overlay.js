// OnboardingOverlay -- first-run 3-step quick-start overlay, shown once per
// browser (localStorage-gated) and reopenable from the help overlay's
// "Show me the quick start again" link. Built on dialog-shell.js's Dialog,
// not Popover/CommandPalette (those are trigger-anchored/global-shortcut
// patterns; this is an explicit full-viewport modal that must be reachable
// with no prior trigger element on first paint).

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn, Lede } from '/design/src/components/shell/atoms.js';
import { Dialog } from './dialog-shell.js';
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
        title: 'Quick start - three things',
        footer: Btn({ variant: 'primary', onClick: onClose }, 'Start working'),
        children: [
            Lede({ children: 'A new shift starts here. These three steps are all you need to begin.' }),
            h('ol', { key: 'steps', class: 'ds-onboard-steps' },
                h('li', { key: '1' }, h('b', {}, 'Pick who you are.'), ' Use the name box at the top right so every reply and claim is recorded against you.'),
                h('li', { key: '2' }, h('b', {}, 'The "Needs you now" list is your queue.'), ' It puts the cases that cannot wait at the top. Work it from the top down.'),
                h('li', { key: '3' }, h('b', {}, 'Claim a case before you reply.'), ' Claiming tells the rest of the team you have it, so two people do not answer the same person.')
            ),
            h('p', { key: 'foot', class: 'ds-dialog-foot-note' }, 'You can see this again from the ', h('b', {}, '?'), ' help, under "Show me the quick start again".')
        ]
    });
}
