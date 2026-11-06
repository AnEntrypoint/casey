import * as webjsx from '/design/vendor/webjsx/index.js';
import { Section } from '/design/src/components/content/panel.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { TextField, Select } from '/design/src/components/content/fields.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { schedule } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchPortalConfig, putPortalConfig, putPortalRouterConfig } from '../api-portal.js';
import { toast, failMsg } from '../toasts.js';
import { word } from '../words.js';

const h = webjsx.createElement;

const KIND_BY_TYPE = {
  int: 'int',
  bool: 'bool',
  text: 'text',
  domains: 'list',
  e164: 'string',
  ssid: 'string',
  asn: 'string',
  string: 'string',
};
const PREVIEW_MAX = 80;
const SHORT_TEXT_MAX = 200;
const LIST_ROWS = 6;
const TEXT_ROWS = 4;

let config = null;
let scope = '';
let draft = {};
let resets = {};
let fieldErrors = {};
let serverError = null;
let saving = false;

const kindOf = (spec) => KIND_BY_TYPE[spec.type] || 'string';
const routerEntry = () => (config.routers || []).find((r) => r.router_id === scope) || null;
const overridesInScope = () => (scope ? (routerEntry() || {}).overrides : config.overrides) || {};
const isOverridden = (key) => overridesInScope()[key] != null;
const effectiveValue = (key) => (scope && isOverridden(key) ? overridesInScope()[key] : config.settings[key]);
const fallbackValue = (key) => (scope ? config.settings[key] : config.defaults[key]);

function normalizeSchema(schema) {
  return Object.fromEntries(Object.entries(schema || {}).map(([key, spec]) => [key, spec && typeof spec === 'object' ? spec : {}]));
}

function toForm(value, kind) {
  if (kind === 'bool') return !!value;
  if (kind === 'list') return Array.isArray(value) ? value.join('\n') : '';
  return value == null ? '' : String(value);
}

function parseForm(text, spec, kind) {
  if (kind === 'bool') return { value: !!text };
  if (kind === 'list') return { value: String(text).split('\n').map((line) => line.trim()).filter(Boolean) };
  if (kind !== 'int') return { value: String(text) };
  const trimmed = String(text).trim();
  if (!/^-?\d+$/.test(trimmed)) return { error: word('ui.portal_config_invalid_number') };
  const n = Number(trimmed);
  if ((spec.min != null && n < spec.min) || (spec.max != null && n > spec.max)) {
    return { error: word('ui.portal_config_out_of_range', { min: spec.min ?? '-', max: spec.max ?? '-' }) };
  }
  return { value: n };
}

function displayText(key, kind) {
  if (resets[key]) return toForm(fallbackValue(key), kind);
  if (key in draft) return draft[key];
  return toForm(effectiveValue(key), kind);
}

function previewOf(value) {
  const text = Array.isArray(value) ? value.join(', ') : String(value ?? '');
  return text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) + '...' : text;
}

function statusOf(key) {
  if (scope) return isOverridden(key) ? word('ui.portal_config_set_for_router') : word('ui.portal_config_inherited');
  return isOverridden(key) ? word('ui.portal_config_overridden') : word('ui.portal_config_default');
}

function hintOf(key, spec) {
  const notes = [spec.help, statusOf(key)];
  if (isOverridden(key)) notes.push(word(scope ? 'ui.portal_config_global_value' : 'ui.portal_config_default_value', { value: previewOf(fallbackValue(key)) }));
  if (resets[key]) notes.push(word('ui.portal_config_reset_pending'));
  if (kindOf(spec) === 'list') notes.push(word('ui.portal_config_list_hint'));
  return notes.filter(Boolean).join(' ');
}

function resetDrafts() {
  draft = {};
  resets = {};
  fieldErrors = {};
  serverError = null;
}

function setDraft(key, value) {
  draft[key] = value;
  delete resets[key];
  delete fieldErrors[key];
  if (serverError && serverError.field === key) serverError = null;
  schedule();
}

function toggleReset(key) {
  if (resets[key]) {
    delete resets[key];
  } else {
    resets[key] = true;
    delete draft[key];
  }
  delete fieldErrors[key];
  schedule();
}

function buildPatch() {
  const patch = {};
  const errors = {};
  for (const [key, spec] of Object.entries(config.schema)) {
    if (resets[key]) {
      patch[key] = null;
      continue;
    }
    if (!(key in draft)) continue;
    const kind = kindOf(spec);
    if (draft[key] === toForm(effectiveValue(key), kind)) continue;
    const parsed = parseForm(draft[key], spec, kind);
    if ('error' in parsed) errors[key] = parsed.error;
    else patch[key] = parsed.value;
  }
  return { patch, errors };
}

async function save() {
  const { patch, errors } = buildPatch();
  fieldErrors = errors;
  serverError = null;
  if (Object.keys(errors).length) { schedule(); return; }
  if (!Object.keys(patch).length) {
    toast(word('ui.fields_editor_nothing_to_save'), 'ok');
    schedule();
    return;
  }
  saving = true; schedule();
  try {
    if (scope) await putPortalRouterConfig(scope, patch);
    else await putPortalConfig(patch);
    toast(word('ui.portal_config_saved'), 'ok');
    loader.reload();
  } catch (e) {
    if (e && e.body && e.body.field) serverError = { field: e.body.field, message: e.body.error || '' };
    else toast(await failMsg(e, word('ui.portal_config_save_failed')), 'err');
  }
  saving = false; schedule();
}

function FieldControl(key, spec, error) {
  const kind = kindOf(spec);
  const label = spec.label || key;
  const hint = hintOf(key, spec);
  const value = displayText(key, kind);
  if (kind === 'bool') {
    return h('label', { key, class: 'ds-field portal-config-check' },
      h('input', { type: 'checkbox', name: key, checked: value, onchange: (e) => setDraft(key, e.target.checked) }),
      h('span', { class: 'ds-field-label' }, label),
      h('span', { class: 'ds-field-hint' }, hint),
      error ? h('span', { class: 'ds-field-error', role: 'alert' }, error) : null);
  }
  return TextField({
    key, name: key, label, hint, value, error,
    type: kind === 'int' ? 'number' : 'text',
    min: spec.min, max: spec.max,
    maxLength: kind === 'text' ? spec.maxLength : undefined,
    multiline: kind === 'list' || (kind === 'text' && !(spec.maxLength <= SHORT_TEXT_MAX)),
    rows: kind === 'list' ? LIST_ROWS : TEXT_ROWS,
    onInput: (v) => setDraft(key, v),
  });
}

function ResetControl(key) {
  if (!resets[key] && !isOverridden(key)) return null;
  const label = resets[key]
    ? word('ui.portal_config_reset_cancel')
    : word(scope ? 'ui.portal_config_reset_router' : 'ui.portal_config_reset');
  return Btn({ key: 'reset-' + key, variant: 'ghost', size: 'sm', children: label, onClick: () => toggleReset(key) });
}

function FieldRow(key, spec) {
  const serverMessage = serverError && serverError.field === key ? serverError.message : null;
  const error = fieldErrors[key] || serverMessage || null;
  return h('div', { key: 'field-' + key, class: 'portal-config-field' },
    FieldControl(key, spec, error),
    ResetControl(key));
}

function ScopeSelect() {
  const routerOptions = (config.routers || []).map((r) => ({ value: r.router_id, label: r.name || r.router_id }));
  return Select({
    label: word('ui.portal_config_scope_label'),
    value: scope,
    options: [{ value: '', label: word('ui.portal_config_scope_global') }, ...routerOptions],
    onChange: (value) => { scope = value; resetDrafts(); schedule(); },
  });
}

function ServerErrorNotice() {
  if (!serverError) return null;
  const spec = config.schema[serverError.field] || {};
  return Alert({ kind: 'error', children: word('ui.portal_config_server_error', { field: spec.label || serverError.field, message: serverError.message }) });
}

function SaveButton() {
  return Btn({
    variant: 'primary', children: saving ? word('ui.portal_config_saving') : word('ui.portal_config_save'),
    disabled: saving, onClick: save,
  });
}

function ConfigBody() {
  const fields = Object.entries(config.schema).map(([key, spec]) => FieldRow(key, spec));
  return h('div', { class: 'portal-config' },
    h('p', { class: 'casey-hint' }, word('ui.portal_config_notice_sync')),
    ScopeSelect(),
    ServerErrorNotice(),
    ...fields,
    h('div', { class: 'ds-settings-actions' }, SaveButton()));
}

const loader = createPanelLoader({
  what: () => word('ui.portal_config_what'),
  label: () => word('ui.portal_config_loading'),
  fetch: fetchPortalConfig,
  apply: (j) => {
    config = {
      settings: j.settings || {},
      overrides: j.overrides || {},
      defaults: j.defaults || {},
      schema: normalizeSchema(j.schema),
      routers: j.routers || [],
    };
    if (scope && !config.routers.some((r) => r.router_id === scope)) scope = '';
    resetDrafts();
  },
});

export function PortalConfigEditor() {
  loader.ensureLoaded();
  return Section({ title: word('ui.routers_panel_settings_title'), children: [loader.slot(ConfigBody)] });
}
