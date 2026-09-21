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

const DIALOG_FOCUSABLE_SEL = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

// WHERE FOCUS GOES WHEN A DIALOG CLOSES. A modal takes focus on open, so
// closing it has to hand focus back to the control that opened it; left alone,
// focus falls to <body> and the next Tab restarts at the top of the document --
// past the skip link, the whole appbar and the whole nav -- which for a
// keyboard-only operator is the difference between closing a snooze prompt and
// losing their place in a 200-stop page. One module-scope slot, because exactly
// one modal is open at a time in this app (state.activeModal is a single value,
// and confirmDialog is awaited by its caller).
// THE NODE IS NOT ENOUGH TO REMEMBER. Every panel in this app re-renders on its
// own poll (attention, health, the case row itself), and applyDiff may replace
// the very button that opened the dialog while the dialog is still up --
// measured: a field's note button was detached within two seconds of opening
// its prompt, so restoring to the captured node silently did nothing and focus
// stayed on <body>. So a signature is remembered beside the node and the
// equivalent control is re-found when the original is gone. The signature is
// tag + accessible-name-ish text + class, which is exactly enough here because
// the controls that open dialogs are uniquely named (that is the other half of
// this same pass).
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
  try { el.focus(); } catch { /* a control that refuses focus is not a failure to report */ }
}

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
  const close = () => { restoreOpenerFocus(); if (onClose) onClose(); };
  const onBackdropDown = (e) => { if (e.target === e.currentTarget) close(); };
  // trapTab takes the CONTAINER to confine focus to, and that container is the
  // element this handler is bound to -- the panel itself. Asking the panel for
  // a `.ds-dialog-panel` DESCENDANT always answers null (an element is not its
  // own descendant), so the trap never ran on any dialog in this app: Tab from
  // the last control inside a modal walked straight out into the page behind
  // it, which the modal is covering. The kit's own SettingsShell keeps the
  // container in a ref for the same reason; currentTarget already is it here.
  // stopPropagation as well as preventDefault: preventDefault suppresses the
  // browser's own default and nothing else, so the same Escape kept bubbling to
  // keyboard.js's document listener, which -- the dialog having already closed
  // itself -- saw no modal open and ran its `back()` branch. One Escape closed
  // the prompt AND the case behind it, so cancelling a snooze threw away the
  // case the operator was reading. The dialog owns Escape; nothing below it
  // needs to see the same press.
  const onKeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    trapTab(e.currentTarget, e);
  };
  // ref fires on every applyDiff pass that touches this node, not only
  // mount -- autofocus-every-render would steal focus back out of a form
  // field the operator is actively typing into. Track already-focused
  // panels so the initial-focus grab happens exactly once per open dialog.
  const focusPanel = (el) => {
    if (!el || el._dsDialogInit) return;
    el._dsDialogInit = true;
    rememberOpener();
    // Macrotask, not microtask: the triggering click's own default
    // focus-on-click can otherwise win the race and leave focus outside
    // the dialog, breaking Escape/Tab-trap for a keyboard user (same
    // reasoning as the SDK's own Popover/_anchoredOverlayLifecycle).
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

// confirmDialog -- a one-off Promise-resolving confirm/prompt overlay for
// flows that need a yes/no (or yes-with-optional-text) answer outside the
// normal state.activeModal render cycle (e.g. contacts-panel's erase
// action). Resolves the input string ('' if none given) on confirm, or
// null on cancel/escape. Uses raw DOM (not webjsx) since it is a one-shot
// imperative overlay, matching the legacy showDialog()'s own shape.
let _confirmSeq = 0;
export function confirmDialog({ title, message, inputLabel, inputPlaceholder, inputDefault, confirmLabel = 'Confirm', danger = false }) {
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
    // A role=dialog with no accessible name reaches the accessibility tree as
    // an unnamed dialog: a screen reader announces "dialog" and nothing else,
    // so the one question being asked ("Flag this reply", "Erase personal
    // details") is only readable by exploring the panel. Dialog() above names
    // itself through its own titleId for the same reason; this overlay is the
    // route four flows take (flag a reply, add a field note, discard a draft,
    // erase a contact) and had no name at all.
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
    const close = (val) => { backdrop.remove(); restoreOpenerFocus(); resolve(val); };
    okBtn.onclick = () => close(input ? input.value : '');
    cancelBtn.onclick = () => close(null);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(null); });
    // Escape AND Tab, on the panel rather than the backdrop: this overlay sits
    // over a page holding 200-plus other focusable controls and had no Tab
    // trap, so a keyboard user leaving the Confirm button landed on controls
    // the panel is covering -- typing into a case row they cannot see. Same
    // trapTab the webjsx Dialog above uses, so both modal shapes behave alike.
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); return; }
      trapTab(panel, e);
    });
    setTimeout(() => { (input || okBtn).focus(); if (input && inputDefault !== undefined) input.select(); }, 60);
  });
}
