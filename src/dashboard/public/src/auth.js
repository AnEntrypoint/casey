import { state, schedule, setAuthed, setConnLost, setSessionRestored } from './state.js';
import * as api from './api.js';
import { syncPreviewBar } from './preview-bar.js';
import { word } from './words.js';

export async function checkSession() {
  try {
    const j = await api.whoami();
    setAuthed(!!(j && j.authed), j && j.authed ? j : null);
    syncPreviewBar(j);
    setSessionRestored(false);
  } catch (e) {
    if (api.isOfflineError(e)) {
      const last = api.lastKnownSession();
      if (last && last.authed) {
        setAuthed(true, last);
        setSessionRestored(true);
        setConnLost(true);
        return state.currentUser;
      }
      setConnLost(true);
    } else {
      state.sessionNotice = word('ui.auth_no_answer');
    }
    setAuthed(false, null);
    setSessionRestored(false);
  }
  return state.currentUser;
}

api.onConnectionRestored(() => {
  if (state.sessionRestored) checkSession();
});

let sessionCheckBusy = false;
api.onSessionLost(async () => {
  if (sessionCheckBusy || !state.authed || (state.currentUser && state.currentUser.must_change_password)) return;
  sessionCheckBusy = true;
  try {
    await checkSession();
    if (!state.authed) state.sessionNotice = word('ui.auth_signed_out');
    schedule();
  } finally { sessionCheckBusy = false; }
});

export async function doLogin(username, password) {
  await api.login(username, password);
  return checkSession();
}

export async function doLogout() {
  try { await api.logout(); } catch {  }
  api.forgetLastKnownSession();
  setAuthed(false, null);
  setSessionRestored(false);
  location.reload();
}

export async function doLogoutEverywhere() {
  await api.logoutEverywhere();
}
