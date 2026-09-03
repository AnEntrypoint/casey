// Full-screen login form shown while state.authed is false. A
// not-necessarily-tech-literate operator sees one simple form; on success
// checkSession() flips state.authed and app-view.js's App() renders the real
// shell on the next schedule().

import * as webjsx from 'webjsx';
import { Btn } from 'ds/components/shell.js';
import { TextField } from 'ds/components/content.js';
import { doLogin } from '../auth.js';
import { schedule } from '../state.js';
import { runRefreshAll } from './nav-config.js';
const h = webjsx.createElement;

const local = { username: '', password: '', error: '', busy: false };

async function submit(e) {
  e.preventDefault();
  if (local.busy) return;
  local.busy = true; local.error = ''; schedule();
  try {
    await doLogin(local.username, local.password);
    // Force an immediate refresh so the app-shell's first authed render
    // shows real data (cases, health pills) instead of whatever the
    // pre-login boot attempt left behind -- see nav-config.js's
    // runRefreshAll() comment for why this was silently stale for up to 15s.
    await runRefreshAll();
  } catch (e2) {
    local.error = e2.message || 'Log in failed';
  }
  local.busy = false;
  schedule();
}

export function LoginGate() {
  return h('div', { class: 'ds-login-gate' },
    h('form', { class: 'ds-login-form', onsubmit: submit },
      h('h1', { class: 'ds-login-brand' }, 'casey'),
      TextField({ label: 'Username', value: local.username, onInput: (v) => { local.username = v; schedule(); }, name: 'username' }),
      TextField({ label: 'Password', type: 'password', value: local.password, onInput: (v) => { local.password = v; schedule(); }, name: 'password' }),
      local.error ? h('div', { class: 'ds-login-error', role: 'alert' }, local.error) : null,
      Btn({ variant: 'primary', children: local.busy ? 'Logging in...' : 'Log in', disabled: local.busy, onClick: submit })
    )
  );
}
