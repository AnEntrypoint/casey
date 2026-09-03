// Settings panel -- tunable health thresholds, plain-language labels. Rendered
// inside dialog-shell's Dialog as a modal (state.activeModal === 'settings'),
// per architecture spec section 4 (ux-settings-panel-displaces-queue: this is
// an overlay now, it can never push the case queue down again).

import * as webjsx from '/design/vendor/webjsx/index.js';
import { TextField } from '/design/src/components/content/fields.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { Spinner, Alert } from '/design/src/components/content/feedback.js';
import { state, schedule } from '../state.js';
import { fetchThresholds, putThresholds } from '../api.js';
import { toast } from '../toasts.js';

const h = webjsx.createElement;

// Every label below is a noun-phrase naming the condition being timed (not
// a mixed instruction/fragment/question) so the set reads as one
// consistent labeling convention.
const THRESH_META = {
    handoffMs: ['Unanswered request for a person', 'How long to wait before flagging that nobody has stepped in yet.'],
    escalateHandoffMs: ['Escalated unanswered handoff', 'After this long with no human reply, the case is raised more urgently.'],
    staleMs: ['Case with no activity', 'How long a case can go quiet before it is flagged as going stale.'],
    abandonMs: ['Half-finished intake left sitting', 'A case that started but never finished gathering details is flagged after this.'],
    incompleteCriticalMs: ['Missing essential visit details', 'How long an actionable case may lack must-have fields before flagging.'],
    neverClosedMs: ['Case open far too long', 'A case still open past this is surfaced as overdue.'],
    unsentDraftMs: ['Unsent AI draft waiting', 'How long an assisted draft can wait for an operator before it is flagged.'],
};

function hoursOf(ms) { return Math.round((ms / 3600000) * 10) / 10; }

let loaded = false, loading = false, saving = false, error = null;
let draft = {}; // key -> hours string, edited locally before Save

function ensureLoaded() {
    if (loaded || loading) return;
    loading = true;
    fetchThresholds().then((j) => {
        state._thresholds = j;
        draft = {};
        for (const k of Object.keys(THRESH_META)) {
            if (j.thresholds && j.thresholds[k] != null) draft[k] = String(hoursOf(j.thresholds[k]));
        }
        loaded = true; loading = false; error = null; schedule();
    }).catch((e) => { loaded = true; loading = false; error = e.message || 'settings error'; schedule(); });
}

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
        loaded = false; ensureLoaded();
    } catch (e) {
        toast('Save failed: ' + (e.message || ''), 'err');
    }
    saving = false; schedule();
}

export function SettingsPanel() {
    ensureLoaded();
    if (loading && !loaded) return Spinner({ label: 'loading settings' });
    if (error) return Alert({ kind: 'error', children: 'Settings error: ' + error });
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
        ...rows,
        h('div', { class: 'ds-settings-actions' },
            Btn({ variant: 'primary', children: saving ? 'Saving...' : 'Save', disabled: saving, onClick: save }),
            h('span', { class: 'ds-settings-state' }, j.customized ? 'Using your tuned values' : 'Using the shipped defaults')));
}
