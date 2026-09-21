// Renders state.toasts into a fixed toast tray using Alert-shaped rows.
// Auto-dismiss (ok) is handled by toasts.js's own setTimeout; this module
// only renders + wires the dismiss/undo click.

import * as webjsx from 'webjsx';
import { Alert } from 'ds/components/content.js';
import { Btn } from 'ds/components/shell.js';
import { state } from '../state.js';
import { dismissToast } from '../toasts.js';
const h = webjsx.createElement;

const TOAST_KIND = { err: 'error', warn: 'warn' };

export function ToastTray() {
  return h('div', { id: 'toasts', class: 'ds-toast-tray', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'false' },
    ...state.toasts.map((t) => h('div', { key: t.id, class: 'ds-toast-item' },
      Alert({
        // toasts.js takes kind 'err' | 'warn' | anything-else (default 'ok').
        // An ordinary confirmation is neutral, not a green success tick, and a
        // 'warn' toast must not render as one -- callers do send them.
        kind: TOAST_KIND[t.kind] || 'info',
        onDismiss: () => dismissToast(t.id),
        children: [
          h('span', { key: 'm' }, t.msg),
          // THE SHAPE toasts.js ACTUALLY BUILDS is `undo: {label, busy, run}`.
          // Read as `t.onUndo`/`t.undoLabel` -- two properties nothing in this
          // app ever sets -- the button rendered, said "Undo" whatever the
          // action was, and on click only dismissed the toast: the /undo POST
          // never fired and a sent reply's correction was never queued, while
          // the toast disappeared as if it had worked. That is the worst
          // possible failure for the one affordance that reverses an action a
          // contact can already see. run() dismisses the row itself once the
          // network call resolves, so this does not also dismiss it early --
          // doing so would remove the busy state mid-request.
          // THE LABEL DOES NOT CHANGE WHILE THE UNDO IS IN FLIGHT. Swapping the
          // string child for 'Working...' rendered an EMPTY button for the
          // duration -- the same bare-string-child diff webjsx cannot morph in
          // place that login-gate.js documents for its message slot, and a
          // control that goes blank mid-request is worse than one that does not
          // move. The busy state is carried by `disabled` (the kit's
          // .is-disabled treatment) and the title, neither of which touches the
          // child list.
          t.undo ? Btn({
            key: 'u', size: 'sm', variant: 'ghost',
            disabled: !!t.undo.busy,
            title: t.undo.busy ? 'Working...' : null,
            onClick: () => { if (!t.undo.busy) t.undo.run(); },
            children: t.undo.label || 'Undo',
          }) : null,
        ].filter(Boolean),
      })
    ))
  );
}
