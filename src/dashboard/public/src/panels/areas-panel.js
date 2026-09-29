// Areas panel -- which ranger looks after which place. An area is a name (plus the
// other names people use for it), one first ranger who gets new reports from there,
// and backups. Three jobs on one page, in the order an operator meets them:
//   1. the areas that exist, and adding or changing one;
//   2. places reports mention that no area covers yet ("unmapped"), each one
//      pointed at an area with a single press;
//   3. reports that look like they are with the wrong area's ranger, each one
//      moved (and handed to that area's ranger) after a confirm.
// Content-swap panel (state.activePanel === 'areas'); the page title and the way
// back come from app-view.js's PanelSwap, so this renders the body only.
//
// Form state is module-level: the panel re-renders on every schedule(), and a value
// held in a render-local variable would be wiped by the next unrelated repaint.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Row } from '/design/src/components/content/row.js';
import { Alert, Skeleton } from '/design/src/components/content/feedback.js';
import { TextField, Select } from '/design/src/components/content/fields.js';
import { Checkbox } from '/design/src/components/form-primitives.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { state, schedule } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchAreas, putArea, deleteArea, postRelocate } from '../api-team.js';
import { api, ApiError } from '../api.js';
import { toast, failMsg } from '../toasts.js';
import { confirmDialog } from '../components/dialog-shell.js';
import { countOf, entityLabel, entityLabelPlural } from '../vocabulary.js';
import { loadPeople, resetPeople, canonicalKey, personName, wrongAreaSentences, suggestedArea } from './area-common.js';

const h = webjsx.createElement;

const MAX_BACKUPS = 6;
const ui = {
  editing: null,          // null | 'new' | an area id
  form: { name: '', primary: '', backups: [], aliases: '', applyNow: false },
  error: '', busy: false,
  people: null,           // { people, canon, nameOf } once loaded
  pick: {},               // unmapped value -> chosen area id
  wrong: { state: 'idle', rows: [], checked: 0, total: 0 },
  wrongPick: {},          // case id -> chosen area id
  busyKeys: new Set(),
};

const loader = createPanelLoader({
  what: 'the areas',
  label: 'loading areas',
  fetch: async () => { resetPeople(); const [areas, people] = await Promise.all([fetchAreas(), loadPeople()]); ui.people = people; return areas; },
  apply: (j) => { state._areas = j; ui.wrong = { state: 'idle', rows: [], checked: 0, total: 0 }; },
});

const parseReport = (raw) => { try { return raw ? JSON.parse(raw) : {}; } catch { return {}; } };
const areasOf = () => (state._areas && state._areas.areas) || [];
const splitNames = (s) => String(s || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

// ---------- adding and changing an area ----------

function startEdit(a) {
  ui.editing = a ? a.id : 'new';
  ui.error = '';
  ui.form = a
    ? { name: a.name, primary: canonicalKey(ui.people, a.primary.key), backups: a.backups.map((b) => canonicalKey(ui.people, b.key)), aliases: a.aliases.join(', '), applyNow: false }
    : { name: '', primary: '', backups: [], aliases: '', applyNow: false };
  schedule();
  setTimeout(() => { const el = document.querySelector('[name=area-name]'); if (el) el.focus(); }, 60);
}
function stopEdit() { ui.editing = null; ui.error = ''; schedule(); }

async function saveArea() {
  if (ui.busy) return;
  const f = ui.form;
  if (!f.name.trim()) { ui.error = 'Give the area a name first.'; schedule(); return; }
  if (!f.primary) { ui.error = 'Choose the ranger who gets new reports from this area.'; schedule(); return; }
  ui.busy = true; ui.error = ''; schedule();
  try {
    const body = { name: f.name.trim(), primary: f.primary, backups: f.backups.filter(Boolean), aliases: splitNames(f.aliases), apply_to_unassigned: !!f.applyNow };
    if (ui.editing && ui.editing !== 'new') body.id = ui.editing;
    const j = await putArea(body);
    const handed = j.applied && j.applied.assigned ? j.applied.assigned.length : 0;
    toast((ui.editing === 'new' ? 'Added the area ' : 'Saved the area ') + (j.area ? j.area.name : f.name.trim()) + '.' + (handed ? ' ' + countOf(handed) + ' nobody held ' + (handed === 1 ? 'was' : 'were') + ' handed to a ranger.' : ''), 'ok');
    ui.editing = null; ui.busy = false;
    loader.reload();
  } catch (e) {
    ui.error = await failMsg(e, 'The area was not saved. Check the details and try again.');
    ui.busy = false; schedule();
  }
}

async function removeArea(a) {
  const ok = await confirmDialog({
    title: 'Remove the area ' + a.name + '?',
    message: 'Reports keep whoever holds them now. Places in this area go back to the "not mapped" list until you add them to another area.',
    confirmLabel: 'Remove ' + a.name, danger: true,
  });
  if (ok === null) return;
  try { await deleteArea(a.id); toast('Removed the area ' + a.name + '.', 'ok'); ui.editing = null; loader.reload(); }
  catch (e) { toast(await failMsg(e, 'The area was not removed. Nothing changed.'), 'err'); }
}

function PersonSelect({ key, name, label, value, onChange, blank }) {
  const p = ui.people ? ui.people.people : [];
  const options = [{ value: '', label: blank }].concat(p.map((m) => ({ value: m.key, label: m.name + ' (' + m.role + ')' })));
  if (value && !options.some((o) => o.value === value)) options.push({ value, label: personName(ui.people, value) });
  return Select({ key, name, label, value, options, onChange });
}

function AreaForm() {
  const f = ui.form;
  const isNew = ui.editing === 'new';
  const current = isNew ? null : areasOf().find((a) => a.id === ui.editing);
  const slots = f.backups.filter(Boolean);
  const showBlank = slots.length < MAX_BACKUPS;
  const setBackup = (i, v) => { const next = f.backups.filter(Boolean); if (v) next[i] = v; else next.splice(i, 1); f.backups = next; schedule(); };
  return Panel({
    key: 'area-form', id: 'area-form',
    title: isNew ? 'Add an area' : 'Change ' + (current ? current.name : 'this area'),
    children: h('form', { class: 'ds-team-form', novalidate: true, onsubmit: (e) => { e.preventDefault(); saveArea(); } },
      h('p', { key: 'lede', class: 'ds-team-lede' }, 'New reports from this area go to the first ranger. If that person cannot take one, it goes to a backup.'),
      TextField({ key: 'tf-name', name: 'area-name', label: 'Area name', value: f.name, maxLength: 80, placeholder: 'e.g. Vhembe', onInput: (v) => { f.name = v; ui.error = ''; } }),
      h('div', { key: 'people', class: 'ds-team-row' },
        PersonSelect({ key: 'sel-primary', name: 'area-primary', label: 'First ranger', value: f.primary, blank: 'Choose a person', onChange: (v) => { f.primary = v; ui.error = ''; schedule(); } }),
        ...slots.map((b, i) => PersonSelect({ key: 'sel-backup-' + i, name: 'area-backup-' + i, label: 'Backup ranger ' + (i + 1), value: b, blank: 'No backup', onChange: (v) => setBackup(i, v) })),
        showBlank ? PersonSelect({ key: 'sel-backup-new', name: 'area-backup-new', label: slots.length ? 'Add another backup' : 'Backup ranger (optional)', value: '', blank: 'No backup', onChange: (v) => setBackup(slots.length, v) }) : null),
      TextField({ key: 'tf-aliases', name: 'area-aliases', label: 'Other names for this area', hint: 'Villages, farms and other spellings people use, separated by commas. Reports that mention any of them count as this area.', value: f.aliases, onInput: (v) => { f.aliases = v; } }),
      Checkbox({ key: 'ck-apply', name: 'area-apply', checked: f.applyNow, label: 'Also give the open reports nobody holds yet to the ranger now', onChange: (v) => { f.applyNow = v; schedule(); } }),
      ui.error ? h('p', { key: 'err', class: 'ds-team-error', role: 'alert' }, ui.error) : null,
      h('div', { key: 'actions', class: 'ds-contact-actions' },
        Btn({ key: 'save', variant: 'primary', disabled: ui.busy, children: ui.busy ? 'Saving...' : (isNew ? 'Add area' : 'Save area'), onClick: saveArea }),
        Btn({ key: 'cancel', variant: 'ghost', children: 'Cancel', onClick: stopEdit }),
        current ? Btn({ key: 'remove', variant: 'link', class: 'ds-contact-erase', children: 'Remove this area', onClick: () => removeArea(current) }) : null)),
  });
}

function AreaList() {
  const areas = areasOf();
  const rows = areas.map((a) => {
    const bits = ['First ranger: ' + personName(ui.people, a.primary.key)];
    if (a.backups.length) bits.push('Backup: ' + a.backups.map((b) => personName(ui.people, b.key)).join(', '));
    if (a.aliases.length) bits.push('Also called: ' + a.aliases.join(', '));
    bits.push(countOf(a.open_cases, 'open ' + entityLabel(), 'open ' + entityLabelPlural()));
    return Row({ key: a.id, title: a.name, sub: bits.join('. '), meta: 'Change', onClick: () => startEdit(a) });
  });
  return Panel({
    key: 'area-list', title: 'Who looks after which place', count: areas.length || undefined,
    children: [
      areas.length ? h('div', { key: 'rows' }, ...rows) : h('p', { key: 'none', class: 'casey-hint' }, 'No areas yet. Add the first one, then reports from that place go to its ranger on their own.'),
      ui.editing ? null : h('div', { key: 'add', class: 'ds-contact-actions' }, Btn({ variant: 'primary', children: 'Add an area', onClick: () => startEdit(null) })),
    ].filter(Boolean),
  });
}

// ---------- places nobody has mapped ----------

async function mapPlace(g, areaId) {
  const a = areasOf().find((x) => x.id === areaId);
  if (!a) return;
  const k = 'map|' + g.value;
  if (ui.busyKeys.has(k)) return;
  ui.busyKeys.add(k); schedule();
  try {
    const j = await putArea({ id: a.id, aliases: [...a.aliases, g.value], apply_to_unassigned: true });
    const got = j.applied && j.applied.assigned ? j.applied.assigned : [];
    const to = [...new Set(got.map((x) => x.to))].join(' and ');
    toast('"' + g.value + '" now counts as ' + a.name + '.' + (got.length ? ' ' + countOf(got.length) + ' nobody held ' + (got.length === 1 ? 'was' : 'were') + ' handed to ' + to + '.' : ''), 'ok');
    delete ui.pick[g.value];
    loader.reload();
  } catch (e) { toast(await failMsg(e, 'That place was not added to ' + a.name + '. Nothing changed.'), 'err'); }
  ui.busyKeys.delete(k); schedule();
}

function Unmapped() {
  const u = (state._areas && state._areas.unmapped) || { total: 0, groups: [] };
  const areas = areasOf();
  const options = [{ value: '', label: 'Choose an area' }].concat(areas.map((a) => ({ value: a.id, label: a.name })));
  const groups = u.groups.map((g, i) => {
    const what = countOf(g.count) + (g.refs && g.refs.length ? ' (' + g.refs.join(', ') + (g.count > g.refs.length ? ' and more' : '') + ')' : '');
    if (g.kind === 'none' || !g.value) {
      return h('div', { key: 'none-' + i, class: 'ds-area-item' }, Row({ title: 'No place written down', sub: what + '. Ask the reporter where the animals are, and write it on the report.' }));
    }
    const label = g.kind === 'association' ? 'Area written on the report' : 'Place on the report';
    const pick = ui.pick[g.value] || '';
    return h('div', { key: 'g-' + g.value, class: 'ds-area-item' },
      Row({ title: g.value, sub: label + '. ' + what }),
      areas.length ? h('div', { class: 'ds-area-actions' },
        Select({ key: 'pick-' + g.value, name: 'map-' + g.value.toLowerCase().replace(/[^a-z0-9]+/g, '-'), label: 'Put "' + g.value + '" in', value: pick, options, onChange: (v) => { ui.pick[g.value] = v; schedule(); } }),
        Btn({ variant: 'primary', disabled: !pick || ui.busyKeys.has('map|' + g.value), children: 'Add to this area', 'aria-label': 'Add ' + g.value + ' to the chosen area', onClick: () => mapPlace(g, pick) })) : null);
  });
  return Panel({
    key: 'area-unmapped', title: 'Places nobody has mapped yet', count: u.total || undefined,
    children: u.groups.length
      ? [h('p', { key: 'lede', class: 'ds-team-lede' }, 'These open ' + entityLabelPlural() + ' mention a place that no area covers, so nobody is looking after them by area. Choose the area each place belongs to.'), ...groups, u.truncated ? h('p', { key: 'more', class: 'casey-hint' }, 'Only the most common places are shown.') : null].filter(Boolean)
      : h('p', { class: 'casey-hint' }, areas.length ? 'Every open ' + entityLabel() + ' names a place that an area covers.' : 'Add an area first. Places that no area covers will be listed here.'),
  });
}

// ---------- reports that look like they are in the wrong area ----------

// The server names the flag only on a single report's detail (GET /api/cases/:id
// carries `area.possibly_wrong_area`), so this reads the most recently active open
// reports one by one, a few at a time, and keeps the flagged ones.
const CHECK_LIMIT = 60;
const isOpen = (c) => !['resolved', 'closed'].includes(c.status);
async function checkWrong() {
  const w = ui.wrong;
  if (w.state === 'loading') return;
  ui.wrong = { state: 'loading', rows: [], checked: 0, total: 0 };
  schedule();
  try {
    const r = await api('/api/cases?limit=200');
    if (!r.ok) throw new ApiError(r.status, null);
    const list = ((await r.json()).cases || []).filter(isOpen)
      .filter((c) => { const rep = parseReport(c.report); return String(rep.location || rep.association || '').trim(); });
    const pool = list.slice(0, CHECK_LIMIT);
    const found = [];
    let next = 0;
    const worker = async () => {
      while (next < pool.length) {
        const c = pool[next++];
        try {
          const d = await api('/api/cases/' + encodeURIComponent(c.id));
          if (!d.ok) continue;
          const j = await d.json();
          const flag = j.area && j.area.possibly_wrong_area;
          if (flag) found.push({ id: c.id, ref: j.case.ref, report: parseReport(j.case.report), holder: j.case.assignee, flag });
        } catch { /* one report that would not open is skipped, the rest are checked */ }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    ui.wrong = { state: 'done', rows: found, checked: pool.length, total: list.length };
  } catch { ui.wrong = { state: 'error', rows: [], checked: 0, total: 0 }; }
  schedule();
}

async function relocate(row, area) {
  const primary = personName(ui.people, area.primary.key);
  const ok = await confirmDialog({
    title: 'Move ' + row.ref + ' to ' + area.name + '?',
    message: 'It will be handed to ' + primary + ', the first ranger for ' + area.name + '. Whoever holds it now will no longer have it. The change is written on the ' + entityLabel() + "'s history.",
    confirmLabel: 'Move ' + row.ref,
  });
  if (ok === null) return;
  const k = 'move|' + row.id;
  ui.busyKeys.add(k); schedule();
  try {
    const j = await postRelocate(row.id, { area: area.name, reassign: true, reason: 'Corrected from the wrong-area list', expected_ref: row.ref });
    toast('Moved ' + row.ref + ' to ' + area.name + (j.assigned_to ? '. It is now with ' + j.assigned_to.name + '.' : '.'), 'ok');
    ui.wrong.rows = ui.wrong.rows.filter((x) => x.id !== row.id);
    loader.reload();
  } catch (e) { toast(await failMsg(e, row.ref + ' was not moved. Nothing changed.'), 'err'); }
  ui.busyKeys.delete(k); schedule();
}

function WrongArea() {
  const w = ui.wrong;
  const areas = areasOf();
  const options = areas.map((a) => ({ value: a.id, label: a.name }));
  let body;
  if (w.state === 'idle') {
    body = h('p', { class: 'casey-hint' }, areas.length ? 'Look through the open ' + entityLabelPlural() + ' for any that seem to be with the wrong area.' : 'Add an area first.');
  } else if (w.state === 'loading') {
    body = Skeleton({ count: 3, height: '1.4em', label: 'checking reports' });
  } else if (w.state === 'error') {
    body = Alert({ kind: 'error', children: 'Could not check the ' + entityLabelPlural() + '. Try again in a moment.' });
  } else if (!w.rows.length) {
    body = h('p', { class: 'casey-hint' }, 'None found. ' + (w.total > w.checked ? 'Checked the ' + w.checked + ' most recently active of ' + w.total + ' open ' + entityLabelPlural() + '.' : 'Checked all ' + w.total + ' open ' + entityLabelPlural() + ' that name a place.'));
  } else {
    body = w.rows.map((r) => {
      const sug = suggestedArea(r.flag);
      const chosenId = ui.wrongPick[r.id] || (sug && areas.some((a) => a.id === sug.id) ? sug.id : '');
      const chosen = areas.find((a) => a.id === chosenId);
      const what = [r.report.species, r.report.location ? 'at ' + r.report.location : ''].filter(Boolean).join(' ');
      return h('div', { key: r.id, class: 'ds-area-item' },
        Row({ title: what || r.ref, sub: r.ref + '. ' + wrongAreaSentences(r.flag, r.report).join(' ') + ' Now with ' + (r.holder && r.holder !== 'agent' ? personName(ui.people, r.holder) : 'nobody') + '.' }),
        h('div', { class: 'ds-area-actions' },
          Select({ key: 'wp-' + r.id, name: 'move-' + r.id, label: 'Move it to', value: chosenId, options: [{ value: '', label: 'Choose an area' }].concat(options), onChange: (v) => { ui.wrongPick[r.id] = v; schedule(); } }),
          Btn({ variant: 'primary', disabled: !chosen || ui.busyKeys.has('move|' + r.id), children: chosen ? 'Move to ' + chosen.name : 'Move it', 'aria-label': 'Move ' + r.ref + ' to the chosen area', onClick: () => relocate(r, chosen) })));
    });
  }
  return Panel({
    key: 'area-wrong', title: 'Reports that may be in the wrong area', count: w.rows.length || undefined,
    children: [
      h('div', { key: 'body' }, ...[].concat(body)),
      h('div', { key: 'look', class: 'ds-contact-actions' }, Btn({ variant: 'ghost', disabled: w.state === 'loading' || !areas.length, children: w.state === 'idle' ? 'Look for them' : 'Look again', onClick: checkWrong })),
    ],
  });
}

export function AreasPanel() {
  loader.ensureLoaded();
  const body = loader.slot(() => h('div', { class: 'ds-people-page' },
    ui.editing ? AreaForm() : null,
    AreaList(),
    Unmapped(),
    WrongArea()));
  return h('div', { class: 'ds-people-page' }, body);
}
