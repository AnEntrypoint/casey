import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn } from '/design/src/components/shell.js';
import { TextField } from '/design/src/components/content.js';
import { Dialog } from '../../components/dialog-shell.js';
import { state, schedule } from '../../state.js';
import { toast, failMsg } from '../../toasts.js';
import { fetchCaseEvents, postSplit } from '../../api.js';
import { entityLabel } from '../../vocabulary.js';
import { word } from '../../words.js';
const h = webjsx.createElement;

const SPLIT_KIND_KEY = {
    inbound: 'ui.split_dialog_kind_reporter',
    outbound: 'ui.split_dialog_kind_reply',
    note: 'ui.split_dialog_kind_note',
    observation: 'ui.split_dialog_kind_observation',
};

function loadSplitEvents(caseId) {
    state._splitError = false;
    state._splitEvents = null;
    schedule();
    fetchCaseEvents(caseId, { limit: '200' }).then(r => {
        state._splitEvents = (r.events || []).filter(e => ['inbound', 'outbound', 'note', 'observation'].includes(e.kind));
        schedule();
    }).catch(() => { state._splitError = true; state._splitEvents = []; schedule(); });
}

function openSplitDialog(caseId) {
    state._splitDialogFor = caseId;
    state._splitSelected = new Set();
    state._splitSubject = '';
    state._splitReason = '';
    loadSplitEvents(caseId);
}

export function SplitDialogTrigger({ caseId, key } = {}) {
    return Btn({ key, size: 'sm', variant: 'ghost', children: word('ui.split_dialog_trigger'), onClick: () => openSplitDialog(caseId) });
}

export function SplitDialog({ onReload, key } = {}) {
    const caseId = state._splitDialogFor;
    const open = !!caseId;
    const events = state._splitEvents;
    const selected = state._splitSelected || new Set();

    const close = () => { state._splitDialogFor = null; schedule(); };
    const toggle = (id) => { if (selected.has(id)) selected.delete(id); else selected.add(id); schedule(); };

    const confirm = async () => {
        const event_ids = [...selected];
        if (!event_ids.length) { toast(word('ui.split_dialog_positive'), 'warn'); return; }
        try {
            const sj = await postSplit(caseId, event_ids, (state._splitSubject || '').trim(), (state._splitReason || '').trim());
            toast(word('ui.split_dialog_done', { moved: sj.moved_events, entity: entityLabel(), ref: sj.new_case_ref }), 'ok');
            close();
            if (onReload) await onReload(caseId);
        } catch (e) { toast(await failMsg(e, word('ui.split_dialog_failed', { entity: entityLabel() })), 'err'); }
    };

    return Dialog({
        key, open, title: word('ui.split_dialog_title', { entity: entityLabel() }), wide: true, onClose: close,
        children: !open ? null : [
            h('p', { key: 'lead', class: 'casey-hint' }, word('ui.split_dialog_lead', { entity: entityLabel() })),
            TextField({ key: 'subj', label: word('ui.split_dialog_subject_label', { entity: entityLabel() }), value: state._splitSubject || '', placeholder: word('ui.split_dialog_subject_placeholder'), onInput: (v) => { state._splitSubject = v; schedule(); } }),
            h('div', { key: 'evbox', class: 'casey-split-evbox' },
                events == null ? h('div', { class: 'casey-hint' }, word('ui.split_dialog_loading')) :
                    state._splitError ? [
                        h('div', { key: 'err', class: 'casey-hint' }, word('ui.split_dialog_load_failed')),
                        Btn({ key: 'retry', size: 'sm', variant: 'ghost', children: word('ui.split_dialog_retry'), onClick: () => loadSplitEvents(caseId) }),
                    ] :
                    !events.length ? h('div', { class: 'casey-hint' }, word('ui.split_dialog_nothing', { entity: entityLabel() })) :
                        events.map(e => h('label', { key: e.id, class: 'casey-split-row' },
                            h('input', { type: 'checkbox', checked: selected.has(e.id), onchange: () => toggle(e.id) }),
                            h('span', {}, SPLIT_KIND_KEY[e.kind] ? word(SPLIT_KIND_KEY[e.kind]) : e.kind, ': ', (e.text || '').slice(0, 120))
                        ))
            ),
            TextField({ key: 'reason', label: word('ui.split_dialog_reason_label'), multiline: true, rows: 2, value: state._splitReason || '', placeholder: word('ui.split_dialog_reason_placeholder'), onInput: (v) => { state._splitReason = v; schedule(); } }),
            h('div', { key: 'acts', class: 'ds-dialog-actions' },
                Btn({ key: 'cancel', variant: 'ghost', children: word('ui.split_dialog_cancel'), onClick: close }),
                Btn({ key: 'ok', variant: 'primary', children: word('ui.split_dialog_confirm', { entity: entityLabel() }), onClick: confirm })
            )
        ]
    });
}
