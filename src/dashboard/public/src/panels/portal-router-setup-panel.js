import * as webjsx from '/design/vendor/webjsx/index.js';
import { Section } from '/design/src/components/content/panel.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { TextField } from '/design/src/components/content/fields.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { schedule } from '../state.js';
import { createPortalRouter } from '../api-portal.js';
import { toast, failMsg } from '../toasts.js';
import { word } from '../words.js';

const h = webjsx.createElement;

const BLANK = Object.freeze({ name: '', site: '', router_id: '', uplink_ssid: '' });

let form = { ...BLANK };
let fieldErrors = {};
let created = null;
let saving = false;

function setField(key, value) {
  form[key] = value;
  delete fieldErrors[key];
  schedule();
}

function payload() {
  return Object.fromEntries(Object.entries(form).filter(([, v]) => v !== ''));
}

async function create() {
  fieldErrors = {};
  saving = true;
  schedule();
  try {
    created = await createPortalRouter(payload());
    form = { ...BLANK };
    toast(word('ui.router_setup_created'), 'ok');
  } catch (e) {
    if (e && e.body && e.body.field) fieldErrors = { [e.body.field]: e.body.error || '' };
    else toast(await failMsg(e, word('ui.router_setup_failed')), 'err');
  }
  saving = false;
  schedule();
}

async function copyScript() {
  try {
    await navigator.clipboard.writeText(created.bootstrap);
    toast(word('ui.router_setup_copied'), 'ok');
  } catch {
    toast(word('ui.router_setup_copy_failed'), 'err');
  }
}

function Field(key, label, opts = {}) {
  return TextField({
    key,
    name: key,
    label,
    value: form[key],
    error: fieldErrors[key] || null,
    onInput: (v) => setField(key, v),
    ...opts,
  });
}

function ScriptBlock() {
  return h('div', { key: 'created', class: 'portal-router-created' },
    Alert({ kind: 'info', key: 'once', children: word('ui.router_setup_once') }),
    h('pre', { key: 'script', class: 'portal-router-script' }, created.bootstrap),
    Btn({ key: 'copy', variant: 'ghost', children: word('ui.router_setup_copy'), onClick: copyScript }));
}

export function RouterSetupSection() {
  return Section({
    title: word('ui.router_setup_title'),
    children: [
      h('div', { key: 'setup', class: 'portal-router-setup' },
        h('p', { key: 'lede', class: 'casey-hint' }, word('ui.router_setup_lede')),
        h('p', { key: 'secret', class: 'casey-hint' }, word('ui.router_setup_passphrase_note')),
        Field('name', word('ui.router_setup_name')),
        Field('site', word('ui.router_setup_site'), { hint: word('ui.router_setup_site_hint') }),
        Field('router_id', word('ui.router_setup_id'), { hint: word('ui.router_setup_id_hint') }),
        Field('uplink_ssid', word('ui.router_setup_uplink_ssid'), { hint: word('ui.router_setup_uplink_ssid_hint') }),
        h('div', { key: 'actions', class: 'ds-settings-actions' },
          Btn({
            variant: 'primary',
            children: saving ? word('ui.router_setup_creating') : word('ui.router_setup_create'),
            disabled: saving,
            onClick: create,
          })),
        created ? ScriptBlock() : null),
    ],
  });
}
