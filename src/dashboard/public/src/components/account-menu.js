import * as webjsx from 'webjsx';
import { Dropdown } from 'ds/components/overlay-primitives.js';
import { Btn, Icon } from 'ds/components/shell.js';
import { state, setTheme, openModal, closeModal } from '../state.js';
import { doLogout, doLogoutEverywhere } from '../auth.js';
import { toast, failMsg } from '../toasts.js';
import { Dialog } from './dialog-shell.js';
import { openFeedback } from './feedback-dialog.js';
const h = webjsx.createElement;

export function applyTheme(t) {
  document.documentElement.dataset.caseyTheme = t;
  document.body.dataset.theme = t;
  const appEl = document.getElementById('app');
  if (appEl) appEl.dataset.theme = t;
  setTheme(t);
}

export function chooseTheme(t) {
  try { localStorage.casey_theme = t; } catch {  }
  applyTheme(t);
}

const LEGACY_THEME = { paper: 'herd', light: 'herd', ink: 'herd-ink', dark: 'herd-ink' };

export function systemTheme() {
  try { return matchMedia('(prefers-color-scheme: dark)').matches ? 'herd-ink' : 'herd'; }
  catch { return 'herd'; }
}

export function storedTheme() {
  let saved = null;
  try { saved = localStorage.casey_theme; } catch {  }
  if (!saved) return null;
  return LEGACY_THEME[saved] || saved;
}

export function initTheme() {
  const chosen = storedTheme();
  applyTheme(chosen || systemTheme());
  try {
    matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', () => { if (!storedTheme()) applyTheme(systemTheme()); });
  } catch {  }
}

function openLogoutEverywhereConfirm() { openModal('confirm-logout-everywhere'); }
function closeLogoutEverywhereConfirm() { closeModal(); }

async function confirmLogoutEverywhere() {
  try {
    await doLogoutEverywhere();
    toast('Logged out everywhere else. This device stays signed in.');
  } catch (e) {
    toast(await failMsg(e, 'The other sessions were not signed out and are still active. Try again, and change your password if you need them gone now.'), 'err');
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
    { id: 'theme', label: state.theme === 'herd' ? 'Switch to dark theme' : 'Switch to light theme', glyph: Icon(state.theme === 'herd' ? 'moon' : 'sun', { size: 14 }) },
    { id: 'help', label: 'Help', glyph: Icon('help', { size: 14 }) },
    { id: 'feedback', label: 'Send feedback', glyph: Icon('thread', { size: 14 }) },
    { separator: true },
    { id: 'logout', label: 'Log out' },
    { id: 'logout-everywhere', label: 'Log out everywhere else', danger: true },
  ];
  const onSelect = (id) => {
    if (id === 'theme') chooseTheme(state.theme === 'herd' ? 'herd-ink' : 'herd');
    else if (id === 'help') openModal('help');
    else if (id === 'feedback') openFeedback();
    else if (id === 'logout') doLogout();
    else if (id === 'logout-everywhere') openLogoutEverywhereConfirm();
  };
  const label = state.currentUser ? (state.currentUser.display_name || state.currentUser.username) : 'Account';
  return Dropdown({
    ariaLabel: 'Account menu',
    trigger: () => [Icon('members', { size: 16 }), h('span', {}, label)],
    items,
    onSelect,
  });
}
