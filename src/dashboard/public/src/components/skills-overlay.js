// SkillsOverlay -- per-operator checklist of the shortcuts that make an
// already-learned shift faster. It is NOT a second onboarding: the working
// loop (open, claim, answer) is taught once, in prose, by OnboardingOverlay,
// which is per-browser and has nothing to tick. This one is per-OPERATOR --
// state is a localStorage map keyed by operator id (or a "default" bucket
// before anyone is signed in) so a shared machine does not leak one person's
// progress onto the next -- and every item is a shortcut for something the
// operator can already do the long way. Dismissed or fully ticked, it does
// not reappear.
//
// The two overlays used to be near-identical three-item first-run cards fired
// back to back at a new operator, both signing off with "reopen from the ?
// help". If an item here would also belong on the first-shift card, it is on
// the wrong screen.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn, Lede } from '/design/src/components/shell/atoms.js';
import { Icon } from '/design/src/components/shell/icons.js';
import { Dialog } from './dialog-shell.js';
const h = webjsx.createElement;

export const SKILLS = [
    { id: 'keys', label: 'Work the list without the mouse: j and k move through it, Enter opens, c claims, e jumps straight to the reply box.' },
    { id: 'mine', label: 'The "yours" filter under the list narrows it to the reports you have claimed, so you can clear your own before anyone else\'s.' },
    { id: 'focus', label: 'The Focus button in the top bar drops everything except the queue, and the button under the list brings the rest back.' },
];

function skillsKey(operatorId) { return 'casey_skills_' + (operatorId || 'default'); }

export function loadSkills(operatorId) {
    try {
        const o = JSON.parse(localStorage.getItem(skillsKey(operatorId)) || '{}');
        return (o && typeof o === 'object') ? o : {};
    } catch { return {}; }
}

export function saveSkills(operatorId, o) {
    try { localStorage.setItem(skillsKey(operatorId), JSON.stringify(o)); } catch { /* never blocks the toggle */ }
}

export function skillsDone(o) { return SKILLS.every((s) => o[s.id]); }
export function skillsDismissed(operatorId) { return loadSkills(operatorId).__dismissed === true; }


/**
 * @param {Object} props
 * @param {boolean} props.open
 * @param {string} props.operatorId
 * @param {Function} props.onClose
 * @param {Function} [props.onAllDone] - called once when every item first becomes ticked, so the caller can toast.
 */
export function SkillsOverlay({ open, operatorId, onClose, onAllDone } = {}) {
    const state = loadSkills(operatorId);
    const toggle = (id) => {
        const m = loadSkills(operatorId);
        m[id] = !m[id];
        saveSkills(operatorId, m);
        if (skillsDone(m) && onAllDone) onAllDone();
    };
    return Dialog({
        open, onClose,
        id: 'skills',
        title: 'Ways to work faster',
        footer: Btn({ onClick: onClose, children: 'Close' }),
        children: [
            Lede({ children: 'You already know the job. These are the shortcuts for doing it faster. Tick each one as you pick it up; the list is yours alone, kept on this device, and it stops appearing once you finish or close it.' }),
            h('ul', { key: 'list', class: 'ds-skills-list', role: 'group', 'aria-label': 'Skills checklist' },
                ...SKILLS.map((s) => h('li', {
                    key: s.id,
                    class: 'ds-skills-item' + (state[s.id] ? ' is-done' : ''),
                    role: 'checkbox',
                    tabindex: '0',
                    'aria-checked': state[s.id] ? 'true' : 'false',
                    onclick: () => toggle(s.id),
                    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(s.id); } },
                },
                    h('span', { class: 'ds-skills-box', 'aria-hidden': 'true' }, state[s.id] ? Icon('check', { size: 14 }) : null),
                    h('span', { class: 'ds-skills-label' }, s.label)
                ))
            ),
            h('p', { key: 'foot', class: 'ds-dialog-foot-note' }, 'Nothing here changes what you can do, only how many steps it takes.')
        ]
    });
}
