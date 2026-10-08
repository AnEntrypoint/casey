import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn, Icon } from '/design/src/components/shell.js';
import { TextField, Section, Alert, Skeleton, Panel, Row, DetailRow } from '/design/src/components/content.js';
import { state, schedule } from '../state.js';
import { toast, failMsg } from '../toasts.js';
import { confirmDialog } from '../components/dialog-shell.js';
import { stageLabel, headline } from '../format.js';
import { entityLabel, EntityLabel } from '../vocabulary.js';
import { word } from '../words.js';
import { PhotosStrip } from './field-photos.js';
import { isTechnician, fetchFieldCase, postFieldNote, postFieldIntake, postFieldTransition, postFieldLocation, postSendBack, assigneeName } from '../api-roles.js';
import { postHandoff, postWithdrawHandoff } from '../api-team.js';
import { holderName } from './field-names.js';
import { CaseProgress } from './case-detail/progress.js';
import { Timeline, reportLanguage } from './case-detail/timeline.js';
import { ReplyBox } from './case-detail/reply-box.js';
import { Transitions } from './case-detail/transitions.js';
import { FieldsEditor } from './case-detail/fields-editor.js';
import { OptionField, fieldOptions, resetOptionField } from '../components/option-field.js';
const h = webjsx.createElement;

const fc = { id: null, data: null, loading: false, error: '', confirmedFor: null, draft: {}, note: '', busy: false, lost: false };

function parseReport(raw) { try { return raw ? JSON.parse(raw) : {}; } catch { return {}; } }
const has = (r, k) => r[k] != null && String(r[k]).trim() !== '';
const cfg = () => state.config || {};
const mandatory = () => (cfg().mandatory_minimum && cfg().mandatory_minimum.fields) || [];
const doneStages = () => new Set(['resolved', 'closed', ...(((cfg().mandatory_minimum || {}).blocks_transition_to) || [])]);
const hiddenKeys = () => new Set(cfg().hidden_fields || []);
const fieldDefs = () => (cfg().report_sections || []).flatMap((s) => s.keys.map(([k, label, multi]) => ({ key: k, label, multi, section: s.title }))).filter((d) => !hiddenKeys().has(d.key));

async function load(id) {
  resetOptionField();
  fc.id = id; fc.loading = true; fc.error = ''; fc.lost = false; fc.data = null; fc.confirmedFor = null; fc.draft = {}; fc.note = '';
  try { fc.data = await fetchFieldCase(id); }
  catch (e) { fc.error = (e && e.status === 404) ? word('ui.field_case_not_open', { entity: entityLabel() }) : word('ui.field_case_open_failed', { entity: entityLabel() }); }
  fc.loading = false; schedule();
}
async function reload() {
  if (!fc.id) return;
  const keep = { draft: fc.draft, note: fc.note, confirmedFor: fc.confirmedFor };
  try { fc.data = await fetchFieldCase(fc.id); fc.lost = false; } catch (e) { if (e && e.status === 404) fc.lost = true; }
  Object.assign(fc, keep); schedule();
}

async function failed(e, fallback) {
  if (e && (e.status === 404 || e.status === 403 || e.status === 409)) reload();
  return failMsg(e, fallback);
}

function identity(c) {
  const r = parseReport(c.report);
  const bits = [has(r, 'species') ? String(r.species) : '', has(r, 'location') ? word('ui.field_case_in_location', { location: String(r.location) }) : ''].filter(Boolean).join(' ');
  return bits ? word('ui.field_case_identity', { ref: c.ref, bits }) : c.ref;
}

async function confirmOnce(c) {
  if (fc.confirmedFor === c.id) return true;
  const ok = await confirmDialog({
    title: word('ui.field_case_confirm_title', { ref: c.ref }),
    message: word('ui.field_case_confirm_message', { identity: identity(c), entity: entityLabel() }),
    confirmLabel: word('ui.field_case_confirm_yes', { ref: c.ref }),
  });
  if (ok === null || ok === undefined) return false;
  fc.confirmedFor = c.id; return true;
}

const safeWa = (u) => (typeof u === 'string' && u.startsWith('https://wa.me/') ? u : null);

function Header(c, data, write) {
  const r = parseReport(c.report);
  const where = [has(r, 'species') ? String(r.species) : '', has(r, 'location') ? String(r.location) : ''].filter(Boolean);
  const holderText = holderName(c.assignee) || assigneeName(c.assignee);
  const hold = doneStages().has(c.status) ? word('ui.field_case_hold_closed')
    : (write ? word('ui.field_case_hold_mine') : (holderText ? word('ui.field_case_hold_claimed', { name: holderText }) : word('ui.field_case_hold_open')));
  return h('div', { class: 'casey-case-header', role: 'region', 'aria-label': word('ui.field_case_header_label', { entity: entityLabel() }) },
    h('div', { class: 'casey-case-header-top' }, h('span', { class: 'casey-case-ref-text' }, word('ui.field_case_header_ref', {
      ref: c.ref,
      detail: where.length ? where.join(word('ui.field_case_where_join')) : headline(c.subject || word('ui.field_case_no_details')),
    }))),
    h('div', { class: 'casey-meta-id casey-hint' },
      h('span', {}, word('ui.field_case_reporter', { name: data.reporter_first_name || (write ? word('ui.field_case_name_not_given') : word('ui.field_case_not_shown')) })
        + (data.reporter && data.reporter.shared_phone ? word('ui.field_case_shared_phone', { people: String(data.reporter.people_on_phone) }) : '')),
      h('span', {}, word('ui.field_case_hold_line', { hold })),
      h('span', {}, word('ui.field_case_stage', { stage: stageLabel(c.status) }))));
}

function Checklist(c, r) {
  const items = mandatory();
  if (!items.length) return null;
  return h('div', { role: 'group', 'aria-label': word('ui.field_case_checklist_label', { entity: entityLabel() }) },
    ...items.map((f) => Row({ key: f.key, code: has(r, f.key) ? word('ui.field_case_have') : word('ui.field_case_needed'), title: f.label, sub: has(r, f.key) ? word('ui.field_case_recorded', { value: String(r[f.key]).slice(0, 60) }) : word('ui.field_case_still_needed'), rail: has(r, f.key) ? 'green' : 'flame' })));
}

const doneFrom = (transitions) => (transitions || []).find((t) => doneStages().has(t));
const canReachDone = (transitions) => !!doneFrom(transitions) || (transitions || []).includes('in_progress');

const STATUS_LABEL_KEY = { confirmed: 'ui.field_case_status_confirmed', suspected: 'ui.field_case_status_suspected', ruled_out: 'ui.field_case_status_ruled_out' };

const signoffAsks = () => [
  ['identified_disease', word('ui.field_case_ask_disease'), word('ui.field_case_ask_disease_hint')],
  ...(fieldOptions('diagnosis_status').length ? [['diagnosis_status', word('ui.field_case_ask_status'), word('ui.field_case_ask_status_hint'), [['', word('ui.field_case_choose_one')], ...fieldOptions('diagnosis_status').map((o) => [o, STATUS_LABEL_KEY[o] ? word(STATUS_LABEL_KEY[o]) : o])]]] : []),
  ['recommended_resolution', word('ui.field_case_ask_resolution'), word('ui.field_case_ask_resolution_hint')],
];

async function signOff(c, data) {
  if (!canReachDone(data.transitions)) { toast(word('ui.field_case_cannot_sign', { entity: entityLabel() }), 'warn'); return; }
  const ok = await confirmDialog({ title: word('ui.field_case_sign_title', { ref: c.ref }), message: word('ui.field_case_sign_message', { identity: identity(c) }), confirmLabel: word('ui.field_case_sign_confirm', { ref: c.ref }) });
  if (ok === null || ok === undefined) return;
  const diagnosis = {};
  const report = parseReport(c.report);
  for (const [key, label, hint, choices] of signoffAsks()) {
    if (has(report, key)) continue;
    const text = await confirmDialog({ title: word('ui.field_case_step_title', { label, ref: c.ref }), message: hint, inputLabel: label, choices, confirmLabel: word('ui.field_case_continue') });
    if (text === null || text === undefined) return;
    if (choices && !String(text).trim()) { toast(word('ui.field_case_needed_toast', { label }), 'warn'); return; }
    if (String(text).trim()) diagnosis[key] = String(text).trim();
  }
  try {
    let to = doneFrom(data.transitions);
    if (!to) {
      await postFieldTransition(c.id, c.ref, 'in_progress', 'sign-off started');
      const again = await fetchFieldCase(c.id);
      to = doneFrom(again.transitions);
      if (!to) throw new Error(word('ui.field_case_no_done'));
    }
    await postFieldTransition(c.id, c.ref, to, 'signed off by technician', diagnosis);
    toast(word('ui.field_case_signed_done', { identity: identity(c) }), 'ok'); await reload();
  } catch (e) { toast(await failed(e, word('ui.field_case_sign_failed')), 'err'); await reload(); }
}

async function sendBack(c, r) {
  const missing = mandatory().filter((f) => !has(r, f.key)).map((f) => f.label);
  const text = await confirmDialog({
    title: word('ui.field_case_send_back_title', { ref: c.ref }),
    message: word('ui.field_case_send_back_message', { identity: identity(c), missing: missing.length ? word('ui.field_case_send_back_missing', { list: missing.join(', ') }) : '' }),
    inputLabel: word('ui.field_case_send_back_input'), confirmLabel: word('ui.field_case_send_back_confirm', { ref: c.ref }),
  });
  if (text === null || text === undefined) return;
  try { await postSendBack(c.id, c.ref, text, missing); toast(word('ui.field_case_sent_back', { identity: identity(c) }), 'ok'); await reload(); }
  catch (e) { toast(await failed(e, word('ui.field_case_send_back_failed')), 'err'); }
}

const tagsOf = (c) => String(c.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
const isHandedOver = (c) => tagsOf(c).includes('handed-off');

async function sendToTechnician(c) {
  const ok = await confirmDialog({
    title: word('ui.field_case_tech_title', { ref: c.ref }),
    message: word('ui.field_case_tech_message', { identity: identity(c), entity: entityLabel() }),
    inputLabel: word('ui.field_case_tech_input'), confirmLabel: word('ui.field_case_tech_confirm', { ref: c.ref }),
  });
  if (ok === null || ok === undefined) return;
  try {
    const j = await postHandoff(c.id, c.ref, ok);
    toast(j && j.already ? word('ui.field_case_already_sent', { ref: c.ref }) : word('ui.field_case_sent_tech', { ref: c.ref }), 'ok');
    await reload();
  } catch (e) { toast(await failed(e, word('ui.field_case_not_sent', { ref: c.ref })), 'err'); await reload(); }
}

async function withdrawHandoff(c) {
  const ok = await confirmDialog({ title: word('ui.field_withdraw_title', { ref: c.ref }), message: word('ui.field_withdraw_message', { ref: c.ref }), confirmLabel: word('ui.field_withdraw') });
  if (ok === null || ok === undefined) return;
  try { await postWithdrawHandoff(c.id, c.ref); toast(word('ui.field_withdraw_done', { ref: c.ref }), 'ok'); await reload(); }
  catch (e) { toast(await failed(e, word('ui.field_withdraw_failed', { ref: c.ref })), 'err'); await reload(); }
}


function SignOffCard(c, data, r, write) {
  const tech = isTechnician();
  const missing = mandatory().filter((f) => !has(r, f.key));
  const canSign = tech && !missing.length && canReachDone(data.transitions);
  if (doneStages().has(c.status)) {
    return Section({
      title: word('ui.field_case_signed_heading'),
      children: [Checklist(c, r), h('p', { class: 'casey-hint' }, word('ui.field_case_finished', { entity: entityLabel(), stage: stageLabel(c.status) }))].filter(Boolean),
    });
  }
  return Section({
    title: tech ? word('ui.field_case_ready_heading') : (missing.length ? word('ui.field_case_still_needs', { entity: entityLabel() }) : word('ui.field_case_everything_recorded')),
    children: [
      Checklist(c, r),
      !mandatory().length ? h('p', { class: 'casey-hint' }, word('ui.field_case_nothing_required')) : null,
      !tech && write && isHandedOver(c) ? h('p', { class: 'casey-hint' }, word('ui.field_case_handed_note')) : null,
          !tech && write && isHandedOver(c) ? h('div', { class: 'casey-timeline-actions' },
            Btn({ variant: 'ghost', class: 'field-withdraw', children: word('ui.field_withdraw'), 'aria-label': word('ui.field_withdraw') + ': ' + c.ref, onClick: () => withdrawHandoff(c) })) : null,
      !tech && write && !isHandedOver(c) && mandatory().length && !missing.length ? h('div', { class: 'casey-timeline-actions' },
        Btn({ variant: 'primary', class: 'field-handoff', children: word('ui.field_case_send_tech_button'), 'aria-label': word('ui.field_case_send_tech_label', { ref: c.ref }), onClick: () => sendToTechnician(c) })) : null,
      tech ? h('div', { class: 'casey-timeline-actions' },
        Btn({ variant: 'primary', disabled: !canSign, children: word('ui.field_case_sign_button', { ref: c.ref }), onClick: () => signOff(c, data), title: canSign ? word('ui.field_case_finish_title', { entity: entityLabel() }) : word('ui.field_case_not_ready', { reason: missing.length ? word('ui.field_case_reason_missing') : word('ui.field_case_reason_stage') }) }),
        Btn({ variant: 'ghost', children: word('ui.field_case_send_back_ranger'), onClick: () => sendBack(c, r) })) : null,
      tech && !canSign && missing.length ? h('p', { class: 'casey-hint' }, word('ui.field_case_unavailable_until', { fields: missing.map((f) => f.label).join(', ') })) : null,
      tech && !canSign && !missing.length ? h('p', { class: 'casey-hint' }, word('ui.field_case_unavailable_stage', { entity: entityLabel() })) : null,
    ].filter(Boolean),
  });
}

function ContactCard(c, data) {
  const wa = safeWa(data.reporter_message_link);
  const reporter = data.reporter;
  const askFor = reporter && reporter.reported_by ? (() => {
    const relation = reporter.reported_by.relation ? word('ui.field_case_relation', { relation: reporter.reported_by.relation }) : '';
    return reporter.shared_phone
      ? word('ui.field_case_ask_for_shared', { name: reporter.reported_by.name, relation, entity: entityLabel() })
      : word('ui.field_case_ask_for_plain', { name: reporter.reported_by.name, relation });
  })() : null;
  return Section({
    title: word('ui.field_case_contact_heading'),
    children: [
      h('p', {}, c.external_id_formatted ? word('ui.field_case_number', { number: c.external_id_formatted }) : word('ui.field_case_no_number', { entity: entityLabel() })),
      askFor ? h('p', { class: 'casey-hint' }, askFor) : null,
      wa ? h('a', { class: 'btn btn-primary', href: wa, target: '_blank', rel: 'noopener noreferrer' }, word('ui.field_case_message_wa')) : null,
      h('p', { class: 'casey-hint' }, (data.missing_facts || []).length ? word('ui.field_case_message_asks_list') : word('ui.field_case_message_asks_plain')),
    ].filter(Boolean),
  });
}

function refocusSave() {
  setTimeout(() => {
    const b = document.querySelector('.field-save');
    if (b && (!document.activeElement || document.activeElement === document.body)) b.focus();
  }, 60);
}

async function saveRecord(c) {
  if (fc.busy) return;
  const fields = {};
  for (const [k, v] of Object.entries(fc.draft)) if (String(v).trim()) fields[k] = String(v).trim();
  const note = fc.note.trim();
  if (!Object.keys(fields).length && !note) { toast(word('ui.field_case_nothing_to_save'), 'warn'); return; }
  if (!(await confirmOnce(c))) return;
  fc.busy = true; schedule();
  const report = parseReport(c.report);
  const expected = Object.fromEntries(Object.keys(fields).map((k) => [k, has(report, k) ? String(report[k]) : '']));
  try {
    if (Object.keys(fields).length) await postFieldIntake(c.id, c.ref, fields, expected);
    if (note) await postFieldNote(c.id, c.ref, note, true);
    fc.draft = {}; fc.note = ''; fc.busy = false; resetOptionField();
    await reload();
    toast(word('ui.field_case_saved', { identity: identity(fc.data.case) }), 'ok');
    refocusSave();
  } catch (e) {
    fc.busy = false;
    const conflicts = (e && e.status === 409 && e.body && Array.isArray(e.body.conflicted_fields)) ? e.body.conflicted_fields : [];
    if (conflicts.length) {
      const names = conflicts.map((k) => (fieldDefs().find((d) => d.key === k) || { label: k }).label).join(', ');
      reload();
      toast(word('ui.field_changed_by_other', { fields: names }), 'err');
    } else toast(await failed(e, word('ui.field_case_not_saved', { ref: c.ref })), 'err');
    schedule();
    refocusSave();
  }
}

function RecordForm(c, r) {
  const defs = fieldDefs();
  const missingKeys = new Set(mandatory().filter((f) => !has(r, f.key)).map((f) => f.key));
  const first = defs.filter((d) => missingKeys.has(d.key));
  const rest = defs.filter((d) => !missingKeys.has(d.key));
  const set = (k, v) => { fc.draft[k] = v; schedule(); };
  const field = (d) => {
    const label = d.label + (has(r, d.key) ? word('ui.field_case_now', { value: String(r[d.key]).slice(0, 40) }) : '');
    const opts = fieldOptions(d.key);
    if (opts.length) return OptionField({ key: d.key, name: 'fld-' + d.key, label, value: fc.draft[d.key] || '', options: opts, onChange: (v) => set(d.key, v) });
    return TextField({ key: d.key, label, multiline: !!d.multi, rows: d.multi ? 2 : undefined, value: fc.draft[d.key] || '', onInput: (v) => set(d.key, v) });
  };
  return Section({
    title: word('ui.field_case_record_title', { identity: identity(c) }),
    children: [
      h('p', { class: 'casey-hint' }, word('ui.field_case_record_lead', { ref: c.ref })),
      ...first.map(field),
      TextField({ key: 'note', label: word('ui.field_case_note_free'), multiline: true, rows: 3, value: fc.note, onInput: (v) => { fc.note = v; schedule(); } }),
      rest.length ? h('details', { key: 'more' }, h('summary', {}, word('ui.field_case_other_details')), ...rest.map(field)) : null,
      Btn({ variant: 'primary', class: 'field-save', children: fc.busy ? word('ui.field_case_saving') : word('ui.field_case_save_to', { ref: c.ref }), onClick: () => saveRecord(c) }),
    ].filter(Boolean),
  });
}

function markHere(c) {
  if (!navigator.geolocation) { toast(word('ui.field_case_no_geo'), 'warn'); return; }
  toast(word('ui.field_case_finding'), 'ok');
  navigator.geolocation.getCurrentPosition(async (pos) => {
    if (!(await confirmOnce(c))) return;
    try {
      await postFieldLocation(c.id, c.ref, pos.coords.latitude, pos.coords.longitude);
      toast(word('ui.field_case_marked', { identity: identity(c) }), 'ok'); await reload();
    } catch (e) { toast(await failed(e, word('ui.field_case_position_not_saved', { ref: c.ref })), 'err'); }
  }, () => toast(word('ui.field_case_geo_denied'), 'warn'), { enableHighAccuracy: true, timeout: 15000 });
}

async function quickNote(c, prefix, title, label) {
  const text = ((await confirmDialog({ title: word('ui.field_case_quick_title', { title, ref: c.ref }), message: word('ui.field_case_quick_for', { identity: identity(c) }), inputLabel: label, confirmLabel: word('ui.field_case_save_to', { ref: c.ref }) })) || '').trim();
  if (!text) return;
  if (!(await confirmOnce(c))) return;
  try { await postFieldNote(c.id, c.ref, prefix + text, false); toast(word('ui.field_case_saved', { identity: identity(c) }), 'ok'); await reload(); }
  catch (e) { toast(await failed(e, word('ui.field_case_note_not_saved', { ref: c.ref })), 'err'); }
}

function QuickActions(c) {
  return h('div', { class: 'casey-timeline-actions', role: 'group', 'aria-label': word('ui.field_case_quick_group', { ref: c.ref }) },
    Btn({ variant: 'ghost', children: [Icon('page', { size: 14 }), word('ui.field_case_add_note_button')], 'aria-label': word('ui.field_case_add_note_label', { ref: c.ref }), onClick: () => quickNote(c, '', word('ui.field_case_add_note'), word('ui.field_case_note_label')) }),
    Btn({ variant: 'ghost', children: [Icon('image', { size: 14 }), word('ui.field_case_photo_button')], 'aria-label': word('ui.field_case_photo_label', { ref: c.ref }), onClick: () => quickNote(c, 'Photo: ', word('ui.field_case_describe_photo'), word('ui.field_case_photo_question')) }),
    Btn({ variant: 'ghost', children: [Icon('globe', { size: 14 }), word('ui.field_case_here_button')], 'aria-label': word('ui.field_case_here_label', { ref: c.ref }), onClick: () => markHere(c) }));
}

function Summary(c, r) {
  const rows = fieldDefs().filter((d) => has(r, d.key));
  return Panel({
    title: word('ui.field_case_summary', { entity: EntityLabel() }),
    children: rows.length ? rows.map((d) => DetailRow({ key: d.key, label: d.label, value: String(r[d.key]).slice(0, 300) })) : h('p', { class: 'casey-hint' }, word('ui.field_case_nothing_yet')),
  });
}

export function FieldCaseView({ id, onBack }) {
  if (fc.id !== id && !fc.loading) load(id);
  const back = Btn({ variant: 'link', size: 'sm', class: 'casey-back-btn', 'aria-label': word('ui.field_case_back_label'), onClick: onBack, children: [Icon('chevron-left', { size: 14 }), word('ui.field_case_back')] });
  if (fc.error) return h('div', { class: 'casey-detail-pane' }, back, h('p', { class: 'casey-hint' }, fc.error),
    h('div', { class: 'casey-timeline-actions' }, Btn({ variant: 'primary', size: 'sm', children: word('ui.field_case_try_again'), onClick: () => load(id) })));
  if (!fc.data || fc.data.case.id !== id) return h('div', { class: 'casey-detail-pane' }, back, Skeleton({ count: 5, height: '1.4em', label: word('ui.field_case_loading') }));
  if (fc.lost) {
    const typed = [...Object.values(fc.draft), fc.note].map((v) => String(v || '').trim()).filter(Boolean);
    return h('div', { class: 'casey-detail-pane', key: 'field-case-lost-' + id },
      back,
      Alert({ kind: 'warn', title: word('ui.field_case_lost_title', { entity: entityLabel() }), children: word('ui.field_case_lost_body') }),
      typed.length ? Section({ title: word('ui.field_case_typed_title'), children: typed.map((t, i) => h('p', { key: 'typed' + i }, t)) }) : null);
  }
  const { case: c, events, events_total, transitions } = fc.data;
  const data = fc.data;
  const r = parseReport(c.report);
  const write = data.access === 'write';
  const editable = write;
  const nonDone = (transitions || []).filter((t) => !doneStages().has(t));
  const reload1 = () => reload();
  return h('div', { class: 'casey-detail-pane', key: 'field-case-' + id },
    back,
    Header(c, data, write),
    CaseProgress({ status: c.status }),
    editable ? null : Alert({ kind: 'info', title: word('ui.field_case_readonly_title'), children: isTechnician() ? word('ui.field_case_readonly_tech') : word('ui.field_case_readonly_other') }),
    (isTechnician() || editable) ? SignOffCard(c, data, r, editable) : null,
    editable ? ContactCard(c, data) : null,
    editable ? RecordForm(c, r) : null,
    editable ? QuickActions(c) : null,
    Summary(c, r),
    PhotosStrip(c, r),
    editable ? Transitions({ c, transitions: nonDone, onReload: reload1 }) : null,
    editable ? ReplyBox({ c, events, onReload: reload1 }) : null,
    editable ? h('details', {}, h('summary', {}, word('ui.field_case_change_summary', { ref: c.ref })),
      FieldsEditor({ c, caseTypeSource: null, onSaved: reload1, limited: true, expectedRef: c.ref, beforeSave: () => confirmOnce(c), titleNote: word('ui.field_case_editing', { identity: identity(c) }) })) : null,
    Timeline({ caseId: id, events, eventsTotal: events_total, canTranslate: editable, caseRef: c.ref, language: reportLanguage(c) }));
}

export function resetFieldCase() { fc.id = null; fc.data = null; fc.error = ''; fc.loading = false; }
