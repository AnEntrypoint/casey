import { state, schedule } from './state.js';
import { api } from './api.js';
import { entityLabel } from './vocabulary.js';
import { isFieldRole } from './api-roles.js';
import { word } from './words.js';

const UNDOABLE_TOAST_MS = 15000;

let _seq = 0;
function nextId() { return 'toast-' + (++_seq); }

export function toast(msg, kind = 'ok', opts = {}) {
  const id = nextId();
  const row = Object.assign({ id, msg, kind, undo: null }, opts);
  state.toasts.push(row);
  schedule();
  if (kind !== 'err') setTimeout(() => dismissToast(id), opts.ms || 3500);
  return id;
}

export function dismissToast(id) {
  const i = state.toasts.findIndex((t) => t.id === id);
  if (i === -1) return;
  state.toasts.splice(i, 1);
  schedule();
}
export function toasts() { return state.toasts; }

export async function failMsg(r, fallback) {
  let msg = '';
  let status = r && typeof r === 'object' ? r.status : 0;
  if (r && typeof r === 'object' && 'body' in r && !('json' in r)) msg = (r.body && r.body.error) || '';
  else { try { msg = (await r.json()).error || ''; } catch { msg = ''; } }
  if (status === 401) return word('ui.toasts_signed_out');
  if (status === 404 && (!msg || /^not found$/i.test(msg))) return word('ui.toasts_not_available', { entity: entityLabel() });
  if (/^(unauthorized|forbidden|not found|internal(?: server)? error|bad request)$/i.test(msg)) return fallback;
  return msg || fallback;
}

export function undoToast(caseId, label, onDone) {
  if (isFieldRole()) return toast(label || word('ui.toasts_done'), 'ok');
  const id = nextId();
  const row = {
    id, msg: label || word('ui.toasts_done'), kind: 'ok', undo: {
      label: word('ui.toasts_undo'),
      busy: false,
      run: async () => {
        row.undo.busy = true; schedule();
        try {
          const r = await api('/api/cases/' + encodeURIComponent(caseId) + '/undo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          if (r.ok) {
            const j = await r.json().catch(() => ({}));
            toast(j.summary ? word('ui.toasts_undone_summary', { summary: j.summary }) : word('ui.toasts_undone'), 'ok');
            if (onDone) await onDone();
          } else {
            toast(await failMsg(r, word('ui.toasts_nothing_to_undo')), 'err');
          }
        } catch (e) { toast(await failMsg(e, word('ui.toasts_undo_failed')), 'err'); }
        dismissToast(id);
      },
    },
  };
  state.toasts.push(row);
  schedule();
  setTimeout(() => dismissToast(id), UNDOABLE_TOAST_MS);
  return id;
}

export function replyUndoToast(caseId, onDone) {
  const id = nextId();
  const row = {
    id, msg: word('ui.toasts_reply_sent_undo'), kind: 'ok', undo: {
      label: word('ui.toasts_send_correction'),
      busy: false,
      run: async () => {
        row.undo.busy = true; schedule();
        const correction = 'Sorry, please disregard my last message.';
        try {
          const r = await api('/api/cases/' + encodeURIComponent(caseId) + '/reply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: correction }) });
          if (r.ok) {
            await api('/api/cases/bulk', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [caseId], action: 'tag', tag: 'needs-human' }) }).catch(() => {});
            toast(word('ui.toasts_correction_sent'), 'ok');
            if (onDone) await onDone();
          } else {
            toast(await failMsg(r, word('ui.toasts_correction_failed')), 'err');
          }
        } catch (e) { toast(await failMsg(e, word('ui.toasts_correction_failed')), 'err'); }
        dismissToast(id);
      },
    },
  };
  state.toasts.push(row);
  schedule();
  setTimeout(() => dismissToast(id), UNDOABLE_TOAST_MS);
  return id;
}
