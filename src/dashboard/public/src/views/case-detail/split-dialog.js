// split-dialog.js -- split-case dialog: pick events to move into a new case,
// optional subject/reason, POST /api/cases/:id/split. Ported behavior from
// the legacy showSplitDialog(), rebuilt on dialog-shell.js's Dialog.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn } from '/design/src/components/shell.js';
import { TextField } from '/design/src/components/content.js';
import { Dialog } from '../../components/dialog-shell.js';
import { state, schedule } from '../../state.js';
import { toast, failMsg } from '../../toasts.js';
import { fetchCaseEvents, postSplit } from '../../api.js';
const h = webjsx.createElement;

function openSplitDialog(caseId) {
    state._splitDialogFor = caseId;
    state._splitSelected = new Set();
    state._splitSubject = '';
    state._splitReason = '';
    state._splitEvents = null;
    schedule();
    fetchCaseEvents(caseId, { limit: '200' }).then(r => {
        state._splitEvents = (r.events || []).filter(e => ['inbound', 'outbound', 'note', 'observation'].includes(e.kind));
        schedule();
    }).catch(() => { state._splitEvents = []; schedule(); });
}

export function SplitDialogTrigger({ caseId, key } = {}) {
    return Btn({ key, size: 'sm', variant: 'ghost', children: 'Split', onClick: () => openSplitDialog(caseId) });
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
        if (!event_ids.length) { toast('Select at least one event to move', 'warn'); return; }
        try {
            const sj = await postSplit(caseId, event_ids, (state._splitSubject || '').trim(), (state._splitReason || '').trim());
            toast('split: new case ' + sj.new_case_ref + ' (' + sj.moved_events + ' events moved)', 'ok');
            close();
            if (onReload) await onReload(caseId);
        } catch (e) { toast(await failMsg(e, 'split failed'), 'err'); }
    };

    return Dialog({
        key, open, title: 'Split case', wide: true, onClose: close,
        children: !open ? null : [
            h('p', { key: 'lead', class: 'casey-hint' }, 'Select events to move into a new case. The rest stay here.'),
            TextField({ key: 'subj', label: 'Subject for new case (optional)', value: state._splitSubject || '', placeholder: 'e.g. sheep Upington outbreak', onInput: (v) => { state._splitSubject = v; schedule(); } }),
            h('div', { key: 'evbox', class: 'casey-split-evbox' },
                events == null ? h('div', { class: 'casey-hint' }, 'Loading...') :
                    !events.length ? h('div', { class: 'casey-hint' }, 'no events to split off') :
                        events.map(e => h('label', { key: e.id, class: 'casey-split-row' },
                            h('input', { type: 'checkbox', checked: selected.has(e.id), onchange: () => toggle(e.id) }),
                            h('span', {}, '[' + e.kind + '] ' + (e.text || '').slice(0, 120))
                        ))
            ),
            TextField({ key: 'reason', label: 'Reason (optional)', multiline: true, rows: 2, value: state._splitReason || '', placeholder: 'e.g. different species, separate location', onInput: (v) => { state._splitReason = v; schedule(); } }),
            h('div', { key: 'acts', class: 'ds-dialog-actions' },
                Btn({ key: 'cancel', variant: 'ghost', children: 'Cancel', onClick: close }),
                Btn({ key: 'ok', variant: 'primary', children: 'Split case', onClick: confirm })
            )
        ]
    });
}
