import * as webjsx from '/design/vendor/webjsx/index.js';
import { TextField } from '/design/src/components/content/fields.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { state, closeModal, openModal, schedule } from '../state.js';
import { postFeedback } from '../api-team.js';
import { failMsg } from '../toasts.js';
import { Dialog } from './dialog-shell.js';
import { word } from '../words.js';

const h = webjsx.createElement;
const MAX = 600;
const f = { text: '', busy: false, error: '', sent: false };

export function openFeedback() { Object.assign(f, { text: '', busy: false, error: '', sent: false }); openModal('feedback'); }
function close() { closeModal(); }

async function send() {
  if (f.busy) return;
  if (!f.text.trim()) { f.error = word('ui.feedback_dialog_write_first'); schedule(); return; }
  f.busy = true; f.error = ''; schedule();
  try { await postFeedback(f.text.trim()); f.sent = true; f.text = ''; }
  catch (e) { f.error = await failMsg(e, word('ui.feedback_dialog_not_sent')); }
  f.busy = false; schedule();
}

export function FeedbackDialog() {
  if (state.activeModal !== 'feedback') return null;
  return Dialog({
    open: true, title: word('ui.feedback_dialog_send'), onClose: close,
    children: f.sent
      ? [
        h('p', { key: 'thanks', role: 'status' }, word('ui.feedback_dialog_thanks')),
        h('div', { key: 'row', class: 'ds-dialog-actions' },
          Btn({ variant: 'ghost', children: word('ui.feedback_dialog_write_another'), onClick: () => { f.sent = false; schedule(); } }),
          Btn({ variant: 'primary', children: word('ui.feedback_dialog_close'), onClick: close })),
      ]
      : [
        h('p', { key: 'lede' }, word('ui.feedback_dialog_lede')),
        TextField({ key: 'fb-text', name: 'feedback-text', label: word('ui.feedback_dialog_note_label'), multiline: true, rows: 5, maxLength: MAX, value: f.text, error: f.error || undefined, onInput: (v) => { f.text = v; f.error = ''; schedule(); } }),
        h('div', { key: 'row', class: 'ds-dialog-actions' },
          Btn({ variant: 'ghost', children: word('ui.feedback_dialog_cancel'), onClick: close }),
          Btn({ variant: 'primary', disabled: f.busy, children: f.busy ? word('ui.feedback_dialog_sending') : word('ui.feedback_dialog_send'), onClick: send })),
      ],
  });
}
