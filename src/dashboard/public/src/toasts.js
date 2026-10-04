import { state, schedule } from './state.js';
import { api } from './api.js';
import { entityLabel } from './vocabulary.js';

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
  if (status === 401) return 'You were signed out. Log in again, then repeat that. Nothing was saved.';
  if (status === 404 && (!msg || /^not found$/i.test(msg))) return 'That ' + entityLabel() + ' is no longer available to you. It may have been given to someone else or removed. Nothing was saved -- refresh and check.';
  if (/^(unauthorized|forbidden|not found|internal(?: server)? error|bad request)$/i.test(msg)) return fallback;
  return msg || fallback;
}

export function undoToast(caseId, label, onDone) {
  const id = nextId();
  const row = {
    id, msg: label || 'Done.', kind: 'ok', undo: {
      label: 'Undo',
      busy: false,
      run: async () => {
        row.undo.busy = true; schedule();
        try {
          const r = await api('/api/cases/' + encodeURIComponent(caseId) + '/undo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          if (r.ok) {
            const j = await r.json().catch(() => ({}));
            toast(j.summary ? ('Undone -- ' + j.summary) : 'Undone', 'ok');
            if (onDone) await onDone();
          } else {
            toast(await failMsg(r, 'Nothing to undo (the window may have passed)'), 'err');
          }
        } catch (e) { toast('Undo error: ' + e.message, 'err'); }
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
    id, msg: 'Reply sent.', kind: 'ok', undo: {
      label: 'Take it back',
      busy: false,
      run: async () => {
        row.undo.busy = true; schedule();
        const correction = 'Sorry, please disregard my last message.';
        try {
          const r = await api('/api/cases/' + encodeURIComponent(caseId) + '/reply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: correction }) });
          if (r.ok) {
            await api('/api/cases/bulk', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [caseId], action: 'tag', tag: 'needs-human' }) }).catch(() => {});
            toast('Sent a correction and flagged this for a person -- a reply cannot be unsent.', 'ok');
            if (onDone) await onDone();
          } else {
            toast(await failMsg(r, 'Could not send the correction'), 'err');
          }
        } catch (e) { toast('Correction error: ' + e.message, 'err'); }
        dismissToast(id);
      },
    },
  };
  state.toasts.push(row);
  schedule();
  setTimeout(() => dismissToast(id), UNDOABLE_TOAST_MS);
  return id;
}
