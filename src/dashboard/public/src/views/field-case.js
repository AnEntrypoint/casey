// field-case.js -- one report as an eco ranger or an animal health technician
// sees it. Built from the same case-detail pieces the operator console uses
// (progress rail, timeline, reply box, stage buttons, edit form), but arranged
// around what this person is here to do, and with two rules the operator view
// does not need:
//
//  1. It is never unclear WHICH report this is. A header stays on screen with
//     the reference, the species and place, the reporter's first name and who
//     holds the report; the form that records what the person learned repeats
//     that identity in its title, asks once per opened report for a click that
//     names the reference, and every write carries `expected_ref` so the server
//     refuses (409) a write that is not for the report in the URL.
//  2. What they see and touch is what the server allows them: the reporter's
//     number and the write forms appear only on a report assigned to them; a
//     report they can merely see (their own, or one waiting for sign-off) is
//     read-only.
import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn, Icon } from '/design/src/components/shell.js';
import { TextField, Section, Alert, Skeleton, Panel, Row, DetailRow } from '/design/src/components/content.js';
import { state, schedule } from '../state.js';
import { toast, failMsg } from '../toasts.js';
import { confirmDialog } from '../components/dialog-shell.js';
import { stageLabel, headline } from '../format.js';
import { entityLabel, EntityLabel } from '../vocabulary.js';
import { isTechnician, fetchFieldCase, postFieldNote, postFieldIntake, postFieldTransition, postFieldLocation, postSendBack, assigneeName } from '../api-roles.js';
import { postHandoff } from '../api-team.js';
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
// Fields this login's screen hides (dashboard_ui.hidden_fields, resolved per role by the
// server): a display setting, the stored report keeps them. Never a mandatory field.
const hiddenKeys = () => new Set(cfg().hidden_fields || []);
const fieldDefs = () => (cfg().report_sections || []).flatMap((s) => s.keys.map(([k, label, multi]) => ({ key: k, label, multi, section: s.title }))).filter((d) => !hiddenKeys().has(d.key));

async function load(id) {
  resetOptionField();
  fc.id = id; fc.loading = true; fc.error = ''; fc.lost = false; fc.data = null; fc.confirmedFor = null; fc.draft = {}; fc.note = '';
  try { fc.data = await fetchFieldCase(id); }
  catch (e) { fc.error = (e && e.status === 404) ? 'This ' + entityLabel() + ' is not one you can open.' : 'Could not open this ' + entityLabel() + '. Go back and try again.'; }
  fc.loading = false; schedule();
}
async function reload() {
  if (!fc.id) return;
  const keep = { draft: fc.draft, note: fc.note, confirmedFor: fc.confirmedFor };
  // A 404 here means the report is no longer this person's to open (an operator gave it
  // to someone else while this screen sat open). That is said on screen; any other failure
  // keeps what is showing.
  try { fc.data = await fetchFieldCase(fc.id); fc.lost = false; } catch (e) { if (e && e.status === 404) fc.lost = true; }
  Object.assign(fc, keep); schedule();
}

// The message for a failed write. A refusal that means "this screen is out of date" also
// re-reads the report so the screen catches up with what the server now says.
async function failed(e, fallback) {
  if (e && (e.status === 404 || e.status === 403 || e.status === 409)) reload();
  return failMsg(e, fallback);
}

// "CASE-1042 (cattle in Musina)" -- the words used everywhere the screen names
// the report it is about.
function identity(c) {
  const r = parseReport(c.report);
  const bits = [has(r, 'species') ? String(r.species) : '', has(r, 'location') ? 'in ' + String(r.location) : ''].filter(Boolean).join(' ');
  return c.ref + (bits ? ' (' + bits + ')' : '');
}

// One click per opened report that names the reference. Not per keystroke, not
// per save: once it is given for this report it stays given until another
// report is opened.
async function confirmOnce(c) {
  if (fc.confirmedFor === c.id) return true;
  const ok = await confirmDialog({
    title: 'Record on ' + c.ref + '?',
    message: 'You are about to change ' + identity(c) + '. Is this the ' + entityLabel() + ' you are working on?',
    confirmLabel: 'Yes, this is ' + c.ref,
  });
  if (ok === null || ok === undefined) return false;
  fc.confirmedFor = c.id; return true;
}

const safeWa = (u) => (typeof u === 'string' && u.startsWith('https://wa.me/') ? u : null);

function Header(c, data, write) {
  const r = parseReport(c.report);
  const where = [has(r, 'species') ? String(r.species) : '', has(r, 'location') ? String(r.location) : ''].filter(Boolean);
  const holder = write ? 'You' : (holderName(c.assignee) || assigneeName(c.assignee) || 'Nobody yet');
  return h('div', { class: 'casey-case-header', role: 'region', 'aria-label': 'Which ' + entityLabel() + ' this is' },
    h('div', { class: 'casey-case-header-top' }, h('span', { class: 'casey-case-ref-text' }, c.ref + ' -- ' + (where.length ? where.join(' in ') : headline(c.subject || 'No details yet')))),
    h('div', { class: 'casey-meta-id casey-hint' },
      'Reporter: ' + (data.reporter_first_name || (write ? 'name not given' : 'not shown')) + (data.reporter && data.reporter.shared_phone ? ' (shared phone, ' + data.reporter.people_on_phone + ' people)' : '') + ' | Held by: ' + holder + ' | Stage: ' + stageLabel(c.status)));
}

function Checklist(c, r) {
  const items = mandatory();
  if (!items.length) return null;
  // The kit hides a Row's `code` column on a phone, so what is recorded and what is still
  // needed is said in the sub line (visible at every width), never by the rail colour alone.
  // role=group, not list: the kit Row is a plain div, so a list would own non-listitem children.
  return h('div', { role: 'group', 'aria-label': 'What this ' + entityLabel() + ' needs before it can be signed off' },
    ...items.map((f) => Row({ key: f.key, code: has(r, f.key) ? 'Have' : 'Needed', title: f.label, sub: has(r, f.key) ? 'Recorded: ' + String(r[f.key]).slice(0, 60) : 'Still needed', rail: has(r, f.key) ? 'green' : 'flame' })));
}

// A report still at "new" cannot jump to done in the workflow, so a sign-off from
// there first takes the one legal step (working on it) and then the done stage.
const doneFrom = (transitions) => (transitions || []).find((t) => doneStages().has(t));
const canReachDone = (transitions) => !!doneFrom(transitions) || (transitions || []).includes('in_progress');

// The two facts a sign-off records (report-fields.yml signoff_diagnosis).
const SIGNOFF_ASKS = [
  ['identified_disease', 'Disease identified', 'What do you find this to be? Write what you found, in your own words.'],
  ['recommended_resolution', 'Recommended resolution', 'What should be done? This is recorded with the sign-off.'],
];

async function signOff(c, data) {
  if (!canReachDone(data.transitions)) { toast('This ' + entityLabel() + ' cannot be signed off from where it is now.', 'warn'); return; }
  const ok = await confirmDialog({ title: 'Sign off ' + c.ref + '?', message: 'This closes ' + identity(c) + ' as finished. Only do this once help has been given.', confirmLabel: 'Sign off ' + c.ref });
  if (ok === null || ok === undefined) return;
  // The diagnosis rides with the sign-off: the disease identified and what is recommended.
  // Only what the record does not already hold is asked for (a technician's earlier entry stands).
  const diagnosis = {};
  const report = parseReport(c.report);
  for (const [key, label, hint] of SIGNOFF_ASKS) {
    if (has(report, key)) continue;
    const text = await confirmDialog({ title: label + ' -- ' + c.ref, message: hint, inputLabel: label, confirmLabel: 'Continue' });
    if (text === null || text === undefined) return;
    if (String(text).trim()) diagnosis[key] = String(text).trim();
  }
  try {
    let to = doneFrom(data.transitions);
    if (!to) {
      await postFieldTransition(c.id, c.ref, 'in_progress', 'sign-off started');
      const again = await fetchFieldCase(c.id);
      to = doneFrom(again.transitions);
      if (!to) throw new Error('It could not be moved to done from there.');
    }
    await postFieldTransition(c.id, c.ref, to, 'signed off by technician', diagnosis);
    toast('Signed off ' + identity(c) + '.', 'ok'); await reload();
  } catch (e) { toast(await failed(e, 'It was not signed off. Nothing changed -- try again.'), 'err'); await reload(); }
}

async function sendBack(c, r) {
  const missing = mandatory().filter((f) => !has(r, f.key)).map((f) => f.label);
  const text = await confirmDialog({
    title: 'Send ' + c.ref + ' back',
    message: 'This tells whoever is working ' + identity(c) + ' what is still needed' + (missing.length ? ' (' + missing.join(', ') + ')' : '') + '.',
    inputLabel: 'What should they do?', confirmLabel: 'Send back ' + c.ref,
  });
  if (text === null || text === undefined) return;
  try { await postSendBack(c.id, c.ref, text, missing); toast('Sent back ' + identity(c) + '.', 'ok'); await reload(); }
  catch (e) { toast(await failed(e, 'It was not sent back. Nothing changed -- try again.'), 'err'); }
}

const tagsOf = (c) => String(c.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
const isHandedOver = (c) => tagsOf(c).includes('handed-off');

// The ranger's hand-over: the record is complete, so the technician is told it is ready for sign-off.
// The ranger keeps the report and can still add to it; the technician's "send back" reverses it.
async function sendToTechnician(c) {
  const ok = await confirmDialog({
    title: 'Send ' + c.ref + ' to the technician?',
    message: 'This tells the animal health technician that ' + identity(c) + ' is complete and ready to sign off. You keep the ' + entityLabel() + ' and can still add to it. If the technician needs more, they send it back to you.',
    inputLabel: 'A note for the technician (optional)', confirmLabel: 'Send ' + c.ref,
  });
  if (ok === null || ok === undefined) return;
  try {
    const j = await postHandoff(c.id, c.ref, ok);
    toast(j && j.already ? c.ref + ' had already been sent to the technician.' : 'Sent ' + c.ref + ' to the technician.', 'ok');
    await reload();
  } catch (e) { toast(await failed(e, c.ref + ' was not sent. Nothing changed -- try again.'), 'err'); await reload(); }
}

function SignOffCard(c, data, r, write) {
  const tech = isTechnician();
  const missing = mandatory().filter((f) => !has(r, f.key));
  const canSign = tech && !missing.length && canReachDone(data.transitions);
  // Already finished: no sign-off or send-back to offer (the workflow would only let a
  // second "done" step close it further), just the plain fact.
  if (doneStages().has(c.status)) {
    return Section({
      title: 'Signed off',
      children: [Checklist(c, r), h('p', { class: 'casey-hint' }, 'This ' + entityLabel() + ' is finished (' + stageLabel(c.status) + '). Nothing more to sign off.')].filter(Boolean),
    });
  }
  return Section({
    title: tech ? 'Ready to sign off?' : (missing.length ? 'What this ' + entityLabel() + ' still needs' : 'Everything needed is recorded'),
    children: [
      Checklist(c, r),
      !mandatory().length ? h('p', { class: 'casey-hint' }, 'Nothing is required before sign-off on this deployment.') : null,
      !tech && write && isHandedOver(c) ? h('p', { class: 'casey-hint' }, 'Sent to the technician for sign-off. They will sign it off, or send it back to you with what is missing. If you sent it by mistake, ask the technician or an operator to send it back.') : null,
      !tech && write && !isHandedOver(c) && mandatory().length && !missing.length ? h('div', { class: 'casey-timeline-actions' },
        Btn({ variant: 'primary', class: 'field-handoff', children: 'Send to technician', 'aria-label': 'Send ' + c.ref + ' to the technician', onClick: () => sendToTechnician(c) })) : null,
      tech ? h('div', { class: 'casey-timeline-actions' },
        Btn({ variant: 'primary', disabled: !canSign, children: 'Sign off ' + c.ref, onClick: () => signOff(c, data), title: canSign ? 'Finish this ' + entityLabel() : 'Not ready: ' + (missing.length ? 'something is still missing' : 'it cannot move to done from here') }),
        Btn({ variant: 'ghost', children: 'Send back to ranger', onClick: () => sendBack(c, r) })) : null,
      tech && !canSign && missing.length ? h('p', { class: 'casey-hint' }, 'Sign off is unavailable until: ' + missing.map((f) => f.label).join(', ') + ' are recorded.') : null,
    ].filter(Boolean),
  });
}

function ContactCard(c, data) {
  const wa = safeWa(data.reporter_message_link);
  return Section({
    title: 'Reach the reporter',
    children: [
      h('p', {}, c.external_id_formatted ? 'Number: ' + c.external_id_formatted : 'No number is on file for this ' + entityLabel() + '.'),
      // Several people can use one phone: say who gave this report so they ask for that person by name, and
      // that whoever answers may be someone else (src/phone-persons.js). Nothing for a phone with nobody recorded.
      data.reporter && data.reporter.reported_by ? h('p', { class: 'casey-hint' }, 'Ask for ' + data.reporter.reported_by.name + (data.reporter.reported_by.relation ? ' (' + data.reporter.reported_by.relation + ')' : '') + (data.reporter.shared_phone ? '. Other people use this phone too, so do not discuss the ' + entityLabel() + ' with anyone else who answers.' : '.')) : null,
      wa ? h('a', { class: 'btn btn-primary', href: wa, target: '_blank', rel: 'noopener noreferrer' }, 'Message reporter on WhatsApp') : null,
      h('p', { class: 'casey-hint' }, 'The message asks them to write to the assistant again' + ((data.missing_facts || []).length ? ' and lists what is still needed.' : '.') + ' Showing this number is written to the timeline.'),
    ].filter(Boolean),
  });
}

// The save button is re-created while it says "Saving..."; keyboard focus goes back to it once the
// save has finished, unless the person has already moved on to something else.
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
  if (!Object.keys(fields).length && !note) { toast('Nothing to save yet -- fill in a line first.', 'warn'); return; }
  if (!(await confirmOnce(c))) return;
  fc.busy = true; schedule();
  try {
    if (Object.keys(fields).length) await postFieldIntake(c.id, c.ref, fields);
    if (note) await postFieldNote(c.id, c.ref, note, true);
    fc.draft = {}; fc.note = ''; fc.busy = false; resetOptionField();
    await reload();
    toast('Saved to ' + identity(fc.data.case) + '.', 'ok');
    refocusSave();
  } catch (e) {
    fc.busy = false;
    toast(await failed(e, 'Nothing was saved to ' + c.ref + '. What you typed is still here -- try again.'), 'err');
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
    const label = d.label + (has(r, d.key) ? ' (now: ' + String(r[d.key]).slice(0, 40) + ')' : '');
    const opts = fieldOptions(d.key);
    // A field with a fixed list of usual answers (species) is a dropdown ending in "Other (write it)".
    if (opts.length) return OptionField({ key: d.key, name: 'fld-' + d.key, label, value: fc.draft[d.key] || '', options: opts, onChange: (v) => set(d.key, v) });
    return TextField({ key: d.key, label, multiline: !!d.multi, rows: d.multi ? 2 : undefined, value: fc.draft[d.key] || '', onInput: (v) => set(d.key, v) });
  };
  return Section({
    title: 'Record what you learned on ' + identity(c),
    children: [
      h('p', { class: 'casey-hint' }, 'Everything you save here is marked as passed on by you, not written by the reporter. It goes onto ' + c.ref + ' only.'),
      ...first.map(field),
      TextField({ key: 'note', label: 'What the reporter told you (free words)', multiline: true, rows: 3, value: fc.note, onInput: (v) => { fc.note = v; schedule(); } }),
      rest.length ? h('details', { key: 'more' }, h('summary', {}, 'Other details'), ...rest.map(field)) : null,
      // Not disabled while saving (a disabled button drops keyboard focus to the page top); the busy
      // guard in saveRecord ignores a second press. The label swap re-creates the node, so
      // saveRecord puts focus back on it afterwards.
      Btn({ variant: 'primary', class: 'field-save', children: fc.busy ? 'Saving...' : 'Save to ' + c.ref, onClick: () => saveRecord(c) }),
    ].filter(Boolean),
  });
}

function markHere(c) {
  if (!navigator.geolocation) { toast('This phone cannot share its position.', 'warn'); return; }
  toast('Finding where you are...', 'ok');
  navigator.geolocation.getCurrentPosition(async (pos) => {
    if (!(await confirmOnce(c))) return;
    try {
      await postFieldLocation(c.id, c.ref, pos.coords.latitude, pos.coords.longitude);
      toast('Marked where you are on ' + identity(c) + '.', 'ok'); await reload();
    } catch (e) { toast(await failed(e, 'The position was not saved to ' + c.ref + '.'), 'err'); }
  }, () => toast('Could not get your position. Check that location is allowed for this page.', 'warn'), { enableHighAccuracy: true, timeout: 15000 });
}

async function quickNote(c, prefix, title, label) {
  const text = ((await confirmDialog({ title: title + ' -- ' + c.ref, message: 'For ' + identity(c) + '.', inputLabel: label, confirmLabel: 'Save to ' + c.ref })) || '').trim();
  if (!text) return;
  if (!(await confirmOnce(c))) return;
  try { await postFieldNote(c.id, c.ref, prefix + text, false); toast('Saved to ' + identity(c) + '.', 'ok'); await reload(); }
  catch (e) { toast(await failed(e, 'The note was not saved to ' + c.ref + '.'), 'err'); }
}

function QuickActions(c) {
  return h('div', { class: 'casey-timeline-actions', role: 'group', 'aria-label': 'Quick actions for ' + c.ref },
    Btn({ variant: 'ghost', children: [Icon('page', { size: 14 }), ' Add a note'], 'aria-label': 'Add a note to ' + c.ref, onClick: () => quickNote(c, '', 'Add a note', 'Note') }),
    Btn({ variant: 'ghost', children: [Icon('image', { size: 14 }), ' Photo details'], 'aria-label': 'Describe a photo for ' + c.ref, onClick: () => quickNote(c, 'Photo: ', 'Describe the photo', 'What does the photo show?') }),
    Btn({ variant: 'ghost', children: [Icon('globe', { size: 14 }), ' Mark where I am'], 'aria-label': 'Mark where I am on ' + c.ref, onClick: () => markHere(c) }));
}

function Summary(c, r) {
  const rows = fieldDefs().filter((d) => has(r, d.key));
  return Panel({
    title: EntityLabel() + ' so far',
    children: rows.length ? rows.map((d) => DetailRow({ key: d.key, label: d.label, value: String(r[d.key]).slice(0, 300) })) : h('p', { class: 'casey-hint' }, 'Nothing has been recorded yet.'),
  });
}

export function FieldCaseView({ id, onBack }) {
  if (fc.id !== id && !fc.loading) load(id);
  const back = Btn({ variant: 'link', size: 'sm', class: 'casey-back-btn', 'aria-label': 'Back to the list', onClick: onBack, children: [Icon('chevron-left', { size: 14 }), ' Back to the list'] });
  if (fc.error) return h('div', { class: 'casey-detail-pane' }, back, h('p', { class: 'casey-hint' }, fc.error));
  if (!fc.data || fc.data.case.id !== id) return h('div', { class: 'casey-detail-pane' }, back, Skeleton({ count: 5, height: '1.4em' }));
  if (fc.lost) {
    const typed = [...Object.values(fc.draft), fc.note].map((v) => String(v || '').trim()).filter(Boolean);
    return h('div', { class: 'casey-detail-pane', key: 'field-case-lost-' + id },
      back,
      Alert({ kind: 'warn', title: 'This ' + entityLabel() + ' is no longer yours', children: 'An operator has given it to someone else, or taken it off you. Nothing you typed was saved to it. Go back to your list to see what you have now.' }),
      typed.length ? Section({ title: 'What you had typed (copy it if you still need it)', children: typed.map((t, i) => h('p', { key: 'typed' + i }, t)) }) : null);
  }
  const { case: c, events, events_total, transitions } = fc.data;
  const data = fc.data;
  const r = parseReport(c.report);
  const write = data.access === 'write';   // the server says so: the number and the forms exist only on a report assigned to this person
  const editable = write;
  const nonDone = (transitions || []).filter((t) => !doneStages().has(t));
  const reload1 = () => reload();
  return h('div', { class: 'casey-detail-pane', key: 'field-case-' + id },
    back,
    Header(c, data, write),
    CaseProgress({ status: c.status }),
    editable ? null : Alert({ kind: 'info', title: 'You can look at this one, not change it', children: isTechnician() ? 'It is waiting for sign-off. Once it is complete you can sign it off or send it back.' : 'It is not assigned to you. Ask an operator if you should be working on it.' }),
    (isTechnician() || editable) ? SignOffCard(c, data, r, editable) : null,
    editable ? ContactCard(c, data) : null,
    editable ? RecordForm(c, r) : null,
    editable ? QuickActions(c) : null,
    Summary(c, r),
    editable ? Transitions({ c, transitions: nonDone, onReload: reload1 }) : null,
    editable ? ReplyBox({ c, events, onReload: reload1 }) : null,
    editable ? h('details', {}, h('summary', {}, 'Change the title, priority or labels of ' + c.ref),
      FieldsEditor({ c, caseTypeSource: null, onSaved: reload1, limited: true, expectedRef: c.ref, beforeSave: () => confirmOnce(c), titleNote: 'Editing ' + identity(c) })) : null,
    Timeline({ caseId: id, events, eventsTotal: events_total, canTranslate: editable, caseRef: c.ref, language: reportLanguage(c) }));
}

export function resetFieldCase() { fc.id = null; fc.data = null; fc.error = ''; fc.loading = false; }
