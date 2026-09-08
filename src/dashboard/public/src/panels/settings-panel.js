// Settings panel -- tunable health thresholds, plain-language labels. Rendered
// inside dialog-shell's Dialog as a modal (state.activeModal === 'settings'),
// per architecture spec section 4 (ux-settings-panel-displaces-queue: this is
// an overlay now, it can never push the case queue down again).

import * as webjsx from '/design/vendor/webjsx/index.js';
import { TextField } from '/design/src/components/content/fields.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { Spinner, Alert } from '/design/src/components/content/feedback.js';
import { state, schedule } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchThresholds, putThresholds } from '../api.js';
import { toast } from '../toasts.js';

const h = webjsx.createElement;

// Every one of these seven knobs is entered and stored in HOURS -- the field
// converts to and from milliseconds on the way in and out (hoursOf/save), and
// every label says so, because "48" with no unit beside it is a number nobody
// can safely change on a live escalation threshold.
//
// The unit is HOURS for all seven, checked against case-health.js's
// DEFAULT_THRESHOLDS rather than assumed: handoffMs 4h, escalateHandoffMs 12h,
// staleMs 48h, abandonMs 24h, incompleteCriticalMs 8h, neverClosedMs 7 days
// (168h), unsentDraftMs 1h. thresholds.js clamps each one to its own range on
// the way in, so a typo is refused rather than stored.
//
// Each helper says what that ONE threshold changes. Four of them used to be
// the same sentence reworded, all ending in flagged/flagging, which told an
// operator nothing about which of the four to touch.
const THRESH_META = {
    handoffMs: ['Unanswered request for a person (hours)', 'A contact asked for a real person. This is how long the team has to reply before the case is raised.'],
    escalateHandoffMs: ['Escalated unanswered handoff (hours)', 'The second, louder deadline on that same request. Set it above the one above, or it fires first.'],
    staleMs: ['Case with no activity (hours)', 'An open case nobody has touched for this long is called going cold. 48 is two days.'],
    abandonMs: ['Half-finished intake left sitting (hours)', 'Intake started and stopped with on-site facts never gathered. Short values chase a reporter who may still be reachable.'],
    incompleteCriticalMs: ['Missing essential visit details (hours)', 'Work has started but the facts a field visit cannot proceed without are still blank.'],
    neverClosedMs: ['Marked done but never closed (hours)', 'How long a resolved case may sit unclosed. 168 is one week.'],
    unsentDraftMs: ['Unsent AI draft waiting (hours)', 'In assisted mode the contact waits on a person to release the draft. This is how long that wait may run.'],
};

// Milliseconds in, hours on screen: one decimal place, so 90 minutes reads
// 1.5 rather than rounding away to 2.
function hoursOf(ms) { return Math.round((ms / 3600000) * 10) / 10; }

let saving = false;
let draft = {}; // key -> hours string, edited locally before Save

const SPINNER_LABEL = 'loading settings';

// This panel is its own shell rather than a body inside a Panel, so it reads
// the loader's state directly instead of going through slot() -- the skeleton
// and the failure sentence are the whole modal here, not a slot inside one.
const loader = createPanelLoader({
    what: 'the settings',
    label: SPINNER_LABEL,
    fetch: fetchThresholds,
    apply: (j) => {
        state._thresholds = j;
        draft = {};
        for (const k of Object.keys(THRESH_META)) {
            if (j.thresholds && j.thresholds[k] != null) draft[k] = String(hoursOf(j.thresholds[k]));
        }
    },
});

async function save() {
    saving = true; schedule();
    const patch = {};
    for (const [k, v] of Object.entries(draft)) {
        const n = parseFloat(v);
        if (Number.isFinite(n)) patch[k] = Math.round(n * 3600000);
    }
    try {
        await putThresholds(patch);
        toast('Settings saved', 'ok');
        // The server clamps and merges what it was sent, so what it now holds
        // is not necessarily what was typed -- re-read rather than assume the
        // draft on screen is what was stored.
        loader.reload();
    } catch (e) {
        toast('Save failed: ' + (e.message || ''), 'err');
    }
    saving = false; schedule();
}

export function SettingsPanel() {
    loader.ensureLoaded();
    if (loader.pending()) return Spinner({ label: SPINNER_LABEL });
    const err = loader.error();
    if (err) return Alert({ kind: 'error', children: err });
    const j = state._thresholds || {};
    const rows = Object.keys(THRESH_META).filter((k) => draft[k] !== undefined).map((k) => {
        const [lab, help] = THRESH_META[k];
        return h('div', { key: k, class: 'ds-settings-row' },
            TextField({
                key: 'f', label: lab, hint: help, type: 'number', min: 0,
                value: draft[k], name: k,
                onInput: (v) => { draft[k] = v; schedule(); },
            }));
    });
    return h('div', { class: 'ds-settings-panel' },
        h('p', { class: 'ds-settings-state' }, 'These are the deadlines the guardrail sweep checks every case against. Every value is in hours: 24 is a day, 168 is a week. Decimals are allowed, so 0.5 is thirty minutes.'),
        ...rows,
        h('div', { class: 'ds-settings-actions' },
            Btn({ variant: 'primary', children: saving ? 'Saving...' : 'Save', disabled: saving, onClick: save }),
            h('span', { class: 'ds-settings-state' }, j.customized ? 'Using your tuned values' : 'Using the shipped defaults')));
}
