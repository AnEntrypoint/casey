// persons-dialog.js -- who is behind a shared phone. In rural areas one WhatsApp number is often used by a family,
// neighbours or someone borrowing the phone; the assistant records who is writing and this dialog lets staff correct
// it: rename a person, say that two records are one person (merge), and, for an admin, erase one person's details
// without touching the phone or anyone else on it (routes/persons.js).
//
// Names, never keys: a person is shown by the name they gave and how they are related; the ids only travel back to the
// server as the values a button sends. No phone number is on this dialog (the server sends none).
// Rendered through dialog-shell.js's Dialog; the rename / merge / erase prompts are its confirmDialog, so there is
// one modal code path. Kit primitives first (Table, Select, Btn); the only local style is .ds-persons-* (app.css).

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn } from '/design/src/components/shell.js';
import { Table } from '/design/src/components/content/table.js';
import { Select } from '/design/src/components/content/fields.js';
import { Dialog, confirmDialog } from './dialog-shell.js';
import { state, schedule } from '../state.js';
import { toast, failMsg } from '../toasts.js';
import { fetchPersons, postPersonRename, postPersonMerge, postPersonErase } from '../api.js';
import { rel } from '../format.js';
import { entityLabel, entityLabelPlural, countOf } from '../vocabulary.js';
const h = webjsx.createElement;

let onChangedCb = null;

export function openPersonsDialog(contact, onChanged) {
    state._personsFor = { id: contact.id, label: contact.label || '' };
    state._persons = null;
    state._personsError = '';
    onChangedCb = onChanged || null;
    schedule();
    reloadPersons();
}

async function reloadPersons() {
    const f = state._personsFor;
    if (!f) return;
    try { const j = await fetchPersons(f.id); if (state._personsFor && state._personsFor.id === f.id) { state._persons = j.persons || []; state._personsError = ''; } }
    catch (e) { state._persons = []; state._personsError = 'Could not load the people on this phone. Close this and try again.'; }
    schedule();
}

const closeDialog = () => { state._personsFor = null; state._persons = null; schedule(); if (onChangedCb) onChangedCb(); };

async function rename(p) {
    const name = await confirmDialog({
        title: 'Rename ' + p.name, message: 'This changes the name on every ' + entityLabel() + ' they gave. Write it as they say it.',
        inputLabel: 'Name', inputDefault: p.name, confirmLabel: 'Save name',
    });
    if (name === null) return;
    const next = name.trim();
    if (!next || next === p.name) return;
    try {
        await postPersonRename(state._personsFor.id, { person_id: p.id, name: next, expected_name: p.name });
        toast('Renamed to ' + next + '.', 'ok');
        await reloadPersons();
    } catch (e) { toast(await failMsg(e, 'The name was not changed. Try again.'), 'err'); }
}

async function merge(p, keepId, others) {
    const keep = others.find((o) => o.id === keepId);
    if (!keep) return;
    const ok = await confirmDialog({
        title: 'Is ' + p.name + ' the same person as ' + keep.name + '?',
        message: 'Their ' + entityLabelPlural() + ' are joined under ' + keep.name + ' and ' + p.name + ' stops being listed as a separate person.',
        confirmLabel: 'Yes, same person',
    });
    if (ok === null) return;
    try {
        await postPersonMerge(state._personsFor.id, { keep: keep.id, from: [p.id] });
        toast(p.name + ' and ' + keep.name + ' are now one person.', 'ok');
        await reloadPersons();
    } catch (e) { toast(await failMsg(e, 'Nothing was merged. Try again.'), 'err'); }
}

async function erase(p) {
    const typed = await confirmDialog({
        title: 'Erase ' + p.name + "'s details?",
        message: 'Irreversibly removes their name and how they are related, and the name and identifying details on the ' + entityLabelPlural() + ' they gave. The animals stay on the ' + entityLabelPlural() + '. The phone and everyone else on it are not touched.',
        inputLabel: 'Type their name to confirm', confirmLabel: 'Erase this person', danger: true,
    });
    if (typed === null) return;
    try {
        const j = await postPersonErase(state._personsFor.id, { person_id: p.id, confirm_name: typed });
        toast(j.complete === false ? 'Partly erased -- run Erase again to finish.' : 'Erased. ' + countOf(j.reports_scrubbed) + ' scrubbed.', j.complete === false ? 'err' : 'ok');
        await reloadPersons();
    } catch (e) { toast(await failMsg(e, 'Nothing was erased. Their details are all still stored.'), 'err'); }
}

export function PersonsDialog({ key } = {}) {
    const f = state._personsFor;
    const open = !!f;
    const isAdmin = !!(state.currentUser && state.currentUser.role === 'admin');
    const people = state._persons;
    return Dialog({
        key, open, title: 'People who use this phone', wide: true, onClose: closeDialog,
        children: !open ? null : [
            h('p', { key: 'lead', class: 'casey-hint' }, (f.label ? f.label + ': ' : '') + 'the assistant records who is writing from what people say. Correct a name here, or join two records that are one person.'),
            people == null ? h('p', { key: 'load', class: 'casey-hint' }, 'Loading...')
                : state._personsError ? h('p', { key: 'err', class: 'casey-hint' }, state._personsError)
                    : !people.length ? h('p', { key: 'none', class: 'casey-hint' }, 'Nobody is recorded on this phone yet.')
                        : Table({
                            key: 'tbl',
                            headers: ['Person', entityLabelPlural(), 'Last wrote', ''],
                            rows: people.map((p) => {
                                const others = people.filter((o) => o.id !== p.id);
                                return [
                                    h('div', { class: 'ds-persons-name' }, h('span', {}, p.name), p.relation ? h('span', { class: 'ds-contact-anon-sub' }, p.relation) : null),
                                    p.reports.length ? p.reports.join(', ') : 'none yet',
                                    p.last_seen ? rel(p.last_seen) : 'unknown',
                                    h('div', { class: 'ds-contact-actions' },
                                        Btn({ size: 'sm', variant: 'link', class: 'ds-persons-act', children: 'Rename', 'aria-label': 'Rename ' + p.name, onClick: () => rename(p) }),
                                        others.length ? Select({
                                            key: 'same-' + p.id, name: 'same-as-' + p.id, size: 'sm', value: '',
                                            'aria-label': 'Same person as, for ' + p.name,
                                            options: [{ value: '', label: 'Same person as...' }].concat(others.map((o) => ({ value: o.id, label: o.name }))),
                                            onChange: (v) => { if (v) merge(p, v, others); },
                                        }) : null,
                                        isAdmin ? Btn({ size: 'sm', variant: 'link', class: 'ds-contact-erase', children: 'Erase this person', 'aria-label': 'Erase ' + p.name, onClick: () => erase(p) }) : null),
                                ];
                            }),
                        }),
        ],
    });
}
