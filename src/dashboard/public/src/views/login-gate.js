// Full-screen form shown while state.authed is false. A
// not-necessarily-tech-literate operator sees one simple form; on success
// checkSession() flips state.authed and app-view.js's App() renders the real
// shell on the next schedule().
//
// IT HAS TWO STEPS, not one. An account carrying must_change_password (the
// bootstrap admin printed once to the server log, and any account an admin
// creates) authenticates normally -- /api/login returns 200 and sets a real
// session cookie -- and is then refused by authGate on every route except
// /api/change-password. Before this gate handled that, such an account was
// admitted straight into the dashboard, where every fetch came back 403 and
// the shell rendered the only explanation it had for a failing fetch: "This
// browser could not reach the server", plus a map that "could not reach this
// dashboard's own server". The server was reachable and answering; nothing on
// the page said what was actually wrong, no screen anywhere in the SPA could
// change a password, and the printed bootstrap credential was therefore a dead
// end on a fresh deployment. So the second step lives here, before the session
// is handed to the app.
//
// A RELOAD MID-CHANGE IS THE SECOND WAY IN, and it needs the watcher at the
// bottom of this file rather than the login handler: App() renders this gate
// only while state.authed is false, and a page loaded with the flagged cookie
// already on the device resolves whoami through main.js's own boot before
// anything here runs. state.js publishes no authed-changed hook to subscribe
// to, so the watcher reads the resolved session once and then stops.

import * as webjsx from 'webjsx';
import { TextField } from 'ds/components/content.js';
import { api, ApiError, isOfflineError, fetchBranding } from '../api.js';
import { checkSession } from '../auth.js';
import { state, schedule, setAuthed, setConfig } from '../state.js';
import { runRefreshAll } from './nav-config.js';
const h = webjsx.createElement;

const local = {
  step: 'login',
  username: '', password: '',
  newPassword: '', confirmPassword: '',
  notice: '',
  // True on the reload path only: this module holds the password somebody just
  // typed, but a page loaded fresh with the flagged cookie already set holds
  // nothing, and /api/change-password re-verifies the current credential (a
  // session cookie alone must never be enough to rotate the account's own
  // password). So that path has to ask for it.
  needCurrent: false,
  error: '', busy: false,
};

// WHAT A FAILED LOGIN IS ALLOWED TO SAY. The route answers a wrong password, an
// unknown username and an empty body with one identical body, so the screen
// must not undo that by phrasing them differently -- but "invalid username or
// password", the raw API string this used to print, is a machine's sentence and
// tells an operator nothing to do next. The no-signal case is separated because
// it is a different fact and has a different action: an unreachable server
// produced the literal word "offline" here, since that is the service worker's
// own envelope text.
function loginMessage(e) {
  if (isOfflineError(e)) return 'This device cannot reach the dashboard right now, so it could not check your details. Try again once you have signal.';
  if (e instanceof ApiError && e.status === 401) return 'That username and password do not match. Check both and try again -- if you cannot get in, ask whoever set up your account.';
  return 'Log in did not work. Please try again in a moment.';
}

function changeMessage(e) {
  if (isOfflineError(e)) return 'This device cannot reach the dashboard right now, so the new password was not set. Try again once you have signal.';
  if (e instanceof ApiError && e.status === 401) return 'The password you were given is not right. Check it and try again.';
  if (e instanceof ApiError && e.body && e.body.error) return e.body.error;
  return 'The new password could not be set. Please try again in a moment.';
}

// Routed through api() rather than a bare fetch so the connection-lost banner
// keeps tracking reality, and so an unreachable server throws the same shape
// every other call in this app throws. There is no api.js wrapper for this
// route: nothing in the SPA had ever called it.
async function postJson(path, body) {
  const res = await api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* an empty body is not a failure shape */ }
  if (!res.ok) throw new ApiError(res.status, parsed);
  return parsed;
}

async function enterApp() {
  await checkSession();
  // Force an immediate refresh so the app-shell's first authed render
  // shows real data (cases, health pills) instead of whatever the
  // pre-login boot attempt left behind -- see nav-config.js's
  // runRefreshAll() comment for why this was silently stale for up to 15s.
  await runRefreshAll();
}

async function submitLogin(e) {
  e.preventDefault();
  if (local.busy) return;
  local.busy = true; local.error = ''; local.notice = ''; schedule();
  try {
    await postJson('/api/login', { username: local.username, password: local.password });
    // whoami is read here rather than through checkSession() because
    // checkSession() would set state.authed and hand this session to the app --
    // which is exactly what must not happen while the flag is set.
    //
    // A whoami that cannot be read is not a failed login: the credential was
    // already accepted and the cookie is set, so the app is entered and
    // checkSession() re-asks. Only a POSITIVE must_change_password holds the
    // session here, so an unreadable answer can never lock somebody out of a
    // dashboard they have just authenticated to.
    let who = null;
    try { who = await api('/api/whoami').then((r) => r.json()); } catch { who = null; }
    if (who && who.authed && who.must_change_password) {
      local.step = 'change';
      local.error = '';
    } else {
      await enterApp();
    }
  } catch (e2) {
    local.error = loginMessage(e2);
  }
  local.busy = false;
  schedule();
}

async function submitChange(e) {
  e.preventDefault();
  if (local.busy) return;
  // Checked here as well as by the server so the mismatch is caught before a
  // round trip, and so the message names which of the two boxes to look at.
  if (local.newPassword !== local.confirmPassword) {
    local.error = 'The two new passwords are not the same. Type the same one in both boxes.';
    schedule();
    return;
  }
  local.busy = true; local.error = ''; schedule();
  try {
    await postJson('/api/change-password', {
      current_password: local.password,
      new_password: local.newPassword,
    });
    // A PASSWORD CHANGE MAY END THE SESSION THAT MADE IT. changePassword bumps
    // the account's session_epoch, and /api/change-password sets no replacement
    // cookie, so the token in this browser stops verifying the moment the write
    // lands -- witnessed live: the change succeeded, must_change_password went
    // to 0, and the very next request from the same tab was no longer
    // authenticated. Asked rather than assumed, so this stays right if the
    // route ever does re-issue: a session that survived goes straight into the
    // app, and one that did not returns to the login step saying so instead of
    // leaving somebody looking at the form they have just completed.
    await checkSession();
    if (state.authed) {
      await runRefreshAll();
    } else {
      local.step = 'login';
      local.needCurrent = false;
      local.password = '';
      local.newPassword = '';
      local.confirmPassword = '';
      local.notice = 'Your new password is saved. Please log in with it now.';
    }
  } catch (e2) {
    local.error = changeMessage(e2);
  }
  local.busy = false;
  schedule();
}

// A REAL SUBMIT BUTTON, not the kit's Btn. Btn hardcodes type="button" and
// accepts no override, so this form had no submit control at all: pressing
// Enter in the password box, or a phone keyboard's Go key, did nothing at all
// and the only way in was to hit the button. It carries the kit's own
// btn-primary class, so it looks exactly like every other primary control.
function submitButton(label, busyLabel) {
  return h('button', {
    key: 'submit',
    type: 'submit',
    class: 'btn-primary' + (local.busy ? ' is-disabled' : ''),
    disabled: local.busy,
  }, local.busy ? busyLabel : label);
}

export function LoginGate() {
  // dashboard_ui.brand (main.js fetches the ungated /api/branding subset
  // before this ever renders, see main.js's pre-login branch) so a
  // rebranded deployment (e.g. "Herd Health") never shows the literal
  // 'casey' on the very first screen a user sees. Absent -- unchanged.
  const brand = state.config?.dashboard_ui?.brand || 'casey';
  // ONE ELEMENT TYPE FOR THE MESSAGE SLOT, and a stable key. A change that has
  // landed is not an error and must not be dressed as one, but rendering the
  // notice as a <p> where the error is a <div> put two different element types
  // in the same unkeyed child position across renders -- which webjsx's
  // applyDiff cannot morph in place (the same trap the kit's own SearchInput
  // documents), and the notice simply never appeared. Only the class and the
  // live-region role change.
  const message = local.error || local.notice;
  const messageNode = message
    ? h('div', {
      key: 'msg',
      class: local.error ? 'ds-login-error' : 'ds-login-notice',
      role: local.error ? 'alert' : 'status',
    }, message)
    : null;

  if (local.step === 'change') {
    // Keyed distinctly from the login form. The two steps hold different
    // children in different positions, and an unkeyed positional diff between
    // them merges a password box onto a username box rather than replacing the
    // subtree.
    return h('div', { class: 'ds-login-gate' },
      h('form', { key: 'change', class: 'ds-login-form', onsubmit: submitChange },
        h('h1', { key: 'brand', class: 'ds-login-brand' }, brand),
        h('p', { key: 'why' }, 'Before you can use ' + brand + ', please choose your own password. The one you were given works only for this first log in.'),
        local.needCurrent
          ? TextField({ key: 'cur', label: 'The password you were given', type: 'password', value: local.password, onInput: (v) => { local.password = v; schedule(); }, name: 'current_password' })
          : null,
        TextField({ key: 'new', label: 'New password', type: 'password', value: local.newPassword, onInput: (v) => { local.newPassword = v; schedule(); }, name: 'new_password' }),
        TextField({ key: 'confirm', label: 'Type the new password again', type: 'password', value: local.confirmPassword, onInput: (v) => { local.confirmPassword = v; schedule(); }, name: 'confirm_password' }),
        messageNode,
        submitButton('Save my new password', 'Saving...')
      )
    );
  }

  return h('div', { class: 'ds-login-gate' },
    h('form', { key: 'login', class: 'ds-login-form', onsubmit: submitLogin },
      h('h1', { key: 'brand', class: 'ds-login-brand' }, brand),
      TextField({ key: 'user', label: 'Username', value: local.username, onInput: (v) => { local.username = v; schedule(); }, name: 'username' }),
      TextField({ key: 'pass', label: 'Password', type: 'password', value: local.password, onInput: (v) => { local.password = v; schedule(); }, name: 'password' }),
      messageNode,
      submitButton('Log in', 'Logging in...')
    )
  );
}

// THE RELOAD SAFETY NET. main.js resolves the session at boot and sets
// state.authed before any render, so a browser that already holds the flagged
// cookie never reaches submitLogin above and lands in a dashboard where every
// request comes back 403 -- live-witnessed as a shell reporting "This browser
// could not reach the server" against a server that was answering every one of
// them. Dropping the session out of the CLIENT's state puts this gate back on
// screen with the change step open; the cookie itself is untouched and still
// authenticates /api/change-password, which is the one route the server lets a
// flagged account reach.
//
// It polls because state.js has no authed-changed subscription to attach to
// (unlike setActiveId/setAttention, which do). It is bounded rather than
// standing: the first resolved session ends it, and a session that never
// resolves ends it after the boot window rather than ticking for the life of
// the tab.
const FLAG_WATCH_TICK_MS = 250;
const FLAG_WATCH_LIMIT = 80;
let flagWatchTicks = 0;
const flagWatch = setInterval(() => {
  if (++flagWatchTicks > FLAG_WATCH_LIMIT) { clearInterval(flagWatch); return; }
  const user = state.currentUser;
  if (!user) return;
  clearInterval(flagWatch);
  if (!user.must_change_password || local.step === 'change') return;
  local.step = 'change';
  local.needCurrent = true;
  local.error = '';
  setAuthed(false, null);
  schedule();
  // main.js fetches the ungated branding subset only on its NOT-authed branch,
  // and this session is authed -- it is /api/config that the flag refuses. So
  // without this the one screen a new deployment's first operator ever sees
  // would be headed "casey" on a dashboard called something else. Same call and
  // same shape main.js makes pre-login; loadCaseyConfig() replaces it in full
  // once the change clears the flag.
  if (!state.config?.dashboard_ui?.brand) {
    fetchBranding()
      .then((b) => { if (b && (b.brand || b.leaf)) { setConfig({ dashboard_ui: b }); schedule(); } })
      .catch(() => { /* the fallback brand is still a working screen */ });
  }
}, FLAG_WATCH_TICK_MS);
