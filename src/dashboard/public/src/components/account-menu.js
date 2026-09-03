// Topbar-right account Dropdown: theme toggle, simple-mode toggle, operator
// identity display, logout, logout-everywhere. Safe actions come first;
// logout/logout-everywhere sit below a separator, and logout-everywhere
// (destructive: revokes every OTHER session) requires an explicit confirm
// step via Dialog rather than a bare click-to-execute
// (ux-nav-account-menu-destructive-separation).

import * as webjsx from 'webjsx';
import { Dropdown } from 'ds/components/overlay-primitives.js';
import { Btn, Icon } from 'ds/components/shell.js';
import { state, setTheme, setSimpleMode, openModal, closeModal } from '../state.js';
import { doLogout, doLogoutEverywhere } from '../auth.js';
import { toast } from '../toasts.js';
import { Dialog } from './dialog-shell.js';
const h = webjsx.createElement;

export function applyTheme(t) {
  // The SDK's theme override rules are scoped as .ds-247420[data-theme="X"]
  // (dist/247420.css) -- data-theme must sit on the SAME element that
  // carries the .ds-247420 scope class, not on <html>. document.documentElement
  // never carries that class, so setting it there silently no-ops: the
  // toggle updated localStorage/state correctly but the page never actually
  // repainted (live-witnessed: dark theme "selected" in the menu, page still
  // rendered light). #app and <body> both carry .ds-247420 (see index.html's
  // comment on why body needs it too, for portaled popover content) so both
  // need the attribute for in-page content and overlay content alike.
  document.documentElement.dataset.theme = t;
  document.body.dataset.theme = t;
  const appEl = document.getElementById('app');
  if (appEl) appEl.dataset.theme = t;
  try { localStorage.casey_theme = t; } catch { /* storage unavailable */ }
  setTheme(t);
}

export function initTheme() {
  const saved = (() => { try { return localStorage.casey_theme; } catch { return null; } })();
  applyTheme(saved || (matchMedia('(prefers-color-scheme: light)').matches ? 'paper' : 'ink'));
}

function openLogoutEverywhereConfirm() { openModal('confirm-logout-everywhere'); }
function closeLogoutEverywhereConfirm() { closeModal(); }

async function confirmLogoutEverywhere() {
  try {
    await doLogoutEverywhere();
    toast('Logged out everywhere else. This device stays signed in.');
  } catch (e) {
    toast('Could not log out other sessions: ' + e.message, 'err');
  }
  closeLogoutEverywhereConfirm();
}

export function LogoutEverywhereConfirmDialog() {
  return Dialog({
    open: state.activeModal === 'confirm-logout-everywhere',
    title: 'Log out on every device?',
    onClose: closeLogoutEverywhereConfirm,
    children: [
      h('p', { key: 'p' }, 'This signs out every OTHER session on your account. This device stays signed in. This cannot be undone.'),
      h('div', { key: 'row', class: 'ds-dialog-actions' },
        Btn({ variant: 'ghost', onClick: closeLogoutEverywhereConfirm, children: 'Cancel' }),
        Btn({ variant: 'danger', onClick: confirmLogoutEverywhere, children: 'Log out everywhere else' })
      ),
    ],
  });
}

export function AccountMenu() {
  const items = [
    { id: 'theme', label: state.theme === 'paper' ? 'Switch to dark theme' : 'Switch to light theme', glyph: Icon(state.theme === 'paper' ? 'moon' : 'sun', { size: 14 }) },
    { id: 'simple', label: state.simpleMode ? 'Turn off plain-language mode' : 'Turn on plain-language mode', glyph: Icon('smile', { size: 14 }) },
    { id: 'help', label: 'Help', glyph: Icon('help', { size: 14 }) },
    { separator: true },
    { id: 'logout', label: 'Log out' },
    { id: 'logout-everywhere', label: 'Log out everywhere else', danger: true },
  ];
  const onSelect = (id) => {
    if (id === 'theme') applyTheme(state.theme === 'paper' ? 'ink' : 'paper');
    else if (id === 'simple') setSimpleMode(!state.simpleMode);
    else if (id === 'help') openModal('help');
    else if (id === 'logout') doLogout();
    else if (id === 'logout-everywhere') openLogoutEverywhereConfirm();
  };
  const label = state.currentUser ? (state.currentUser.display_name || state.currentUser.username) : 'Account';
  return Dropdown({
    ariaLabel: 'Account menu',
    // NOT a full h('button', ...) element: Dropdown's own trigger-rewrap
    // (design SDK overlay-primitives/menus.js) reads webjsx child nodes back
    // via `child.children`, but webjsx.createElement only ever stores
    // children under `child.props.children` -- so any trigger vnode with
    // real children (icon + label) silently renders as an empty button
    // (live-witnessed: the account menu trigger shrank to an invisible
    // 32x8px empty button). Returning an array here instead routes through
    // Dropdown's OTHER branch (`child.type` is falsy for an array), which
    // wraps the returned content directly into its own
    // `ds-dropdown-trigger` button and never hits the lossy rewrap path.
    trigger: () => [Icon('members', { size: 16 }), h('span', {}, label)],
    items,
    onSelect,
  });
}
