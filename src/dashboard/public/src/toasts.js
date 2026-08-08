// toasts.js -- toast queue state (ok auto-dismiss, err persists) + undo-toast
// factory. Rendering lives in components/toast-tray.js; this module owns the
// queue, timers, and the actual undo/correction network calls (the real
// /undo and /reply POSTs live here so every caller gets identical behavior).
//
// undoToast/replyUndoToast/failMsg match the signature case-detail's 22
// consumer files use (undoToast(caseId, label, onDone),
// replyUndoToast(caseId, onDone), failMsg(errorOrResponse, fallback)) --
// the richer, actually-called shape across every worktree.

import { state, schedule } from './state.js';
import { api } from './api.js';

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
export const removeToast = dismissToast;
export function toasts() { return state.toasts; }

// Accepts either a raw fetch Response (legacy call shape, .json() not yet
// read) or an already-thrown ApiError (api.js's json() helper throws these
// with .body pre-parsed) -- every consumer catches an ApiError from the
// api.js helpers, so both shapes resolve to the same message.
export async function failMsg(r, fallback) {
  if (r && typeof r === 'object' && 'body' in r && !('json' in r)) {
    return (r.body && r.body.error) || fallback;
  }
  try { return (await r.json()).error || fallback; } catch { return fallback; }
}

// ~15s actionable Undo toast after a reversible operator action (transition /
// claim / snooze). The server picks the most-recent undoable action itself;
// the client only POSTs /undo within the window.
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
  setTimeout(() => dismissToast(id), 15000);
  return id;
}

// A sent reply cannot be unsent. 'Take it back' degrades to queuing a
// correction and re-flagging needs-human -- never a silent rewrite of what
// the contact received.
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
  setTimeout(() => dismissToast(id), 15000);
  return id;
}
