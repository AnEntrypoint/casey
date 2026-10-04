import * as webjsx from '/design/vendor/webjsx/index.js';
import { TextField } from '/design/src/components/content/fields.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { state, closeModal, openModal, schedule } from '../state.js';
import { postFeedback } from '../api-team.js';
import { failMsg } from '../toasts.js';
import { Dialog } from './dialog-shell.js';

const h = webjsx.createElement;
const MAX = 600;
const f = { text: '', busy: false, error: '', sent: false };

export function openFeedback() { Object.assign(f, { text: '', busy: false, error: '', sent: false }); openModal('feedback'); }
function close() { closeModal(); }

async function send() {
  if (f.busy) return;
  if (!f.text.trim()) { f.error = 'Write a few words first.'; schedule(); return; }
  f.busy = true; f.error = ''; schedule();
  try { await postFeedback(f.text.trim()); f.sent = true; f.text = ''; }
  catch (e) { f.error = await failMsg(e, 'Your note was not sent. Nothing was lost -- try again in a moment.'); }
  f.busy = false; schedule();
}

export function FeedbackDialog() {
  if (state.activeModal !== 'feedback') return null;
  return Dialog({
    open: true, title: 'Send feedback', onClose: close,
    children: f.sent
      ? [
        h('p', { key: 'thanks', role: 'status' }, 'Thank you. Your note was sent to the team. You do not need to do anything else.'),
        h('div', { key: 'row', class: 'ds-dialog-actions' },
          Btn({ variant: 'ghost', children: 'Write another', onClick: () => { f.sent = false; schedule(); } }),
          Btn({ variant: 'primary', children: 'Close', onClick: close })),
      ]
      : [
        h('p', { key: 'lede' }, 'Tell us what was confusing, broken or missing on this screen. Please do not put names or phone numbers in your note.'),
        TextField({ key: 'fb-text', name: 'feedback-text', label: 'Your note', multiline: true, rows: 5, maxLength: MAX, value: f.text, error: f.error || undefined, onInput: (v) => { f.text = v; f.error = ''; schedule(); } }),
        h('div', { key: 'row', class: 'ds-dialog-actions' },
          Btn({ variant: 'ghost', children: 'Cancel', onClick: close }),
          Btn({ variant: 'primary', disabled: f.busy, children: f.busy ? 'Sending...' : 'Send feedback', onClick: send })),
      ],
  });
}
