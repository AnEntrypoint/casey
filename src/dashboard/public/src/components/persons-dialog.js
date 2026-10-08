import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn } from '/design/src/components/shell.js';
import { Table } from '/design/src/components/content/table.js';
import { Select } from '/design/src/components/content/fields.js';
import { Dialog, confirmDialog } from './dialog-shell.js';
import { state, schedule } from '../state.js';
import { toast, failMsg } from '../toasts.js';
import { fetchPersons, postPersonRename, postPersonMerge, postPersonErase } from '../api.js';
import { rel } from '../format.js';
import { entityLabelPlural, countOf } from '../vocabulary.js';
import { word } from '../words.js';
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
    catch (e) { state._persons = []; state._personsError = word('ui.persons_dialog_load_failed'); }
    schedule();
}

const closeDialog = () => { state._personsFor = null; state._persons = null; schedule(); if (onChangedCb) onChangedCb(); };

async function rename(p) {
    const name = await confirmDialog({
        title: word('ui.persons_dialog_rename_title', { name: p.name }), message: word('ui.persons_dialog_rename_message'),
        inputLabel: word('ui.persons_dialog_name_label'), inputDefault: p.name, confirmLabel: word('ui.persons_dialog_save_name'),
    });
    if (name === null) return;
    const next = name.trim();
    if (!next || next === p.name) return;
    try {
        await postPersonRename(state._personsFor.id, { person_id: p.id, name: next, expected_name: p.name });
        toast(word('ui.persons_dialog_renamed', { name: next }), 'ok');
        await reloadPersons();
    } catch (e) { toast(await failMsg(e, word('ui.persons_dialog_rename_failed')), 'err'); }
}

async function merge(p, keepId, others) {
    const keep = others.find((o) => o.id === keepId);
    if (!keep) return;
    const ok = await confirmDialog({
        title: word('ui.persons_dialog_same_title', { name: p.name, other: keep.name }),
        message: word('ui.persons_dialog_merge_message', { name: p.name, other: keep.name }),
        confirmLabel: word('ui.persons_dialog_same_confirm'),
    });
    if (ok === null) return;
    try {
        await postPersonMerge(state._personsFor.id, { keep: keep.id, from: [p.id] });
        toast(word('ui.persons_dialog_merged', { name: p.name, other: keep.name }), 'ok');
        await reloadPersons();
    } catch (e) { toast(await failMsg(e, word('ui.persons_dialog_merge_failed')), 'err'); }
}

async function erase(p) {
    const typed = await confirmDialog({
        title: word('ui.persons_dialog_erase_title', { name: p.name }),
        message: word('ui.persons_dialog_erase_message'),
        inputLabel: word('ui.persons_dialog_type_name'), confirmLabel: word('ui.persons_dialog_erase_button'), danger: true,
    });
    if (typed === null) return;
    try {
        const j = await postPersonErase(state._personsFor.id, { person_id: p.id, confirm_name: typed });
        toast(j.complete === false ? word('ui.persons_dialog_partly_erased') : word('ui.persons_dialog_erased', { count: countOf(j.reports_scrubbed) }), j.complete === false ? 'err' : 'ok');
        await reloadPersons();
    } catch (e) { toast(await failMsg(e, word('ui.persons_dialog_erase_failed')), 'err'); }
}

export function PersonsDialog({ key } = {}) {
    const f = state._personsFor;
    const open = !!f;
    const isAdmin = !!(state.currentUser && state.currentUser.role === 'admin');
    const people = state._persons;
    return Dialog({
        key, open, title: word('ui.persons_dialog_title'), wide: true, onClose: closeDialog,
        children: !open ? null : [
            h('p', { key: 'lead', class: 'casey-hint' }, (f.label ? f.label + ': ' : '') + word('ui.persons_dialog_lead')),
            people == null ? h('p', { key: 'load', class: 'casey-hint' }, word('ui.persons_dialog_loading'))
                : state._personsError ? h('p', { key: 'err', class: 'casey-hint' }, state._personsError)
                    : !people.length ? h('p', { key: 'none', class: 'casey-hint' }, word('ui.persons_dialog_none'))
                        : Table({
                            key: 'tbl',
                            headers: [word('ui.persons_dialog_col_person'), entityLabelPlural(), word('ui.persons_dialog_col_last'), ''],
                            rows: people.map((p) => {
                                const others = people.filter((o) => o.id !== p.id);
                                return [
                                    h('div', { class: 'ds-persons-name' }, h('span', {}, p.name), p.relation ? h('span', { class: 'ds-contact-anon-sub' }, p.relation) : null),
                                    p.reports.length ? p.reports.join(', ') : word('ui.persons_dialog_none_yet'),
                                    p.last_seen ? rel(p.last_seen) : word('ui.persons_dialog_unknown'),
                                    h('div', { class: 'ds-contact-actions' },
                                        Btn({ size: 'sm', variant: 'link', class: 'ds-persons-act', children: word('ui.persons_dialog_rename'), 'aria-label': word('ui.persons_dialog_rename_title', { name: p.name }), onClick: () => rename(p) }),
                                        others.length ? Select({
                                            key: 'same-' + p.id, name: 'same-as-' + p.id, size: 'sm', value: '',
                                            'aria-label': word('ui.persons_dialog_same_aria', { name: p.name }),
                                            options: [{ value: '', label: word('ui.persons_dialog_same_option') }].concat(others.map((o) => ({ value: o.id, label: o.name }))),
                                            onChange: (v) => { if (v) merge(p, v, others); },
                                        }) : null,
                                        isAdmin ? Btn({ size: 'sm', variant: 'link', class: 'ds-contact-erase', children: word('ui.persons_dialog_erase_button'), 'aria-label': word('ui.persons_dialog_erase_aria', { name: p.name }), onClick: () => erase(p) }) : null),
                                ];
                            }),
                        }),
        ],
    });
}
