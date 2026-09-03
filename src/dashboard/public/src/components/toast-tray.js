// Renders state.toasts into a fixed toast tray using Alert-shaped rows.
// Auto-dismiss (ok) is handled by toasts.js's own setTimeout; this module
// only renders + wires the dismiss/undo click.

import * as webjsx from 'webjsx';
import { Alert } from 'ds/components/content.js';
import { Btn } from 'ds/components/shell.js';
import { state } from '../state.js';
import { dismissToast } from '../toasts.js';
const h = webjsx.createElement;

export function ToastTray() {
  return h('div', { id: 'toasts', class: 'ds-toast-tray', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'false' },
    ...state.toasts.map((t) => h('div', { key: t.id, class: 'ds-toast-item' },
      Alert({
        kind: t.kind === 'err' ? 'error' : 'success',
        onDismiss: () => dismissToast(t.id),
        children: [
          h('span', { key: 'm' }, t.msg),
          t.undo ? Btn({ key: 'u', size: 'sm', variant: 'ghost', onClick: () => { t.onUndo && t.onUndo(); dismissToast(t.id); }, children: t.undoLabel || 'Undo' }) : null,
        ].filter(Boolean),
      })
    ))
  );
}
