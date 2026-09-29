// option-field.js -- a report field that has a fixed list of usual answers
// (report-fields.yml `options`, served as /api/config field_options), edited as a
// dropdown that always ends in "Other (write it)".
//
// The list is a convenience and never a gate: choosing Other reveals a text box, and
// whatever is typed there is what is stored (a rare animal such as an ostrich must still
// be possible). A value already on the report that is not on the list opens in Other with
// its text in the box, so nothing is lost or silently re-mapped. The control is the kit's
// native Select, so the keyboard and screen readers get the platform behaviour for free.
//
// State: which fields are in "Other" mode is held per control name in state._optOther,
// because it is a fact about the person's choice that the value alone cannot carry (an
// empty box in Other mode is different from nothing chosen yet).

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Select, TextField } from '/design/src/components/content.js';
import { state, schedule } from '../state.js';
import { word } from '../words.js';
const h = webjsx.createElement;

export const OTHER = '__other__';

/** @returns {string[]} the usual answers for a field, [] when it has none. */
export function fieldOptions(key) {
  const cfg = state.runConfig || state.config || {};
  const o = cfg.field_options && cfg.field_options[key];
  return Array.isArray(o) ? o : [];
}

const shown = (o) => o.charAt(0).toUpperCase() + o.slice(1);
const listed = (options, value) => options.find((o) => o.toLowerCase() === String(value == null ? '' : value).trim().toLowerCase()) || null;

/** Forget the person's "Other" choice for one control, or for all of them. */
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
