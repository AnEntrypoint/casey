import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn, Lede } from '/design/src/components/shell/atoms.js';
import { Checkbox } from '/design/src/components/form-primitives.js';
import { Dialog } from './dialog-shell.js';
import { word } from '../words.js';
const h = webjsx.createElement;

export const SKILLS = [
    { id: 'keys', get label() { return word('ui.skills_overlay_keys'); } },
    { id: 'mine', get label() { return word('ui.skills_overlay_mine'); } },
    { id: 'focus', get label() { return word('ui.skills_overlay_focus'); } },
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
        title: word('ui.skills_overlay_title'),
        footer: Btn({ onClick: onClose, children: word('ui.skills_overlay_close') }),
        children: [
            Lede({ children: word('ui.skills_overlay_lede') }),
            h('div', { key: 'list', role: 'group', 'aria-label': word('ui.skills_overlay_group_aria') },
                ...SKILLS.map((s) => Checkbox({ key: s.id, checked: !!state[s.id], label: s.label, onChange: () => toggle(s.id) }))),
            h('p', { key: 'foot', class: 'ds-dialog-foot-note' }, word('ui.skills_overlay_foot'))
        ]
    });
}
