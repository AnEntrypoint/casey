// transitions.js -- stage transition buttons + reason dialog (a small
// Popover-based form, sharing dialog-shell.js's modal pattern for the
// dialog chrome itself).

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn } from '/design/src/components/shell.js';
import { TextField } from '/design/src/components/content.js';
import { Dialog } from '../../components/dialog-shell.js';
import { state, schedule } from '../../state.js';
import { toast, undoToast, failMsg } from '../../toasts.js';
import { postTransition } from '../../api.js';
import { stageLabel } from '../../format.js';
const h = webjsx.createElement;

const CASEY_NOTIFIED_STAGES = ['in_progress', 'waiting', 'resolved'];

export function Transitions({ c, transitions, onReload, key } = {}) {
    const open = state._transitionDialogFor === c.id;
    const target = state._transitionDialogTarget;
    const reason = state._transitionReason || '';

    const openFor = (to) => { state._transitionDialogFor = c.id; state._transitionDialogTarget = to; state._transitionReason = ''; schedule(); };
    const close = () => { state._transitionDialogFor = null; schedule(); };

    const confirm = async () => {
        try {
            const updated = await postTransition(c.id, target, reason || undefined);
            close();
            undoToast(c.id, CASEY_NOTIFIED_STAGES.includes(updated.status) ? 'Moved to ' + stageLabel(target) + '. A short note was queued to the contact.' : 'Moved to ' + stageLabel(target) + '. The contact was not told.');
            if (onReload) await onReload(c.id);
        } catch (e) { toast(await failMsg(e, 'transition failed'), 'err'); }
    };

    return h('div', { key, class: 'casey-transitions' },
        h('label', {}, state.simpleMode ? 'Change the stage' : 'Override workflow stage'),
        transitions && transitions.length
            ? h('div', { class: 'casey-transition-btns' }, ...transitions.map(t => Btn({
                key: t, size: 'sm', variant: 'ghost', children: '-> ' + stageLabel(t), title: t,
                onClick: () => openFor(t)
            })))
            : h('span', { class: 'casey-hint' }, 'no transitions available'),
        Dialog({
            open, title: 'Move to: ' + (target ? stageLabel(target) : ''), onClose: close,
            children: [
                TextField({ key: 'reason', label: 'Reason (optional)', multiline: true, rows: 2, value: reason, placeholder: 'e.g. operator contacted farmer directly', onInput: (v) => { state._transitionReason = v; schedule(); } }),
                h('div', { key: 'acts', class: 'casey-dialog-actions' },
                    Btn({ key: 'cancel', variant: 'ghost', children: 'Cancel', onClick: close }),
                    Btn({ key: 'ok', variant: 'primary', children: 'Move case', onClick: confirm })
                )
            ]
        })
    );
}
