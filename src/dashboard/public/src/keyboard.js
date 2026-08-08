// Global keydown dispatch table: j/k/o/Enter/c/e/Escape/?/n//. Guarded
// against firing while a text input/textarea/contenteditable has focus (so
// typing "e" into a reply box never jumps focus). Handlers are late-bound via
// registerKeyboardHandlers so main.js can wire this before views exist.

import { state } from './state.js';
import { openModal, closeModal, closePanel } from './state.js';

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

export function onGlobalKeyDown(e) {
  if (isTypingTarget(document.activeElement)) {
    if (e.key !== 'Escape') return;
    document.activeElement.blur();
    return;
  }
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
      if (state.activePanel) { closePanel(); break; }
      handlers.back();
      break;
    default: return;
  }
}

export function installGlobalKeyboard() {
  document.addEventListener('keydown', onGlobalKeyDown);
}
