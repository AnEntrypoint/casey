// "Add many people at once" -- the training-day path for registering a whole
// list of rangers and technicians without typing each one. Three steps the page
// keeps visibly apart: paste (or choose a file), CHECK (a preview where every
// line says what would happen and why), then ADD (only after the check, only for
// the list that was checked). Below it, the rollout table: how far each area has
// got from "on the list" to "has sent a first report".
//
// Sits in the Reporters section beside single registration (team-registration.js)
// and shares its form-state rule: state is module-level because the panel
// re-renders on every schedule().

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
import { brandName } from '../vocabulary.js';

const h = webjsx.createElement;

const b = { text: '', fileName: '', preview: null, previewText: '', applied: false, busy: false, error: '', copied: false, roster: null };

// Wide enough for the six-column rollout table; below it each area is a row that
// says the same figures in a sentence (a clipped table hides its last columns
// without saying so).
const WIDE = matchMedia('(min-width: 1201px)');
WIDE.addEventListener('change', schedule);

const rosterLoader = createPanelLoader({
  what: 'the rollout figures',
  label: 'loading the rollout figures',
  fetch: fetchRoster,
  apply: (j) => { b.roster = j; },
});

const SAMPLE = 'name, phone, role, area, smartphone\nAnna Mokoena, 079 123 4567, Eco Ranger, Vhembe, yes\nJohan Botha, 082 555 0101, Eco Ranger, Soutpansberg, no';

const WORDS = {
  preview: { create: 'Will be added', update: 'Will be updated', skip: 'No change', error: 'Cannot be added' },
  done: { create: 'Added', update: 'Updated', skip: 'No change', error: 'Not added' },
};
const verb = (r) => (b.applied ? WORDS.done : WORDS.preview)[r.action] || r.action;
const who = (r) => (r.name || 'No name given') + (r.phone ? ' (' + r.phone + ')' : '');
const detailOf = (r) => ['Line ' + r.line, verb(r), [r.role, r.area].filter(Boolean).join(', '), r.reason].filter(Boolean).join('. ') + '.';

function summaryLine(s) {
  const bits = [];
  if (s.create) bits.push(s.create + ' to add');
  if (s.update) bits.push(s.update + ' to update');
  if (s.skip) bits.push(s.skip + ' with no change');
  if (s.error) bits.push(s.error + (s.error === 1 ? ' problem' : ' problems'));
  const total = s.create + s.update + s.skip + s.error;
  if (b.applied) {
    const done = [];
    if (s.create) done.push(s.create + ' added');
    if (s.update) done.push(s.update + ' updated');
    if (s.skip) done.push(s.skip + ' unchanged');
    if (s.error) done.push(s.error + ' not added');
    return 'Done. ' + (done.join(', ') || 'Nothing to do') + '.';
  }
  return total + (total === 1 ? ' line' : ' lines') + ' checked: ' + (bits.join(', ') || 'nothing to do') + '.';
}

function resultsText() {
  const p = b.preview;
  if (!p) return '';
  return [summaryLine(p.summary)].concat(p.results.map((r) => ['Line ' + r.line, r.name || '(no name)', r.phone || '(no number)', r.role || '', r.area || '', verb(r), r.reason || ''].join(' | '))).join('\n');
}

async function check() {
  if (b.busy) return;
  if (!b.text.trim()) { b.error = 'Paste the list first, or choose a file.'; schedule(); return; }
  b.busy = true; b.error = ''; b.applied = false; b.copied = false; schedule();
  try {
    const j = await postRolesImport(b.text, true);
    b.preview = j; b.previewText = b.text;
  } catch (e) { b.preview = null; b.error = await failMsg(e, 'The list could not be checked. Nothing was saved. Try again.'); }
  b.busy = false; schedule();
}

async function apply(onDone) {
  if (b.busy || !b.preview || b.previewText !== b.text) return;
  const s = b.preview.summary;
  const n = s.create + s.update;
  const ok = await confirmDialog({
    title: 'Add ' + n + (n === 1 ? ' person?' : ' people?'),
    message: (s.create ? s.create + ' new. ' : '') + (s.update ? s.update + ' already known, updated. ' : '') + (s.error ? s.error + ' with a problem will be left out. ' : '') + 'No message is sent to anyone. They take up their role when they next message ' + brandName() + '.',
    confirmLabel: 'Add ' + n + (n === 1 ? ' person' : ' people'),
  });
  if (ok === null) return;
  b.busy = true; b.error = ''; schedule();
  try {
    const j = await postRolesImport(b.previewText, false);
    b.preview = j; b.applied = true;
    toast(summaryLine(j.summary), j.summary.error ? 'warn' : 'ok');
    rosterLoader.reload();
    if (onDone) onDone();
  } catch (e) { b.error = await failMsg(e, 'The list was not added. Check it again and try once more.'); }
  b.busy = false; schedule();
}

function reset() { Object.assign(b, { text: '', fileName: '', preview: null, previewText: '', applied: false, error: '', copied: false }); schedule(); }

async function copyResults() {
  const text = resultsText();
  try { await navigator.clipboard.writeText(text); b.copied = true; toast('Copied. Paste it into a message or a sheet.', 'ok'); }
  catch { b.copied = false; toast('Could not copy on this device. Select the text in the box and copy it by hand.', 'warn'); }
  schedule();
}

function readFile(e) {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  if (f.size > 200000) { b.error = 'That file is too large. Use a file with up to 500 lines.'; schedule(); return; }
  const r = new FileReader();
  r.onload = () => { b.text = String(r.result || ''); b.fileName = f.name; b.preview = null; b.applied = false; b.error = ''; schedule(); };
  r.onerror = () => { b.error = 'That file could not be read. Paste the list instead.'; schedule(); };
  r.readAsText(f);
}

function Results(onDone) {
  const p = b.preview;
  if (!p) return null;
  const stale = !b.applied && b.previewText !== b.text;
  const s = p.summary;
  const canAdd = !b.applied && !stale && s.create + s.update > 0;
  return h('div', { key: 'results', class: 'ds-bulk-results' },
    h('p', { key: 'sum', class: 'ds-bulk-summary', role: 'status' }, summaryLine(s)),
    stale ? Alert({ key: 'stale', kind: 'warn', children: 'The list has changed since it was checked. Check it again before adding.' }) : null,
    h('div', { key: 'rows' }, ...p.results.map((r) => Row({ key: 'r' + r.line, title: who(r), sub: detailOf(r), state: r.action === 'error' ? 'error' : 'default', rail: r.action === 'error' ? 'flame' : undefined }))),
    h('div', { key: 'actions', class: 'ds-contact-actions' },
      b.applied ? null : Btn({ key: 'add', variant: 'primary', disabled: !canAdd || b.busy, children: b.busy ? 'Adding...' : 'Add ' + (s.create + s.update) + ((s.create + s.update) === 1 ? ' person' : ' people'), onClick: () => apply(onDone) }),
      Btn({ key: 'copy', variant: 'ghost', children: b.copied ? 'Copied' : 'Copy these results', onClick: copyResults }),
      Btn({ key: 'clear', variant: 'ghost', children: b.applied ? 'Start another list' : 'Start over', onClick: reset })),
    TextField({ key: 'copybox', name: 'bulk-results', label: 'These results, as text', multiline: true, rows: 4, value: resultsText(), onInput: () => {} }),
    !b.applied && s.create + s.update === 0 ? h('p', { key: 'none', class: 'casey-hint' }, 'Nothing here can be added. Fix the lines that have a problem, or paste a different list.') : null);
}

function Entry(onDone) {
  return h('form', { key: 'entry', class: 'ds-team-form', novalidate: true, onsubmit: (e) => { e.preventDefault(); check(); } },
    h('p', { key: 'lede', class: 'ds-team-lede' }, 'Add a whole list in one go. Put one person on each line: name, WhatsApp number, role, area, and whether they have a smartphone (yes or no). Nothing is saved until you have checked the list and pressed Add.'),
    TextField({ key: 'tf-list', name: 'bulk-text', label: 'The list', multiline: true, rows: 6, value: b.text, placeholder: SAMPLE, onInput: (v) => { b.text = v; b.error = ''; schedule(); } }),
    h('label', { key: 'file', class: 'ds-field' },
      h('span', { class: 'ds-field-label' }, b.fileName ? 'File chosen: ' + b.fileName : 'Or choose a spreadsheet saved as .csv'),
      h('input', { type: 'file', name: 'bulk-file', accept: '.csv,.txt,text/csv,text/plain', onchange: readFile })),
    b.error ? h('p', { key: 'err', class: 'ds-team-error', role: 'alert' }, b.error) : null,
    h('div', { key: 'actions', class: 'ds-contact-actions' },
      Btn({ variant: 'primary', disabled: b.busy, children: b.busy && !b.preview ? 'Checking...' : 'Check the list', onClick: check }),
      b.text || b.preview ? Btn({ variant: 'ghost', children: 'Clear', onClick: reset }) : null),
    Results(onDone));
}

// ---------- rollout table ----------

// A function: the brand is config, which has not arrived when this module is evaluated.
const headers = () => ['Area', 'People', 'With a smartphone', 'Registered on WhatsApp', 'Has messaged ' + brandName(), 'Has sent a first report'];
const figures = (r) => [r.area, String(r.total), String(r.smartphones), String(r.registered), String(r.first_message), String(r.first_case)];

function Rollout() {
  rosterLoader.ensureLoaded();
  const body = rosterLoader.slot(() => {
    const r = b.roster || { areas: [], totals: null };
    if (!r.areas.length) return Alert({ kind: 'info', children: 'Nobody is on the training list yet. People added with the list above appear here, grouped by area.' });
    const rows = r.areas.concat(r.totals ? [{ area: 'Everyone', ...r.totals }] : []);
    if (WIDE.matches) return Table({ headers: headers(), rows: rows.map(figures) });
    return h('div', {}, ...rows.map((x) => Row({
      key: x.area, title: x.area,
      sub: x.total + (x.total === 1 ? ' person' : ' people') + '. ' + x.smartphones + ' with a smartphone, ' + x.registered + ' registered on WhatsApp, ' + x.first_message + ' have messaged ' + brandName() + ', ' + x.first_case + ' have sent a first report.',
    })));
  });
  return Panel({ title: 'How the rollout is going, by area', children: [body] });
}

export function BulkTeamAdd({ onDone }) {
  return h('div', { class: 'ds-people-page' },
    Panel({ title: 'Add many people at once', children: Entry(onDone) }),
    Rollout());
}
