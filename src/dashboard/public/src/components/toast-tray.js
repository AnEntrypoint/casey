import * as webjsx from 'webjsx';
import { Alert } from 'ds/components/content.js';
import { Btn } from 'ds/components/shell.js';
import { state } from '../state.js';
import { dismissToast } from '../toasts.js';
import { word } from '../words.js';
const h = webjsx.createElement;

const TOAST_KIND = { err: 'error', warn: 'warn' };

export function ToastTray() {
  return h('div', { id: 'toasts', class: 'ds-toast-tray', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'false' },
    ...state.toasts.map((t) => h('div', { key: t.id, class: 'ds-toast-item' },
      Alert({
        kind: TOAST_KIND[t.kind] || 'info',
        onDismiss: () => dismissToast(t.id),
        children: [
          h('span', { key: 'm' }, t.msg),
          t.undo ? Btn({
            key: 'u', size: 'sm', variant: 'ghost',
            disabled: !!t.undo.busy,
            title: t.undo.busy ? word('ui.toast_tray_working') : null,
            onClick: () => { if (!t.undo.busy) t.undo.run(); },
            children: t.undo.label || word('ui.toast_tray_undo'),
          }) : null,
        ].filter(Boolean),
      })
    ))
  );
}
