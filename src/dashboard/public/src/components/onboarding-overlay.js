import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn, Lede } from '/design/src/components/shell/atoms.js';
import { Dialog } from './dialog-shell.js';
import { queueName } from '../map-model.js';
import { word } from '../words.js';
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
        title: word('ui.onboarding_title'),
        footer: Btn({ variant: 'primary', onClick: onClose, children: word('ui.onboarding_start') }),
        children: [
            Lede({ children: word('ui.onboarding_lede') }),
            h('ol', { key: 'steps', class: 'ds-onboard-steps' },
                h('li', { key: '1' }, h('b', {}, word('ui.onboarding_step1_open', { queue: queueName() })), word('ui.onboarding_step1_body')),
                h('li', { key: '2' }, h('b', {}, word('ui.onboarding_step2_press')), word('ui.onboarding_step2_body')),
                h('li', { key: '3' }, h('b', {}, word('ui.onboarding_step3_title')), word('ui.onboarding_step3_body'))
            ),
            h('p', { key: 'foot', class: 'ds-dialog-foot-note' }, word('ui.onboarding_foot_1'), h('b', {}, '?'), word('ui.onboarding_foot_2'))
        ]
    });
}
