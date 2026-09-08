// Session auth: checkSession/doLogin/doLogout/doLogoutEverywhere. The
// login-gate render decision itself lives in views/app-view.js (state.authed).
//
// THE RULE THIS FILE EXISTS TO ENFORCE: "you are logged out" and "you have no
// signal" are two different facts, and rendering both as a login form tells
// the operator neither. This used to treat any non-200 /api/whoami as "no
// session", so with the app shell cached and the link down -- the exact
// situation this deployment was built for -- a still-signed-in operator was
// shown a login form they had no network to complete. The distinction comes
// from the service worker's own 503-offline vs the server's own 401
// (api.js's isOfflineError), never from a timeout guess.

import { state, setAuthed, setConnLost, setSessionRestored } from './state.js';
import * as api from './api.js';

export async function checkSession() {
  try {
    const j = await api.whoami();
    setAuthed(!!(j && j.authed), j && j.authed ? j : null);
    setSessionRestored(false);
  } catch (e) {
    if (api.isOfflineError(e)) {
      const last = api.lastKnownSession();
      if (last && last.authed) {
        // Assumed, not proven -- and said so on screen (connection-banner.js).
        // Nothing is unlocked by this: every route still checks the real
        // session cookie server-side, so the worst case of assuming wrongly is
        // that the first request after the link returns 401s and the re-check
        // below drops straight to the login gate.
        setAuthed(true, last);
        setSessionRestored(true);
        setConnLost(true);
        return state.currentUser;
      }
      // No last-known session on this device: a login form is the honest
      // answer even offline, so leave the gate to render -- but say why it
      // cannot be completed rather than looking like an ordinary logout.
      setConnLost(true);
    }
    setAuthed(false, null);
    setSessionRestored(false);
  }
  return state.currentUser;
}

// Recovery without a reload. A page whose session was assumed offline has to
// re-verify the moment a real response comes back, or an operator whose
// session actually expired during the outage would keep looking at a shell
// that quietly cannot save anything. main.js's own 15s health poll is what
// touches the network while offline, so this fires within one poll interval
// of the link returning; the 5s/30s list, attention and map polls then refill
// the data on their own.
api.onConnectionRestored(() => {
  if (state.sessionRestored) checkSession();
});

export async function doLogin(username, password) {
  await api.login(username, password);
  return checkSession();
}

export async function doLogout() {
  try { await api.logout(); } catch { /* best-effort */ }
  // Belt and braces with api.logout()'s own clear: a logout whose request
  // never left the device must still not leave a session behind for the next
  // offline load to assume.
  api.forgetLastKnownSession();
  setAuthed(false, null);
  setSessionRestored(false);
  location.reload();
}

export async function doLogoutEverywhere() {
  await api.logoutEverywhere();
}
