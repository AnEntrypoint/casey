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

function isActivatableTarget(el) {
  if (!el || el === document.body) return false;
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'button' || tag === 'summary' || tag === 'option') return true;
  if (tag === 'a' && el.hasAttribute('href')) return true;
  const role = (el.getAttribute && el.getAttribute('role')) || '';
  return role === 'button' || role === 'link' || role === 'menuitem' || role === 'tab' || role === 'checkbox' || role === 'switch';
}

function modalIsOpen() {
  if (state.activeModal) return true;
  return !!document.querySelector('.ds-dialog-backdrop, [role="dialog"][aria-modal="true"]');
}

export function onGlobalKeyDown(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target && e.target.closest && e.target.closest('[role="menu"]')) return;
  if (isTypingTarget(document.activeElement)) {
    if (e.key !== 'Escape') return;
    document.activeElement.blur();
    return;
  }
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
