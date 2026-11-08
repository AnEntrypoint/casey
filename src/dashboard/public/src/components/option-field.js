import * as webjsx from '/design/vendor/webjsx/index.js';
import { Select, TextField } from '/design/src/components/content.js';
import { state, schedule } from '../state.js';
import { word } from '../words.js';
const h = webjsx.createElement;

export const OTHER = '__other__';

export function fieldOptions(key) {
  const cfg = state.runConfig || state.config || {};
  const o = cfg.field_options && cfg.field_options[key];
  return Array.isArray(o) ? o : [];
}

const shown = (o) => o.charAt(0).toUpperCase() + o.slice(1);
const listed = (options, value) => options.find((o) => o.toLowerCase() === String(value == null ? '' : value).trim().toLowerCase()) || null;

export function resetOptionField(name) {
  if (!state._optOther) return;
  if (name == null) state._optOther = {}; else delete state._optOther[name];
}

export function OptionField({ name, label, value, options, onChange, hint, maxLength, key } = {}) {
  const other = state._optOther || (state._optOther = {});
  const text = String(value == null ? '' : value);
  const match = listed(options, text);
  const inOther = name in other ? other[name] : (text.trim() !== '' && !match);
  const choice = inOther ? OTHER : (match || '');
  return h('div', { key, class: 'casey-option-field' },
    Select({
      key: 'sel', name, label,
      value: choice,
      options: [
        { value: '', label: word('ui.pick_one') },
        ...options.map((o) => ({ value: o, label: shown(o) })),
        { value: OTHER, label: word('ui.other_write_it') },
      ],
      hint,
      onChange: (v) => {
        if (v === OTHER) { other[name] = true; onChange(match ? '' : text); }
        else { other[name] = false; onChange(v); }
        schedule();
      },
    }),
    inOther ? TextField({
      key: 'other', name: name + '-other', label: word('ui.other_write_label'),
      value: match ? '' : text, maxLength,
      onInput: (v) => onChange(v),
    }) : null);
}
