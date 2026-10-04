import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn, Lede } from '/design/src/components/shell/atoms.js';
import { Checkbox } from '/design/src/components/form-primitives.js';
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
    try { localStorage.setItem(skillsKey(operatorId), JSON.stringify(o)); } catch {  }
}

export function skillsDone(o) { return SKILLS.every((s) => o[s.id]); }
export function skillsDismissed(operatorId) { return loadSkills(operatorId).__dismissed === true; }


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
            h('div', { key: 'list', role: 'group', 'aria-label': 'Skills checklist' },
                ...SKILLS.map((s) => Checkbox({ key: s.id, checked: !!state[s.id], label: s.label, onChange: () => toggle(s.id) }))),
            h('p', { key: 'foot', class: 'ds-dialog-foot-note' }, 'Nothing here changes what you can do, only how many steps it takes.')
        ]
    });
}
