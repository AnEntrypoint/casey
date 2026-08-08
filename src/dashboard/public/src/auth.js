// Session auth: checkSession/doLogin/doLogout/doLogoutEverywhere. The
// login-gate render decision itself lives in views/app-view.js (state.authed).

import { state, setAuthed } from './state.js';
import * as api from './api.js';

export async function checkSession() {
  try {
    const j = await api.whoami();
    setAuthed(!!(j && j.authed), j && j.authed ? j : null);
  } catch {
    setAuthed(false, null);
  }
  return state.currentUser;
}

export async function doLogin(username, password) {
  await api.login(username, password);
  return checkSession();
}

export async function doLogout() {
  try { await api.logout(); } catch { /* best-effort */ }
  setAuthed(false, null);
  location.reload();
}

export async function doLogoutEverywhere() {
  await api.logoutEverywhere();
}
