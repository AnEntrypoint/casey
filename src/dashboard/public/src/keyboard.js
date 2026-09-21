// Global keydown dispatch table: j/k/o/Enter/c/e/Escape/?/n//. Guarded
// against firing while a text input/textarea/contenteditable has focus (so
// typing "e" into a reply box never jumps focus). Handlers are late-bound via
// registerKeyboardHandlers so main.js can wire this before views exist.

import { state } from './state.js';
import { openModal, closeModal } from './state.js';
import { closePanelRoute } from './route.js';

let handlers = {
  moveDown: () => {}, moveUp: () => {}, openHighlighted: () => {}, claim: () => {},
  focusReply: () => {}, focusSearch: () => {}, newCase: () => {}, back: () => {},
};

export function registerKeyboardHandlers(partial) { Object.assign(handlers, partial); }

function isTypingTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

// A CONTROL THAT ALREADY OWNS THE KEY MUST KEEP IT. Enter and Space on a
// focused button or link are that control's own activation keys, and the browser
// fires keydown at the document as well -- so with Enter in the table below, a
// keyboard user pressing Enter on ANY button also opened the highlighted case
// underneath: two actions from one keypress, one of them invisible to them. The
// j/k/c/e/n/? letters are just as wrong on a focused control (Space-scrolling a
// disclosure, typing a shortcut at a button) but Enter is the one that fires
// every time. A pointer user is unaffected either way: this only reads the
// element that currently holds focus.
function isActivatableTarget(el) {
  if (!el || el === document.body) return false;
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'button' || tag === 'summary' || tag === 'option') return true;
  if (tag === 'a' && el.hasAttribute('href')) return true;
  const role = (el.getAttribute && el.getAttribute('role')) || '';
  return role === 'button' || role === 'link' || role === 'menuitem' || role === 'tab' || role === 'checkbox' || role === 'switch';
}

// A MODAL IS MODAL FOR THE KEYBOARD TOO. Every dialog in this app renders an
// aria-modal panel over the page and owns Escape itself (dialog-shell.js), so
// the table below must not also drive the list behind it -- j/k/c/n/e moved the
// highlight, claimed and opened cases the operator could not see while a
// snooze, split or merge prompt was on screen, and '?' swapped the open dialog
// for the help card. state.activeModal covers the registered modals;
// querySelector covers the ones that render their own panel outside it
// (confirmDialog, the share/snooze/split/dedup dialogs).
function modalIsOpen() {
  if (state.activeModal) return true;
  return !!document.querySelector('.ds-dialog-backdrop, [role="dialog"][aria-modal="true"]');
}

export function onGlobalKeyDown(e) {
  if (isTypingTarget(document.activeElement)) {
    if (e.key !== 'Escape') return;
    document.activeElement.blur();
    return;
  }
  // Escape still reaches the switch below (closeModal/closePanelRoute/back is
  // the only global key a dialog does not already handle for itself), every
  // other key stops here while a modal is up.
  if (e.key !== 'Escape' && modalIsOpen()) return;
  if (e.key !== 'Escape' && isActivatableTarget(document.activeElement)) return;
  switch (e.key) {
    case 'j': handlers.moveDown(); break;
    case 'k': handlers.moveUp(); break;
    case 'o': handlers.openHighlighted(); break;
    case 'Enter': handlers.openHighlighted(); break;
    case 'c': handlers.claim(); break;
    case 'e': e.preventDefault(); handlers.focusReply(); break;
    case '/': e.preventDefault(); handlers.focusSearch(); break;
    case 'n': handlers.newCase(); break;
    case '?': openModal('help'); break;
    case 'Escape':
      if (state.activeModal) { closeModal(); break; }
      if (state.activePanel) { closePanelRoute(); break; }
      handlers.back();
      break;
    default: return;
  }
}

export function installGlobalKeyboard() {
  document.addEventListener('keydown', onGlobalKeyDown);
}
