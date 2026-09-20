// snooze-dialog.js -- minutes-from-now snooze prompt, wired from
// header.js's Snooze button. A needs-human case is never hidden, even
// snoozed (server-enforced; this dialog only collects the duration).

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn } from '/design/src/components/shell.js';
import { TextField } from '/design/src/components/content.js';
import { Dialog } from '../../components/dialog-shell.js';
import { state, schedule } from '../../state.js';
import { toast, failMsg } from '../../toasts.js';
import { postSnooze } from '../../api.js';
import { entityLabel } from '../../vocabulary.js';
import { QUEUE_NAME } from '../../map-model.js';
const h = webjsx.createElement;

export function openSnoozeDialog(c) { state._snoozeDialogFor = c.id; state._snoozeMinutes = ''; schedule(); }

export function SnoozeDialog({ onReload, key } = {}) {
    const caseId = state._snoozeDialogFor;
    const open = !!caseId;
    const close = () => { state._snoozeDialogFor = null; schedule(); };
    const confirm = async () => {
        const minutes = parseInt(state._snoozeMinutes, 10);
        if (!Number.isFinite(minutes) || minutes <= 0) { toast('Enter a positive number of minutes', 'warn'); return; }
        try {
            await postSnooze(caseId, minutes);
            toast('Snoozed. It is out of the "' + QUEUE_NAME + '" list until then.');
            close();
            if (onReload) await onReload(caseId);
        } catch (e) { toast(await failMsg(e, 'The snooze was not set, so this is still in the "' + QUEUE_NAME + '" list. Try again.'), 'warn'); }
    };
    return Dialog({
        key, open, title: 'Snooze this ' + entityLabel(), onClose: close,
        children: !open ? null : [
            // QUEUE_NAME, not a hand-typed copy of it: map-model.js owns the
            // list's one name precisely so a dialog cannot drift from it.
            h('p', { key: 'lead' }, 'Hide it from the "' + QUEUE_NAME + '" list for a while without losing it. A ' + entityLabel() + ' where someone asked for a person is never hidden, even snoozed.'),
            TextField({ key: 'minutes', label: 'Minutes from now (e.g. 60 for 1 hour, 1440 for a day)', type: 'number', value: state._snoozeMinutes || '', placeholder: '240', onInput: (v) => { state._snoozeMinutes = v; schedule(); } }),
            h('div', { key: 'acts', class: 'ds-dialog-actions' },
                Btn({ key: 'cancel', variant: 'ghost', children: 'Cancel', onClick: close }),
                Btn({ key: 'ok', variant: 'primary', children: 'Snooze', onClick: confirm })
            )
        ]
    });
}
