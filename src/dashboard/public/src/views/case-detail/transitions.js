import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn } from '/design/src/components/shell.js';
import { TextField } from '/design/src/components/content.js';
import { Dialog } from '../../components/dialog-shell.js';
import { state, schedule } from '../../state.js';
import { toast, undoToast, failMsg } from '../../toasts.js';
import { postTransition } from '../../api.js';
import { stageLabel } from '../../format.js';
import { entityLabel } from '../../vocabulary.js';
import { word } from '../../words.js';
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
            undoToast(c.id, CASEY_NOTIFIED_STAGES.includes(updated.status)
                ? word('ui.transitions_moved_notified', { stage: stageLabel(target) })
                : word('ui.transitions_moved_silent', { stage: stageLabel(target) }));
            if (onReload) await onReload(c.id);
        } catch (e) { toast(await failMsg(e, word('ui.transitions_not_changed', { stage: stageLabel(c.status) })), 'err'); }
    };

    return h('div', { key, class: 'casey-transitions' },
        h('label', {}, word('ui.transitions_label')),
        transitions && transitions.length
            ? h('div', { class: 'casey-transition-btns' }, ...transitions.map(t => Btn({
                key: t, size: 'sm', variant: 'ghost', children: word('ui.transitions_button', { stage: stageLabel(t) }),
                title: word('ui.transitions_button_title', { entity: entityLabel(), stage: stageLabel(t) }),
                onClick: () => openFor(t)
            })))
            : h('span', { class: 'casey-hint' }, word('ui.transitions_nowhere')),
        Dialog({
            open, title: target
                ? word('ui.transitions_dialog_stage', { stage: stageLabel(target) })
                : word('ui.transitions_dialog_plain', { entity: entityLabel() }), onClose: close,
            children: [
                h('p', { key: 'notice', class: 'casey-hint' }, target
                    ? (CASEY_NOTIFIED_STAGES.includes(target)
                        ? word('ui.transitions_notice_notified', { stage: stageLabel(target) })
                        : word('ui.transitions_notice_silent'))
                    : ''),
                TextField({ key: 'reason', label: word('ui.transitions_reason_label'), multiline: true, rows: 2, value: reason, placeholder: word('ui.transitions_reason_placeholder'), onInput: (v) => { state._transitionReason = v; schedule(); } }),
                h('div', { key: 'acts', class: 'ds-dialog-actions' },
                    Btn({ key: 'cancel', variant: 'ghost', children: word('ui.transitions_cancel'), onClick: close }),
                    Btn({ key: 'ok', variant: 'primary', children: target ? word('ui.transitions_move_to', { stage: stageLabel(target) }) : word('ui.transitions_move'), onClick: confirm })
                )
            ]
        })
    );
}
