// Dialog -- casey-local shared modal primitive. NOT in the design SDK; built
// by copying the structural pattern already proven in the SDK's own
// VideoLightbox/full-screen overlays (backdrop div, aria-modal, trapTab
// import from overlay-primitives.js) rather than inventing a new modal
// machine. Every dialog-shaped surface in casey (help/onboarding/skills/
// settings/stats, plus every case-detail dialog) renders through this one
// component so there is exactly one modal code path to keep accessible.
//
// Isolated to this one file so it is easy to swap if/when the SDK ships a
// first-class Modal. Merged superset of the per-worktree dialog-shell.js
// variants -- Dialog's superset prop shape (open/title/onClose/children/
// wide/id/footer) plus panels' one-off confirmDialog() promise-based
// confirm/prompt (used by contacts-panel's erase flow and account-menu's
// logout-everywhere confirm) both live here.

import * as webjsx from 'webjsx';
import { trapTab } from 'ds/components/overlay-primitives.js';
import { Icon } from 'ds/components/shell.js';
const h = webjsx.createElement;

/**
 * @param {Object} props
 * @param {boolean} props.open
 * @param {string} props.title - becomes the dialog's accessible name.
 * @param {Function} props.onClose
 * @param {*} props.children
 * @param {boolean} [props.wide] - widens the panel for content-heavy dialogs (settings/stats).
 * @param {string} [props.id] - stable id prefix for aria-labelledby; defaults to a slug of title.
 * @param {*} [props.footer] - optional footer row (action buttons), rendered outside the scrollable body.
 */
export function Dialog({ open, title, onClose, children, wide = false, id, footer } = {}) {
  if (!open) return null;
  const slug = id || 'dlg-' + String(title || 'x').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  const titleId = slug + '-title';
  const close = () => onClose && onClose();
  const onBackdropDown = (e) => { if (e.target === e.currentTarget) close(); };
  const onKeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    const panel = e.currentTarget.querySelector('.ds-dialog-panel');
    if (panel) trapTab(panel, e);
  };
  // ref fires on every applyDiff pass that touches this node, not only
  // mount -- autofocus-every-render would steal focus back out of a form
  // field the operator is actively typing into. Track already-focused
  // panels so the initial-focus grab happens exactly once per open dialog.
  const focusPanel = (el) => {
    if (!el || el._dsDialogInit) return;
    el._dsDialogInit = true;
    // Macrotask, not microtask: the triggering click's own default
    // focus-on-click can otherwise win the race and leave focus outside
    // the dialog, breaking Escape/Tab-trap for a keyboard user (same
    // reasoning as the SDK's own Popover/_anchoredOverlayLifecycle).
    setTimeout(() => {
      const first = el.querySelector('a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])');
      (first || el).focus();
    }, 0);
  };
  return h('div', {
    class: 'ds-dialog-backdrop',
    role: 'presentation',
    onmousedown: onBackdropDown,
  },
    h('div', {
      class: 'ds-dialog-panel' + (wide ? ' ds-dialog-panel-wide ds-dialog-panel--wide' : ''),
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
      tabindex: '-1',
      onkeydown: onKeydown,
      ref: focusPanel,
    },
      h('div', { class: 'ds-dialog-head' },
        h('h2', { id: titleId, class: 'ds-dialog-title' }, title || ''),
        h('button', { type: 'button', class: 'ds-dialog-x ds-dialog-close', 'aria-label': 'Close', onclick: close }, Icon('x'))
      ),
      h('div', { class: 'ds-dialog-body' }, ...(Array.isArray(children) ? children : [children])),
      footer ? h('div', { class: 'ds-dialog-foot' }, footer) : null
    )
  );
}

// confirmDialog -- a one-off Promise-resolving confirm/prompt overlay for
// flows that need a yes/no (or yes-with-optional-text) answer outside the
// normal state.activeModal render cycle (e.g. contacts-panel's erase
// action). Resolves the input string ('' if none given) on confirm, or
// null on cancel/escape. Uses raw DOM (not webjsx) since it is a one-shot
// imperative overlay, matching the legacy showDialog()'s own shape.
export function confirmDialog({ title, message, inputLabel, inputPlaceholder, inputDefault, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'ds-dialog-backdrop';
    backdrop.setAttribute('role', 'presentation');
    const panel = document.createElement('div');
    panel.className = 'ds-dialog-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.tabIndex = -1;
    const h2 = document.createElement('h2');
    h2.className = 'ds-dialog-title';
    h2.textContent = title || 'Confirm';
    panel.appendChild(h2);
    if (message) {
      const p = document.createElement('p');
      p.className = 'ds-dialog-message';
      p.textContent = message;
      panel.appendChild(p);
    }
    let input = null;
    if (inputLabel !== undefined) {
      const lbl = document.createElement('label');
      lbl.className = 'ds-field';
      const span = document.createElement('span');
      span.className = 'ds-field-label';
      span.textContent = inputLabel;
      lbl.appendChild(span);
      input = document.createElement('input');
      input.type = 'text';
      input.placeholder = inputPlaceholder || '';
      if (inputDefault !== undefined) input.value = inputDefault;
      input.className = 'ds-dialog-input';
      lbl.appendChild(input);
      panel.appendChild(lbl);
    }
    const row = document.createElement('div');
    row.className = 'ds-dialog-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-ghost';
    cancelBtn.textContent = 'Cancel';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = danger ? 'btn-primary danger' : 'btn-primary';
    okBtn.textContent = confirmLabel;
    row.appendChild(cancelBtn); row.appendChild(okBtn);
    panel.appendChild(row);
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    const close = (val) => { backdrop.remove(); resolve(val); };
    okBtn.onclick = () => close(input ? input.value : '');
    cancelBtn.onclick = () => close(null);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(null); });
    backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); });
    setTimeout(() => { (input || okBtn).focus(); if (input && inputDefault !== undefined) input.select(); }, 60);
  });
}
