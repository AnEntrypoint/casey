import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn, Lede } from '/design/src/components/shell/atoms.js';
import { Dialog } from './dialog-shell.js';
import { queueName } from '../map-model.js';
const h = webjsx.createElement;

const KEY = 'casey_onboarded';

export function onboarded() {
    try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function markOnboarded() {
    try { localStorage.setItem(KEY, '1'); } catch {  }
}

export function OnboardingOverlay({ open, onClose } = {}) {
    return Dialog({
        open, onClose,
        id: 'onboarding',
        title: 'Your first shift',
        footer: Btn({ variant: 'primary', onClick: onClose, children: 'Start working' }),
        children: [
            Lede({ children: 'The whole job is one loop, repeated. Work the top of the list down.' }),
            h('ol', { key: 'steps', class: 'ds-onboard-steps' },
                h('li', { key: '1' }, h('b', {}, `Open the top of the "${queueName()}" list.`), ' It is the list beside the map. The report that needs somebody most is always at the top, and the line under each one says why it is there.'),
                h('li', { key: '2' }, h('b', {}, 'Press Claim.'), ' It is the first button on the open report. Claiming puts your name on it so nobody else answers the same person, and the button is replaced by the word Yours.'),
                h('li', { key: '3' }, h('b', {}, 'Answer, then move the stage.'), ' Type in the reply box and press Send reply. A note comes back saying whether it reached the person, so read it rather than assuming. When you are finished with the report, use the arrow buttons under Change the stage, such as -> Done.')
            ),
            h('p', { key: 'foot', class: 'ds-dialog-foot-note' }, 'Your name comes from the account you signed in with; there is nothing to pick. For everything else on this screen, press ', h('b', {}, '?'), ' at any time.')
        ]
    });
}
