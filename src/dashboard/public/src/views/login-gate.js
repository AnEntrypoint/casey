import * as webjsx from 'webjsx';
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
  confirmMismatch: false,
};

function loginMessage(e) {
  if (isOfflineError(e)) return word('ui.login_check_failed');
  if (e instanceof ApiError && e.status === 401) return word('ui.login_gate_bad_credentials');
  if (e instanceof ApiError && e.status === 429) return word('ui.login_gate_rate_limited');
  const status = (e instanceof ApiError && e.status) ? word('ui.login_gate_error_status', { status: e.status }) : '';
  return word('ui.login_gate_server_error', { status });
}

function changeMessage(e) {
  if (isOfflineError(e)) return word('ui.login_password_failed');
  if (e instanceof ApiError && e.status === 401) return word('ui.login_gate_wrong_given');
  if (e instanceof ApiError && e.body && e.body.error) return e.body.error;
  const status = (e instanceof ApiError && e.status) ? word('ui.login_gate_error_status', { status: e.status }) : '';
  return word('ui.login_gate_change_failed', { status });
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
  if (!local.username.trim()) { local.error = word('ui.login_gate_enter_username'); schedule(); return; }
  if (!local.password) { local.error = word('ui.login_gate_enter_password'); schedule(); return; }
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
    local.error = word('ui.login_gate_mismatch');
    local.confirmMismatch = true;
    schedule();
    return;
  }
  local.busy = true; local.error = ''; local.confirmMismatch = false; schedule();
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
      local.notice = word('ui.login_gate_saved_notice');
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

function loginField({ key, label, type = 'text', name, value, autocomplete, onInput, invalid, describedBy }) {
  return h('label', { key, class: 'ds-field' },
    h('span', { key: 'l', class: 'ds-field-label' }, label),
    h('input', {
      key: 'i', type, name, value, autocomplete,
      oninput: (e) => onInput(e.target.value),
      ...(invalid ? { 'aria-invalid': 'true', 'aria-describedby': describedBy } : {}),
    }));
}

export function LoginGate() {
  const brand = brandName();
  const message = local.error || local.notice || state.sessionNotice || '';
  const messageNode = message
    ? h('div', {
      key: 'msg',
      id: 'ds-login-msg',
      class: local.error ? 'ds-login-error' : 'ds-login-notice',
      role: local.error ? 'alert' : 'status',
    }, message)
    : null;

  if (local.step === 'change') {
    return h('div', { class: 'ds-login-gate' },
      h('form', { key: 'change', class: 'ds-login-form', onsubmit: submitChange },
        h('h1', { key: 'brand', class: 'ds-login-brand' }, brand),
        h('p', { key: 'why' }, word('ui.login_gate_choose_intro', { brand })),
        local.needCurrent
          ? loginField({ key: 'cur', label: word('ui.login_gate_given_label'), type: 'password', value: local.password, onInput: (v) => { local.password = v; schedule(); }, name: 'current_password', autocomplete: 'current-password' })
          : null,
        loginField({ key: 'new', label: word('ui.login_gate_new_label'), type: 'password', value: local.newPassword, onInput: (v) => { local.newPassword = v; schedule(); }, name: 'new_password', autocomplete: 'new-password' }),
        loginField({ key: 'confirm', label: word('ui.login_gate_confirm_label'), type: 'password', value: local.confirmPassword, onInput: (v) => { local.confirmPassword = v; schedule(); }, name: 'confirm_password', autocomplete: 'new-password', invalid: local.confirmMismatch, describedBy: local.confirmMismatch ? 'ds-login-msg' : undefined }),
        messageNode,
        submitButton(word('ui.login_gate_save_button'), word('ui.login_gate_saving'))
      )
    );
  }

  return h('div', { class: 'ds-login-gate' },
    h('form', { key: 'login', class: 'ds-login-form', onsubmit: submitLogin },
      h('h1', { key: 'brand', class: 'ds-login-brand' }, brand),
      loginField({ key: 'user', label: word('ui.login_gate_username'), value: local.username, onInput: (v) => { local.username = v; schedule(); }, name: 'username', autocomplete: 'username' }),
      loginField({ key: 'pass', label: word('ui.login_gate_password'), type: 'password', value: local.password, onInput: (v) => { local.password = v; schedule(); }, name: 'password', autocomplete: 'current-password' }),
      messageNode,
      submitButton(word('ui.login_gate_login_button'), word('ui.login_gate_logging_in'))
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
