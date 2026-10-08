import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Row } from '/design/src/components/content/row.js';
import { Table } from '/design/src/components/content/table.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { TextField } from '/design/src/components/content/fields.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { schedule } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { postRolesImport, fetchRoster } from '../api-team.js';
import { toast, failMsg } from '../toasts.js';
import { confirmDialog } from '../components/dialog-shell.js';
import { word } from '../words.js';

const h = webjsx.createElement;

const b = { text: '', fileName: '', preview: null, previewText: '', applied: false, busy: false, error: '', copied: false, roster: null };

const WIDE = matchMedia('(min-width: 1201px)');
WIDE.addEventListener('change', schedule);

const rosterLoader = createPanelLoader({
  what: () => word('ui.bulk_team_add_what'),
  label: () => word('ui.bulk_team_add_loading'),
  fetch: fetchRoster,
  apply: (j) => { b.roster = j; },
});

const WORDS = {
  preview: { create: 'ui.bulk_team_add_will_be_added', update: 'ui.bulk_team_add_will_be_updated', skip: 'ui.bulk_team_add_no_change_preview', error: 'ui.bulk_team_add_cannot_be_added' },
  done: { create: 'ui.bulk_team_add_added', update: 'ui.bulk_team_add_updated', skip: 'ui.bulk_team_add_no_change_done', error: 'ui.bulk_team_add_not_added' },
};
const verb = (r) => {
  const key = (b.applied ? WORDS.done : WORDS.preview)[r.action];
  return key ? word(key) : r.action;
};
const who = (r) => (r.name || word('ui.bulk_team_add_no_name')) + (r.phone ? ' (' + r.phone + ')' : '');
const detailOf = (r) => [word('ui.bulk_team_add_line', { line: r.line }), verb(r), [r.role, r.area].filter(Boolean).join(', '), r.reason].filter(Boolean).join('. ') + '.';

function summaryLine(s) {
  const bits = [];
  if (s.create) bits.push(word('ui.bulk_team_add_to_add', { count: s.create }));
  if (s.update) bits.push(word('ui.bulk_team_add_to_update', { count: s.update }));
  if (s.skip) bits.push(word('ui.bulk_team_add_with_no_change', { count: s.skip }));
  if (s.error) bits.push(word(s.error === 1 ? 'ui.bulk_team_add_problem_one' : 'ui.bulk_team_add_problem_many', { count: s.error }));
  const total = s.create + s.update + s.skip + s.error;
  if (b.applied) {
    const done = [];
    if (s.create) done.push(word('ui.bulk_team_add_n_added', { count: s.create }));
    if (s.update) done.push(word('ui.bulk_team_add_n_updated', { count: s.update }));
    if (s.skip) done.push(word('ui.bulk_team_add_n_unchanged', { count: s.skip }));
    if (s.error) done.push(word('ui.bulk_team_add_n_not_added', { count: s.error }));
    return word('ui.bulk_team_add_done', { items: done.join(', ') || word('ui.bulk_team_add_nothing_to_do') });
  }
  return word(total === 1 ? 'ui.bulk_team_add_checked_one' : 'ui.bulk_team_add_checked_many', { count: total, items: bits.join(', ') || word('ui.bulk_team_add_nothing_lower') });
}

function resultsText() {
  const p = b.preview;
  if (!p) return '';
  return [summaryLine(p.summary)].concat(p.results.map((r) => [word('ui.bulk_team_add_line', { line: r.line }), r.name || word('ui.bulk_team_add_copy_no_name'), r.phone || word('ui.bulk_team_add_copy_no_number'), r.role || '', r.area || '', verb(r), r.reason || ''].join(' | '))).join('\n');
}

async function check() {
  if (b.busy) return;
  if (!b.text.trim()) { b.error = word('ui.bulk_team_add_paste_first'); schedule(); return; }
  b.busy = true; b.error = ''; b.applied = false; b.copied = false; schedule();
  try {
    const j = await postRolesImport(b.text, true);
    b.preview = j; b.previewText = b.text;
  } catch (e) { b.preview = null; b.error = await failMsg(e, word('ui.bulk_team_add_check_failed')); }
  b.busy = false; schedule();
}

async function apply(onDone) {
  if (b.busy || !b.preview || b.previewText !== b.text) return;
  const s = b.preview.summary;
  const n = s.create + s.update;
  const ok = await confirmDialog({
    title: word(n === 1 ? 'ui.bulk_team_add_confirm_title_one' : 'ui.bulk_team_add_confirm_title_many', { count: n }),
    message: (s.create ? word('ui.bulk_team_add_new_part', { count: s.create }) : '')
      + (s.update ? word('ui.bulk_team_add_updated_part', { count: s.update }) : '')
      + (s.error ? word('ui.bulk_team_add_error_part', { count: s.error }) : '')
      + word('ui.bulk_team_add_confirm_tail'),
    confirmLabel: word(n === 1 ? 'ui.bulk_team_add_add_one' : 'ui.bulk_team_add_add_many', { count: n }),
  });
  if (ok === null) return;
  b.busy = true; b.error = ''; schedule();
  try {
    const j = await postRolesImport(b.previewText, false);
    b.preview = j; b.applied = true;
    toast(summaryLine(j.summary), j.summary.error ? 'warn' : 'ok');
    rosterLoader.reload();
    if (onDone) onDone();
  } catch (e) { b.error = await failMsg(e, word('ui.bulk_team_add_list_not_added')); }
  b.busy = false; schedule();
}

function reset() { Object.assign(b, { text: '', fileName: '', preview: null, previewText: '', applied: false, error: '', copied: false }); schedule(); }

async function copyResults() {
  const text = resultsText();
  try { await navigator.clipboard.writeText(text); b.copied = true; toast(word('ui.bulk_team_add_copy_toast'), 'ok'); }
  catch { b.copied = false; toast(word('ui.bulk_team_add_copy_failed'), 'warn'); }
  schedule();
}

function readFile(e) {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  if (f.size > 200000) { b.error = word('ui.bulk_team_add_too_large'); schedule(); return; }
  const r = new FileReader();
  r.onload = () => { b.text = String(r.result || ''); b.fileName = f.name; b.preview = null; b.applied = false; b.error = ''; schedule(); };
  r.onerror = () => { b.error = word('ui.bulk_team_add_file_unreadable'); schedule(); };
  r.readAsText(f);
}

const headers = () => [
  word('ui.bulk_team_add_h_area'),
  word('ui.bulk_team_add_h_people'),
  word('ui.bulk_team_add_h_smartphone'),
  word('ui.bulk_team_add_h_registered'),
  word('ui.bulk_team_add_h_messaged'),
  word('ui.bulk_team_add_h_first_report'),
];
const figures = (r) => [r.area, String(r.total), String(r.smartphones), String(r.registered), String(r.first_message), String(r.first_case)];

function Results(onDone) {
  const p = b.preview;
  if (!p) return null;
  const stale = !b.applied && b.previewText !== b.text;
  const s = p.summary;
  const canAdd = !b.applied && !stale && s.create + s.update > 0;
  const addKey = (s.create + s.update) === 1 ? 'ui.bulk_team_add_add_one' : 'ui.bulk_team_add_add_many';
  return h('div', { key: 'results', class: 'ds-bulk-results' },
    h('p', { key: 'sum', class: 'ds-bulk-summary', role: 'status' }, summaryLine(s)),
    stale ? Alert({ key: 'stale', kind: 'warn', children: word('ui.bulk_team_add_stale') }) : null,
    h('div', { key: 'rows' }, ...p.results.map((r) => Row({ key: 'r' + r.line, title: who(r), sub: detailOf(r), state: r.action === 'error' ? 'error' : 'default', rail: r.action === 'error' ? 'flame' : undefined }))),
    h('div', { key: 'actions', class: 'ds-contact-actions' },
      b.applied ? null : Btn({ key: 'add', variant: 'primary', disabled: !canAdd || b.busy, children: b.busy ? word('ui.bulk_team_add_adding') : word(addKey, { count: s.create + s.update }), onClick: () => apply(onDone) }),
      Btn({ key: 'copy', variant: 'ghost', children: b.copied ? word('ui.bulk_team_add_copied') : word('ui.bulk_team_add_copy_results'), onClick: copyResults }),
      Btn({ key: 'clear', variant: 'ghost', children: b.applied ? word('ui.bulk_team_add_start_another') : word('ui.bulk_team_add_start_over'), onClick: reset })),
    TextField({ key: 'copybox', name: 'bulk-results', label: word('ui.bulk_team_add_results_label'), multiline: true, rows: 4, value: resultsText(), onInput: () => {} }),
    !b.applied && s.create + s.update === 0 ? h('p', { key: 'none', class: 'casey-hint' }, word('ui.bulk_team_add_nothing_here')) : null);
}

function Entry(onDone) {
  return h('form', { key: 'entry', class: 'ds-team-form', novalidate: true, onsubmit: (e) => { e.preventDefault(); check(); } },
    h('p', { key: 'lede', class: 'ds-team-lede' }, word('ui.bulk_team_add_lede')),
    TextField({ key: 'tf-list', name: 'bulk-text', label: word('ui.bulk_team_add_list_label'), multiline: true, rows: 6, value: b.text, placeholder: word('ui.bulk_team_add_sample'), onInput: (v) => { b.text = v; b.error = ''; schedule(); } }),
    h('label', { key: 'file', class: 'ds-field' },
      h('span', { class: 'ds-field-label' }, b.fileName ? word('ui.bulk_team_add_file_chosen', { file: b.fileName }) : word('ui.bulk_team_add_file_label')),
      h('input', { type: 'file', name: 'bulk-file', accept: '.csv,.txt,text/csv,text/plain', onchange: readFile })),
    b.error ? h('p', { key: 'err', class: 'ds-team-error', role: 'alert' }, b.error) : null,
    h('div', { key: 'actions', class: 'ds-contact-actions' },
      Btn({ variant: 'primary', disabled: b.busy, children: b.busy && !b.preview ? word('ui.bulk_team_add_checking') : word('ui.bulk_team_add_check_list'), onClick: check }),
      b.text || b.preview ? Btn({ variant: 'ghost', children: word('ui.bulk_team_add_clear'), onClick: reset }) : null),
    Results(onDone));
}

function Rollout() {
  rosterLoader.ensureLoaded();
  const body = rosterLoader.slot(() => {
    const r = b.roster || { areas: [], totals: null };
    if (!r.areas.length) return Alert({ kind: 'info', children: word('ui.bulk_team_add_nobody_list') });
    const rows = r.areas.concat(r.totals ? [{ area: word('ui.bulk_team_add_everyone'), ...r.totals }] : []);
    if (WIDE.matches) return Table({ headers: headers(), rows: rows.map(figures) });
    return h('div', {}, ...rows.map((x) => Row({
      key: x.area, title: x.area,
      sub: word(x.total === 1 ? 'ui.bulk_team_add_row_sub_one' : 'ui.bulk_team_add_row_sub_many', {
        total: x.total, smartphones: x.smartphones, registered: x.registered, messaged: x.first_message, first_case: x.first_case,
      }),
    })));
  });
  return Panel({ title: word('ui.bulk_team_add_rollout_title'), children: [body] });
}

export function BulkTeamAdd({ onDone }) {
  return h('div', { class: 'ds-people-page' },
    Panel({ title: word('ui.bulk_team_add_panel_title'), children: Entry(onDone) }),
    Rollout());
}
