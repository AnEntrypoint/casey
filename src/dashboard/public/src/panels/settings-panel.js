import * as webjsx from '/design/vendor/webjsx/index.js';
import { TextField } from '/design/src/components/content/fields.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { Spinner, Alert } from '/design/src/components/content/feedback.js';
import { state, schedule } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchThresholds, putThresholds } from '../api.js';
import { toast, failMsg } from '../toasts.js';

const h = webjsx.createElement;

const THRESH_META = {
    handoffMs: ['Unanswered request for a person (hours)', 'A contact asked for a real person. This is how long the team has to reply before the case is raised.'],
    escalateHandoffMs: ['Second, later deadline on that request (hours)', 'The louder deadline on the same unanswered request. Set it above the one above, or it fires first.'],
    staleMs: ['Case with no activity (hours)', 'An open case nobody has touched for this long is called going cold. 48 is two days.'],
    abandonMs: ['Half-finished intake left sitting (hours)', 'Intake started and stopped with on-site facts never gathered. Short values chase a reporter who may still be reachable.'],
    incompleteCriticalMs: ['Missing essential visit details (hours)', 'Work has started but the facts a field visit cannot proceed without are still blank.'],
    neverClosedMs: ['Marked done but never closed (hours)', 'How long a resolved case may sit unclosed. 168 is one week.'],
    unsentDraftMs: ['Unsent AI draft waiting (hours)', 'When Who answers is set to "Draft, then I send", the contact waits on a person to release the draft. This is how long that wait may run.'],
};

function hoursOf(ms) { return Math.round((ms / 3600000) * 10) / 10; }

let saving = false;
let draft = {};

const SPINNER_LABEL = 'loading settings';

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
    const patch = {};
    for (const [k, v] of Object.entries(draft)) {
        const n = parseFloat(v);
        if (!Number.isFinite(n)) {
            toast('Enter a number of hours for every deadline before saving. Nothing was saved.', 'err');
            return;
        }
        patch[k] = Math.round(n * 3600000);
    }
    saving = true; schedule();
    try {
        await putThresholds(patch);
        toast('Settings saved', 'ok');
        loader.reload();
    } catch (e) {
        toast(await failMsg(e, 'The deadlines were not saved, so the sweep is still using the previous values. Try again.'), 'err');
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
        return TextField({
            key: k, label: lab, hint: help, type: 'number', min: 0,
            value: draft[k], name: k,
            onInput: (v) => { draft[k] = v; schedule(); },
        });
    });
    return h('div', { class: 'ds-settings-panel' },
        h('p', { class: 'ds-settings-state' }, 'These are the deadlines the automatic check measures every case against. Every value is in hours: 24 is a day, 168 is a week. Decimals are allowed, so 0.5 is thirty minutes.'),
        ...rows,
        h('div', { class: 'ds-settings-actions' },
            Btn({ variant: 'primary', children: saving ? 'Saving...' : 'Save', disabled: saving, onClick: save }),
            h('span', { class: 'ds-settings-state' }, j.customized ? 'Using your tuned values' : 'Using the shipped defaults')));
}
