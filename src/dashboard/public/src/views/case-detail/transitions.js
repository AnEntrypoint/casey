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
import { entityLabel } from '../../vocabulary.js';
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
        } catch (e) { toast(await failMsg(e, 'The stage was not changed, so this is still at ' + stageLabel(c.status) + '. Nothing was sent to the contact -- try again.'), 'err'); }
    };

    return h('div', { key, class: 'casey-transitions' },
        h('label', {}, 'Change the stage'),
        transitions && transitions.length
            ? h('div', { class: 'casey-transition-btns' }, ...transitions.map(t => Btn({
                // title was the raw stage key ('in_progress'), so hovering a
                // button labelled "-> Working on it" explained it with the
                // database's word for the same thing.
                key: t, size: 'sm', variant: 'ghost', children: '-> ' + stageLabel(t), title: 'Move this ' + entityLabel() + ' to ' + stageLabel(t),
                onClick: () => openFor(t)
            })))
            // "no transitions available" is the API's word for it. What an
            // operator is being told is that this one has nowhere left to go,
            // which is a fact about the case, not about a transitions list.
            : h('span', { class: 'casey-hint' }, 'There is nowhere for this one to move from here.'),
        Dialog({
            open, title: target ? 'Move this to ' + stageLabel(target) : 'Move this ' + entityLabel(), onClose: close,
            children: [
                TextField({ key: 'reason', label: 'Reason (optional)', multiline: true, rows: 2, value: reason, placeholder: 'e.g. operator contacted farmer directly', onInput: (v) => { state._transitionReason = v; schedule(); } }),
                h('div', { key: 'acts', class: 'ds-dialog-actions' },
                    Btn({ key: 'cancel', variant: 'ghost', children: 'Cancel', onClick: close }),
                    // Was 'Move case'. The control this dialog belongs to is
                    // labelled "Change the stage" and the help card teaches it
                    // by that name, so the button that commits it says what it
                    // is actually moving the record TO.
                    Btn({ key: 'ok', variant: 'primary', children: target ? 'Move to ' + stageLabel(target) : 'Move', onClick: confirm })
                )
            ]
        })
    );
}
