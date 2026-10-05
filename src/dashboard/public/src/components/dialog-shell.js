import * as webjsx from 'webjsx';
import { trapTab } from 'ds/components/overlay-primitives.js';
import { Icon } from 'ds/components/shell.js';
const h = webjsx.createElement;

const DIALOG_FOCUSABLE_SEL = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

let _opener = null;
function openerSignature(el) {
  return [
    el.tagName,
    (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
    (el.className || '').toString(),
  ].join('|');
}
function rememberOpener() {
  const a = document.activeElement;
  _opener = (a && a !== document.body && typeof a.focus === 'function')
    ? { el: a, sig: openerSignature(a) }
    : null;
}
function restoreOpenerFocus() {
  const remembered = _opener;
  _opener = null;
  if (!remembered) return;
  let el = remembered.el;
  if (!document.contains(el)) {
    el = [...document.querySelectorAll(remembered.el.tagName)]
      .find((c) => openerSignature(c) === remembered.sig) || null;
  }
  if (!el) return;
  try { el.focus(); } catch {  }
}

export function Dialog({ open, title, onClose, children, wide = false, id, footer } = {}) {
  if (!open) return null;
  const slug = id || 'dlg-' + String(title || 'x').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  const titleId = slug + '-title';
  const close = () => { restoreOpenerFocus(); if (onClose) onClose(); };
  const onBackdropDown = (e) => { if (e.target === e.currentTarget) close(); };
  const onKeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    trapTab(e.currentTarget, e);
  };
  const focusPanel = (el) => {
    if (!el || el._dsDialogInit) return;
    el._dsDialogInit = true;
    rememberOpener();
    setTimeout(() => {
      const first = el.querySelector(DIALOG_FOCUSABLE_SEL);
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

let _confirmSeq = 0;
export function confirmDialog({ title, message, inputLabel, inputPlaceholder, inputDefault, choices, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    rememberOpener();
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
    h2.id = 'ds-confirm-title-' + (++_confirmSeq);
    panel.setAttribute('aria-labelledby', h2.id);
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
      input = choices ? document.createElement('select') : document.createElement('input');
      if (choices) {
        for (const [value, text] of choices) {
          const opt = document.createElement('option');
          opt.value = value;
          opt.textContent = text;
          input.appendChild(opt);
        }
      } else {
        input.type = 'text';
        input.placeholder = inputPlaceholder || '';
      }
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
    const close = (val) => { backdrop.remove(); restoreOpenerFocus(); resolve(val); };
    okBtn.onclick = () => close(input ? input.value : '');
    cancelBtn.onclick = () => close(null);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(null); });
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); return; }
      trapTab(panel, e);
    });
    setTimeout(() => { (input || okBtn).focus(); if (input && !choices && inputDefault !== undefined) input.select(); }, 60);
  });
}
