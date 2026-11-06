import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn } from '/design/src/components/shell.js';
import { TextField } from '/design/src/components/content.js';
import { Dialog } from '../../components/dialog-shell.js';
import { state, schedule } from '../../state.js';
import { toast, failMsg } from '../../toasts.js';
import { postSnooze } from '../../api.js';
import { entityLabel } from '../../vocabulary.js';
import { queueName } from '../../map-model.js';
import { word } from '../../words.js';
const h = webjsx.createElement;

export function openSnoozeDialog(c) { state._snoozeDialogFor = c.id; state._snoozeMinutes = ''; schedule(); }

export function SnoozeDialog({ onReload, key } = {}) {
    const caseId = state._snoozeDialogFor;
    const open = !!caseId;
    const close = () => { state._snoozeDialogFor = null; schedule(); };
    const confirm = async () => {
        const minutes = parseInt(state._snoozeMinutes, 10);
        if (!Number.isFinite(minutes) || minutes <= 0) { toast(word('ui.snooze_dialog_positive'), 'warn'); return; }
        try {
            await postSnooze(caseId, minutes);
            toast(word('ui.snooze_dialog_done', { queue: queueName() }));
            close();
            if (onReload) await onReload(caseId);
        } catch (e) { toast(await failMsg(e, word('ui.snooze_dialog_failed', { queue: queueName() })), 'warn'); }
    };
    return Dialog({
        key, open, title: word('ui.snooze_dialog_title', { entity: entityLabel() }), onClose: close,
        children: !open ? null : [
            h('p', { key: 'lead' }, word('ui.snooze_dialog_lead', { queue: queueName(), entity: entityLabel() })),
            TextField({ key: 'minutes', label: word('ui.snooze_dialog_minutes_label'), type: 'number', value: state._snoozeMinutes || '', placeholder: word('ui.snooze_dialog_minutes_placeholder'), onInput: (v) => { state._snoozeMinutes = v; schedule(); } }),
            h('div', { key: 'acts', class: 'ds-dialog-actions' },
                Btn({ key: 'cancel', variant: 'ghost', children: word('ui.snooze_dialog_cancel'), onClick: close }),
                Btn({ key: 'ok', variant: 'primary', children: word('ui.snooze_dialog_confirm'), onClick: confirm })
            )
        ]
    });
}
