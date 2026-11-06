import * as webjsx from 'webjsx';
import { Dropdown } from 'ds/components/overlay-primitives.js';
import { Btn, Icon } from 'ds/components/shell.js';
import { state, setTheme, openModal, closeModal } from '../state.js';
import { doLogout, doLogoutEverywhere } from '../auth.js';
import { toast, failMsg } from '../toasts.js';
import { Dialog } from './dialog-shell.js';
import { openFeedback } from './feedback-dialog.js';
import { word } from '../words.js';
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
    toast(word('ui.account_menu_logged_out_others'));
  } catch (e) {
    toast(await failMsg(e, word('ui.account_menu_others_not_signed_out')), 'err');
  }
  closeLogoutEverywhereConfirm();
}

export function LogoutEverywhereConfirmDialog() {
  return Dialog({
    open: state.activeModal === 'confirm-logout-everywhere',
    title: word('ui.account_menu_logout_all_title'),
    onClose: closeLogoutEverywhereConfirm,
    children: [
      h('p', { key: 'p' }, word('ui.account_menu_logout_all_body')),
      h('div', { key: 'row', class: 'ds-dialog-actions' },
        Btn({ variant: 'ghost', onClick: closeLogoutEverywhereConfirm, children: word('ui.account_menu_cancel') }),
        Btn({ variant: 'danger', onClick: confirmLogoutEverywhere, children: word('ui.account_menu_logout_all') })
      ),
    ],
  });
}

export function AccountMenu() {
  const items = [
    { id: 'theme', label: state.theme === 'herd' ? word('ui.account_menu_theme_dark') : word('ui.account_menu_theme_light'), glyph: Icon(state.theme === 'herd' ? 'moon' : 'sun', { size: 14 }) },
    { id: 'help', label: word('ui.account_menu_help'), glyph: Icon('help', { size: 14 }) },
    { id: 'feedback', label: word('ui.account_menu_feedback'), glyph: Icon('thread', { size: 14 }) },
    { separator: true },
    { id: 'logout', label: word('ui.account_menu_logout') },
    { id: 'logout-everywhere', label: word('ui.account_menu_logout_all'), danger: true },
  ];
  const onSelect = (id) => {
    if (id === 'theme') chooseTheme(state.theme === 'herd' ? 'herd-ink' : 'herd');
    else if (id === 'help') openModal('help');
    else if (id === 'feedback') openFeedback();
    else if (id === 'logout') doLogout();
    else if (id === 'logout-everywhere') openLogoutEverywhereConfirm();
  };
  const label = state.currentUser ? (state.currentUser.display_name || state.currentUser.username) : word('ui.account_menu_account');
  return Dropdown({
    ariaLabel: word('ui.account_menu_aria'),
    trigger: () => [Icon('members', { size: 16 }), h('span', {}, label)],
    items,
    onSelect,
  });
}
