// SkillsOverlay -- per-operator 3-item skills checklist. Distinct from
// OnboardingOverlay (one-per-browser quick start): this tracks, PER
// OPERATOR, whether they have learned the three shift-speed moves. State is
// a localStorage map keyed by operator id (or a "default" bucket before
// anyone is picked) so a shared machine does not leak one person's progress
// onto the next. Dismissed or fully ticked, it does not reappear.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn, Lede } from '/design/src/components/shell/atoms.js';
import { Icon } from '/design/src/components/shell/icons.js';
import { Dialog } from './dialog-shell.js';
const h = webjsx.createElement;

export const SKILLS = [
    { id: 'keys', label: 'Keyboard triage: j and k move through the list, Enter opens, c claims, e jumps to the reply box.' },
    { id: 'mine', label: 'The Mine filter shows only the cases you have claimed -- pick who you are top-right, then press Mine.' },
    { id: 'draft', label: 'In assisted mode a reply waits as a draft until you approve it -- open the case and use Send draft or Discard.' },
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

export function dismissSkills(operatorId) {
    const m = loadSkills(operatorId);
    m.__dismissed = true;
    saveSkills(operatorId, m);
}

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
        title: 'Getting the hang of it',
        footer: Btn({ onClick: onClose, children: 'Close' }),
        children: [
            Lede({ children: 'A short checklist of the three moves that make a shift fast. Tick each one as you learn it -- this is just for you, kept on this device, and it will not nag you again once you finish or close it.' }),
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
            h('p', { key: 'foot', class: 'ds-dialog-foot-note' }, 'Reopen this any time from the ', h('b', {}, '?'), ' help.')
        ]
    });
}
