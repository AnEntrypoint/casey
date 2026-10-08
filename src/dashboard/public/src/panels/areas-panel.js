import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Row } from '/design/src/components/content/row.js';
import { Alert, Skeleton } from '/design/src/components/content/feedback.js';
import { TextField, Select } from '/design/src/components/content/fields.js';
import { Checkbox } from '/design/src/components/form-primitives.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { state, schedule } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchAreas, fetchWrongArea, putArea, deleteArea, postRelocate } from '../api-team.js';
import { toast, failMsg } from '../toasts.js';
import { confirmDialog } from '../components/dialog-shell.js';
import { countOf, entityLabel } from '../vocabulary.js';
import { loadPeople, resetPeople, canonicalKey, personName, wrongAreaSentences, suggestedArea } from './area-common.js';
import { word } from '../words.js';

const h = webjsx.createElement;

const MAX_BACKUPS = 6;
const ui = {
  editing: null,
  form: { name: '', primary: '', backups: [], aliases: '', lat: '', lon: '', district: '', applyNow: false },
  error: '', busy: false,
  people: null,
  pick: {},
  wrong: { state: 'idle', rows: [], checked: 0, total: 0 },
  wrongPick: {},
  busyKeys: new Set(),
};

const loader = createPanelLoader({
  what: () => word('ui.areas_panel_what'),
  label: () => word('ui.areas_panel_loading'),
  fetch: async () => { resetPeople(); const [areas, people] = await Promise.all([fetchAreas(), loadPeople()]); ui.people = people; return areas; },
  apply: (j) => { state._areas = j; ui.wrong = { state: 'idle', rows: [], checked: 0, total: 0 }; },
});

const areasOf = () => (state._areas && state._areas.areas) || [];
const splitNames = (s) => String(s || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

function startEdit(a) {
  ui.editing = a ? a.id : 'new';
  ui.error = '';
  ui.form = a
    ? { name: a.name, primary: canonicalKey(ui.people, a.primary.key), backups: a.backups.map((b) => canonicalKey(ui.people, b.key)), aliases: a.aliases.join(', '), lat: a.lat == null ? '' : String(a.lat), lon: a.lon == null ? '' : String(a.lon), district: a.district || '', applyNow: false }
    : { name: '', primary: '', backups: [], aliases: '', lat: '', lon: '', district: '', applyNow: false };
  schedule();
  setTimeout(() => { const el = document.querySelector('[name=area-name]'); if (el) el.focus(); }, 60);
}
function stopEdit() { ui.editing = null; ui.error = ''; schedule(); }

async function saveArea() {
  if (ui.busy) return;
  const f = ui.form;
  if (!f.name.trim()) { ui.error = word('ui.areas_panel_name_required'); schedule(); return; }
  if (!f.primary) { ui.error = word('ui.areas_panel_primary_required'); schedule(); return; }
  ui.busy = true; ui.error = ''; schedule();
  try {
    const body = { name: f.name.trim(), primary: f.primary, backups: f.backups.filter(Boolean), aliases: splitNames(f.aliases), lat: f.lat.trim(), lon: f.lon.trim(), district: f.district.trim(), apply_to_unassigned: !!f.applyNow };
    if (ui.editing && ui.editing !== 'new') body.id = ui.editing;
    const j = await putArea(body);
    const handed = j.applied && j.applied.assigned ? j.applied.assigned.length : 0;
    const areaName = j.area ? j.area.name : f.name.trim();
    const handedText = handed ? word(handed === 1 ? 'ui.areas_panel_handed_one' : 'ui.areas_panel_handed_many', { count: countOf(handed) }) : '';
    toast(word(ui.editing === 'new' ? 'ui.areas_panel_added_area' : 'ui.areas_panel_saved_area', { name: areaName }) + handedText, 'ok');
    ui.editing = null; ui.busy = false;
    loader.reload();
  } catch (e) {
    ui.error = await failMsg(e, word('ui.areas_panel_save_failed'));
    ui.busy = false; schedule();
  }
}

async function removeArea(a) {
  const ok = await confirmDialog({
    title: word('ui.areas_panel_remove_title', { name: a.name }),
    message: word('ui.areas_panel_remove_message'),
    confirmLabel: word('ui.areas_panel_remove_confirm', { name: a.name }), danger: true,
  });
  if (ok === null) return;
  try { await deleteArea(a.id); toast(word('ui.areas_panel_removed_area', { name: a.name }), 'ok'); ui.editing = null; loader.reload(); }
  catch (e) { toast(await failMsg(e, word('ui.areas_panel_remove_failed')), 'err'); }
}

function PersonSelect({ key, name, label, value, onChange, blank }) {
  const p = ui.people ? ui.people.people : [];
  const options = [{ value: '', label: blank }].concat(p.map((m) => ({ value: m.key, label: word('ui.areas_panel_person_role', { name: m.name, role: m.role }) })));
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
    title: isNew ? word('ui.areas_panel_add_title') : word('ui.areas_panel_change_title', { name: current ? current.name : word('ui.areas_panel_this_area') }),
    children: h('form', { class: 'ds-team-form', novalidate: true, onsubmit: (e) => { e.preventDefault(); saveArea(); } },
      h('p', { key: 'lede', class: 'ds-team-lede' }, word('ui.areas_panel_lede')),
      TextField({ key: 'tf-name', name: 'area-name', label: word('ui.areas_panel_name_label'), value: f.name, maxLength: 80, placeholder: word('ui.areas_panel_name_placeholder'), onInput: (v) => { f.name = v; ui.error = ''; } }),
      h('div', { key: 'people', class: 'ds-team-row' },
        PersonSelect({ key: 'sel-primary', name: 'area-primary', label: word('ui.areas_panel_first_ranger'), value: f.primary, blank: word('ui.areas_panel_choose_person'), onChange: (v) => { f.primary = v; ui.error = ''; schedule(); } }),
        ...slots.map((b, i) => PersonSelect({ key: 'sel-backup-' + i, name: 'area-backup-' + i, label: word('ui.areas_panel_backup_label', { number: i + 1 }), value: b, blank: word('ui.areas_panel_no_backup'), onChange: (v) => setBackup(i, v) })),
        showBlank ? PersonSelect({ key: 'sel-backup-new', name: 'area-backup-new', label: slots.length ? word('ui.areas_panel_add_another_backup') : word('ui.areas_panel_backup_optional'), value: '', blank: word('ui.areas_panel_no_backup'), onChange: (v) => setBackup(slots.length, v) }) : null),
      TextField({ key: 'tf-aliases', name: 'area-aliases', label: word('ui.areas_panel_aliases_label'), hint: word('ui.areas_panel_aliases_hint'), value: f.aliases, onInput: (v) => { f.aliases = v; } }),
      h('div', { key: 'geo', class: 'ds-team-row' },
        TextField({ key: 'tf-lat', name: 'area-lat', label: word('ui.areas_panel_lat_label'), hint: word('ui.areas_panel_lat_hint'), value: f.lat, onInput: (v) => { f.lat = v; ui.error = ''; } }),
        TextField({ key: 'tf-lon', name: 'area-lon', label: word('ui.areas_panel_lon_label'), value: f.lon, onInput: (v) => { f.lon = v; ui.error = ''; } })),
      Checkbox({ key: 'ck-apply', name: 'area-apply', checked: f.applyNow, label: word('ui.areas_panel_apply_now'), onChange: (v) => { f.applyNow = v; schedule(); } }),
      ui.error ? h('p', { key: 'err', class: 'ds-team-error', role: 'alert' }, ui.error) : null,
      h('div', { key: 'actions', class: 'ds-contact-actions' },
        Btn({ key: 'save', variant: 'primary', disabled: ui.busy, children: ui.busy ? word('ui.areas_panel_saving') : (isNew ? word('ui.areas_panel_add_area') : word('ui.areas_panel_save_area')), onClick: saveArea }),
        Btn({ key: 'cancel', variant: 'ghost', children: word('ui.areas_panel_cancel'), onClick: stopEdit }),
        current ? Btn({ key: 'remove', variant: 'link', class: 'ds-contact-erase', children: word('ui.areas_panel_remove_this_area'), onClick: () => removeArea(current) }) : null)),
  });
}

function AreaList() {
  const areas = areasOf();
  const rows = areas.map((a) => {
    const bits = [word('ui.areas_panel_first_ranger_line', { name: personName(ui.people, a.primary.key) })];
    if (a.backups.length) bits.push(word('ui.areas_panel_backup_line', { names: a.backups.map((b) => personName(ui.people, b.key)).join(', ') }));
    if (a.aliases.length) bits.push(word('ui.areas_panel_also_called', { names: a.aliases.join(', ') }));
    if (a.lat != null && a.lon != null) bits.push(word('ui.areas_panel_placed_at', { lat: a.lat, lon: a.lon }));
    bits.push(countOf(a.open_cases, word('ui.areas_panel_open_entity'), word('ui.areas_panel_open_entity_plural')));
    return Row({ key: a.id, title: a.name, sub: bits.join('. '), meta: word('ui.areas_panel_change'), onClick: () => startEdit(a) });
  });
  return Panel({
    key: 'area-list', title: word('ui.areas_panel_list_title'), count: areas.length || undefined,
    children: [
      areas.length ? h('div', { key: 'rows' }, ...rows) : h('p', { key: 'none', class: 'casey-hint' }, word('ui.areas_panel_none_yet')),
      ui.editing ? null : h('div', { key: 'add', class: 'ds-contact-actions' }, Btn({ variant: 'primary', children: word('ui.areas_panel_add_button'), onClick: () => startEdit(null) })),
    ].filter(Boolean),
  });
}

async function mapPlace(g, areaId) {
  const a = areasOf().find((x) => x.id === areaId);
  if (!a) return;
  const k = 'map|' + g.value;
  if (ui.busyKeys.has(k)) return;
  ui.busyKeys.add(k); schedule();
  try {
    const j = await putArea({ id: a.id, aliases: [...a.aliases, g.value], apply_to_unassigned: true });
    const got = j.applied && j.applied.assigned ? j.applied.assigned : [];
    const to = [...new Set(got.map((x) => x.to))].join(word('ui.areas_panel_and'));
    toast(word('ui.areas_panel_place_mapped', { place: g.value, name: a.name }) + (got.length ? word(got.length === 1 ? 'ui.areas_panel_mapped_handed_one' : 'ui.areas_panel_mapped_handed_many', { count: countOf(got.length), to }) : ''), 'ok');
    delete ui.pick[g.value];
    loader.reload();
  } catch (e) { toast(await failMsg(e, word('ui.areas_panel_place_not_added', { name: a.name })), 'err'); }
  ui.busyKeys.delete(k); schedule();
}

function Unmapped() {
  const u = (state._areas && state._areas.unmapped) || { total: 0, groups: [] };
  const areas = areasOf();
  const options = [{ value: '', label: word('ui.areas_panel_choose_area') }].concat(areas.map((a) => ({ value: a.id, label: a.name })));
  const groups = u.groups.map((g, i) => {
    const what = countOf(g.count) + (g.refs && g.refs.length ? ' (' + g.refs.join(', ') + (g.count > g.refs.length ? word('ui.areas_panel_refs_and_more') : '') + ')' : '');
    if (g.kind === 'none' || !g.value) {
      return h('div', { key: 'none-' + i, class: 'ds-area-item' }, Row({ title: word('ui.areas_panel_no_place_title'), sub: word('ui.areas_panel_no_place_sub', { what }) }));
    }
    const label = g.kind === 'association' ? word('ui.areas_panel_label_association') : word('ui.areas_panel_label_place');
    const pick = ui.pick[g.value] || '';
    return h('div', { key: 'g-' + g.value, class: 'ds-area-item' },
      Row({ title: g.value, sub: word('ui.areas_panel_row_sub', { label, what }) }),
      areas.length ? h('div', { class: 'ds-area-actions' },
        Select({ key: 'pick-' + g.value, name: 'map-' + g.value.toLowerCase().replace(/[^a-z0-9]+/g, '-'), label: word('ui.areas_panel_put_in', { place: g.value }), value: pick, options, onChange: (v) => { ui.pick[g.value] = v; schedule(); } }),
        Btn({ variant: 'primary', disabled: !pick || ui.busyKeys.has('map|' + g.value), children: word('ui.areas_panel_add_to_area'), 'aria-label': word('ui.areas_panel_add_aria', { place: g.value }), onClick: () => mapPlace(g, pick) })) : null);
  });
  return Panel({
    key: 'area-unmapped', title: word('ui.areas_panel_unmapped_title'), count: u.total || undefined,
    children: u.groups.length
      ? [h('p', { key: 'lede', class: 'ds-team-lede' }, word('ui.areas_panel_unmapped_lede')), ...groups, u.truncated ? h('p', { key: 'more', class: 'casey-hint' }, word('ui.areas_panel_truncated')) : null].filter(Boolean)
      : h('p', { class: 'casey-hint' }, areas.length ? word('ui.areas_panel_all_mapped') : word('ui.areas_panel_add_first_unmapped')),
  });
}

const PAGE = 25;
const wrongRow = (r) => ({ id: r.id, ref: r.ref, report: r.report || {}, holder: r.holder ? r.holder.name : '', flag: r.flag, ranger: r.suggested_ranger ? r.suggested_ranger.name : '' });
async function checkWrong(more) {
  const w = ui.wrong;
  if (w.state === 'loading') return;
  const keep = more ? w.rows : [];
  ui.wrong = { state: 'loading', rows: keep, checked: 0, total: w.total || 0 };
  schedule();
  try {
    const j = await fetchWrongArea(keep.length, PAGE);
    ui.wrong = { state: 'done', rows: keep.concat((j.items || []).map(wrongRow)), checked: 0, total: j.total || 0 };
  } catch { ui.wrong = { state: 'error', rows: keep, checked: 0, total: 0 }; }
  schedule();
}

async function relocate(row, area) {
  const primary = personName(ui.people, area.primary.key);
  const ok = await confirmDialog({
    title: word('ui.areas_panel_move_title', { ref: row.ref, name: area.name }),
    message: word('ui.areas_panel_move_message', { primary, name: area.name, entity: entityLabel() }),
    confirmLabel: word('ui.areas_panel_move_confirm', { ref: row.ref }),
  });
  if (ok === null) return;
  const k = 'move|' + row.id;
  ui.busyKeys.add(k); schedule();
  try {
    const j = await postRelocate(row.id, { area: area.name, reassign: true, reason: 'Corrected from the wrong-area list', expected_ref: row.ref });
    toast(j.assigned_to
      ? word('ui.areas_panel_moved_with', { ref: row.ref, name: area.name, holder: j.assigned_to.name })
      : word('ui.areas_panel_moved', { ref: row.ref, name: area.name }), 'ok');
    ui.wrong.rows = ui.wrong.rows.filter((x) => x.id !== row.id);
    loader.reload();
  } catch (e) { toast(await failMsg(e, word('ui.areas_panel_not_moved', { ref: row.ref })), 'err'); }
  ui.busyKeys.delete(k); schedule();
}

function WrongArea() {
  const w = ui.wrong;
  const areas = areasOf();
  const options = areas.map((a) => ({ value: a.id, label: a.name }));
  let body;
  if (w.state === 'idle') {
    body = h('p', { class: 'casey-hint' }, areas.length ? word('ui.areas_panel_look_through') : word('ui.areas_panel_add_first'));
  } else if (w.state === 'loading') {
    body = Skeleton({ count: 3, height: '1.4em', label: word('ui.areas_panel_checking') });
  } else if (w.state === 'error') {
    body = Alert({ kind: 'error', children: word('ui.areas_panel_check_failed') });
  } else if (!w.rows.length) {
    body = h('p', { class: 'casey-hint' }, word('ui.areas_panel_none_found'));
  } else {
    body = w.rows.map((r) => {
      const sug = suggestedArea(r.flag);
      const chosenId = ui.wrongPick[r.id] || (sug && areas.some((a) => a.id === sug.id) ? sug.id : '');
      const chosen = areas.find((a) => a.id === chosenId);
      const what = [r.report.species, r.report.location ? word('ui.areas_panel_at_place', { place: r.report.location }) : ''].filter(Boolean).join(' ');
      return h('div', { key: r.id, class: 'ds-area-item' },
        Row({ title: what || r.ref, sub: word('ui.areas_panel_wrong_sub', {
          ref: r.ref,
          sentences: wrongAreaSentences(r.flag, r.report).join(' '),
          holder: r.holder || word('ui.areas_panel_nobody'),
          ranger: r.ranger ? word('ui.areas_panel_suggested_ranger', { ranger: r.ranger }) : '',
        }) }),
        h('div', { class: 'ds-area-actions' },
          Select({ key: 'wp-' + r.id, name: 'move-' + r.id, label: word('ui.areas_panel_move_to'), value: chosenId, options: [{ value: '', label: word('ui.areas_panel_choose_area') }].concat(options), onChange: (v) => { ui.wrongPick[r.id] = v; schedule(); } }),
          Btn({ variant: 'primary', disabled: !chosen || ui.busyKeys.has('move|' + r.id), children: chosen ? word('ui.areas_panel_move_to_name', { name: chosen.name }) : word('ui.areas_panel_move_it'), 'aria-label': word('ui.areas_panel_move_aria', { ref: r.ref }), onClick: () => relocate(r, chosen) })));
    });
  }
  return Panel({
    key: 'area-wrong', title: word('ui.areas_panel_wrong_title'), count: w.total || undefined,
    children: [
      h('div', { key: 'body' }, ...[].concat(body)),
      w.state === 'done' && w.rows.length < w.total ? h('div', { key: 'more', class: 'ds-contact-actions' }, Btn({ variant: 'ghost', children: word('ui.areas_panel_show_more', { count: w.total - w.rows.length }), onClick: () => checkWrong(true) })) : null,
      h('div', { key: 'look', class: 'ds-contact-actions' }, Btn({ variant: 'ghost', disabled: w.state === 'loading' || !areas.length, children: w.state === 'idle' ? word('ui.areas_panel_look_for') : word('ui.areas_panel_look_again'), onClick: () => checkWrong(false) })),
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
