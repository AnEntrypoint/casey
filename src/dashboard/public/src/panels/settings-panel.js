import * as webjsx from '/design/vendor/webjsx/index.js';
import { TextField } from '/design/src/components/content/fields.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { Spinner, Alert } from '/design/src/components/content/feedback.js';
import { state, schedule } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchThresholds, putThresholds } from '../api.js';
import { toast, failMsg } from '../toasts.js';
import { word } from '../words.js';

const h = webjsx.createElement;

const THRESH_META = {
    handoffMs: ['ui.settings_panel_handoff_label', 'ui.settings_panel_handoff_hint'],
    escalateHandoffMs: ['ui.settings_panel_escalate_label', 'ui.settings_panel_escalate_hint'],
    staleMs: ['ui.settings_panel_stale_label', 'ui.settings_panel_stale_hint'],
    abandonMs: ['ui.settings_panel_abandon_label', 'ui.settings_panel_abandon_hint'],
    incompleteCriticalMs: ['ui.settings_panel_critical_label', 'ui.settings_panel_critical_hint'],
    neverClosedMs: ['ui.settings_panel_never_closed_label', 'ui.settings_panel_never_closed_hint'],
    unsentDraftMs: ['ui.settings_panel_draft_label', 'ui.settings_panel_draft_hint'],
};

function hoursOf(ms) { return Math.round((ms / 3600000) * 10) / 10; }

let saving = false;
let draft = {};

const loader = createPanelLoader({
    what: () => word('ui.settings_panel_what'),
    label: () => word('ui.settings_panel_loading'),
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
            toast(word('ui.settings_panel_invalid_hours'), 'err');
            return;
        }
        patch[k] = Math.round(n * 3600000);
    }
    saving = true; schedule();
    try {
        await putThresholds(patch);
        toast(word('ui.settings_panel_saved'), 'ok');
        loader.reload();
    } catch (e) {
        toast(await failMsg(e, word('ui.settings_panel_save_failed')), 'err');
    }
    saving = false; schedule();
}

export function SettingsPanel() {
    loader.ensureLoaded();
    if (loader.pending()) return Spinner({ label: word('ui.settings_panel_loading') });
    const err = loader.error();
    if (err) return Alert({ kind: 'error', children: err });
    const j = state._thresholds || {};
    const rows = Object.keys(THRESH_META).filter((k) => draft[k] !== undefined).map((k) => {
        const [labKey, helpKey] = THRESH_META[k];
        return TextField({
            key: k, label: word(labKey), hint: word(helpKey), type: 'number', min: 0,
            value: draft[k], name: k,
            onInput: (v) => { draft[k] = v; schedule(); },
        });
    });
    return h('div', { class: 'ds-settings-panel' },
        h('p', { class: 'ds-settings-state' }, word('ui.settings_panel_intro')),
        ...rows,
        h('div', { class: 'ds-settings-actions' },
            Btn({ variant: 'primary', children: saving ? word('ui.settings_panel_saving') : word('ui.settings_panel_save'), disabled: saving, onClick: save }),
            h('span', { class: 'ds-settings-state' }, j.customized ? word('ui.settings_panel_tuned') : word('ui.settings_panel_defaults'))));
}
