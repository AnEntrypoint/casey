import * as webjsx from 'webjsx';
import { TextField } from 'ds/components/content.js';
import { api, ApiError, isOfflineError, fetchBranding } from '../api.js';
import { checkSession } from '../auth.js';
import { state, schedule, setAuthed, setConfig } from '../state.js';
import { runRefreshAll } from './nav-config.js';
import { brandName } from '../vocabulary.js';
import { word } from '../words.js';
const h = webjsx.createElement;

const local = {
  step: 'login',
  username: '', password: '',
  newPassword: '', confirmPassword: '',
  notice: '',
  needCurrent: false,
  error: '', busy: false,
};

function loginMessage(e) {
  if (isOfflineError(e)) return word('ui.login_check_failed');
  if (e instanceof ApiError && e.status === 401) return 'That username and password do not match. Check both and try again -- if you cannot get in, ask whoever set up your account.';
  const status = (e instanceof ApiError && e.status) ? ' (error ' + e.status + ')' : '';
  return 'Your details were not checked -- the dashboard itself returned an error' + status + '. This is not your password. Try again in a moment, and tell whoever runs this deployment if it keeps happening.';
}

function changeMessage(e) {
  if (isOfflineError(e)) return word('ui.login_password_failed');
  if (e instanceof ApiError && e.status === 401) return 'The password you were given is not right. Check it and try again.';
  if (e instanceof ApiError && e.body && e.body.error) return e.body.error;
  const status = (e instanceof ApiError && e.status) ? ' (error ' + e.status + ')' : '';
  return 'The new password was not set' + status + ', so the one you were given still works. Try again in a moment, and tell whoever runs this deployment if it keeps happening.';
}

async function postJson(path, body) {
  const res = await api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch {  }
  if (!res.ok) throw new ApiError(res.status, parsed);
  return parsed;
}

async function enterApp() {
  await checkSession();
  await runRefreshAll();
}

async function submitLogin(e) {
  e.preventDefault();
  if (local.busy) return;
  local.busy = true; local.error = ''; local.notice = ''; state.sessionNotice = ''; schedule();
  try {
    await postJson('/api/login', { username: local.username, password: local.password });
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

function submitButton(label, busyLabel) {
  return h('button', {
    key: 'submit',
    type: 'submit',
    class: 'btn-primary' + (local.busy ? ' is-disabled' : ''),
    disabled: local.busy,
  }, local.busy ? busyLabel : label);
}

export function LoginGate() {
  const brand = brandName();
  const message = local.error || local.notice || state.sessionNotice || '';
  const messageNode = message
    ? h('div', {
      key: 'msg',
      class: local.error ? 'ds-login-error' : 'ds-login-notice',
      role: local.error ? 'alert' : 'status',
    }, message)
    : null;

  if (local.step === 'change') {
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
  if (!state.config?.dashboard_ui?.brand) {
    fetchBranding()
      .then((b) => { if (b && (b.brand || b.leaf)) { setConfig({ dashboard_ui: b }); schedule(); } })
      .catch(() => {  });
  }
}, FLAG_WATCH_TICK_MS);
