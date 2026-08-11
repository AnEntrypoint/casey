// share-dialog.js -- "get a link to share with the contact" dialog, wired
// from header.js's Share form action. No token in the link (the public
// /report form is gated by knowledge of the case ref, not auth).

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn } from '/design/src/components/shell.js';
import { Dialog } from '../../components/dialog-shell.js';
import { state, schedule } from '../../state.js';
import { toast } from '../../toasts.js';
const h = webjsx.createElement;

export function openShareDialog(c) { state._shareDialogFor = c; schedule(); }

export function ShareDialog({ key } = {}) {
    const c = state._shareDialogFor;
    const open = !!c;
    const close = () => { state._shareDialogFor = null; schedule(); };
    const url = c ? (location.origin + '/report?ref=' + encodeURIComponent(c.ref)) : '';
    const copy = () => {
        try { navigator.clipboard.writeText(url); toast('Link copied'); }
        catch { prompt('Copy this link:', url); }
        close();
    };
    return Dialog({
        key, open, title: 'Share form with contact', onClose: close,
        children: !open ? null : [
            h('p', { key: 'lead' }, 'Send this link to the contact so they can fill in the details directly:'),
            h('p', { key: 'url', class: 'casey-share-url' }, url),
            h('div', { key: 'acts', class: 'casey-dialog-actions' },
                Btn({ key: 'cancel', variant: 'ghost', children: 'Close', onClick: close }),
                Btn({ key: 'copy', variant: 'primary', children: 'Copy link', onClick: copy })
            )
        ]
    });
}
