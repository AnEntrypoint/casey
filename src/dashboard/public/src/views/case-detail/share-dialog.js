import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn } from '/design/src/components/shell.js';
import { Dialog, confirmDialog } from '../../components/dialog-shell.js';
import { state, schedule } from '../../state.js';
import { toast } from '../../toasts.js';
import { word } from '../../words.js';
const h = webjsx.createElement;

export function openShareDialog(c) { state._shareDialogFor = c; schedule(); }

export function ShareDialog({ key } = {}) {
    const c = state._shareDialogFor;
    const open = !!c;
    const close = () => { state._shareDialogFor = null; schedule(); };
    const url = c ? (location.origin + '/report?ref=' + encodeURIComponent(c.ref)) : '';
    const copy = async () => {
        try { await navigator.clipboard.writeText(url); toast(word('ui.share_dialog_copied')); }
        catch { await confirmDialog({ title: word('ui.share_dialog_copy_title'), inputLabel: word('ui.share_dialog_link'), inputDefault: url, confirmLabel: word('ui.share_dialog_done') }); }
        close();
    };
    return Dialog({
        key, open, title: word('ui.share_dialog_title'), onClose: close,
        children: !open ? null : [
            h('p', { key: 'lead' }, word('ui.share_dialog_lead')),
            h('p', { key: 'url', class: 'casey-share-url' }, url),
            h('div', { key: 'acts', class: 'ds-dialog-actions' },
                Btn({ key: 'cancel', variant: 'ghost', children: word('ui.share_dialog_close'), onClick: close }),
                Btn({ key: 'copy', variant: 'primary', children: word('ui.share_dialog_copy'), onClick: copy })
            )
        ]
    });
}
