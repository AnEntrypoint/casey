import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn, Chip, Icon } from '/design/src/components/shell.js';
import { TextField, FillLines, DetailRow } from '/design/src/components/content.js';
import { state, schedule } from '../../state.js';
import { toast, failMsg } from '../../toasts.js';
import { postIntake, postNote } from '../../api.js';
import { SOURCE_LABEL } from '../../icons-map.js';
import { reportValue } from '../../format.js';
import { word } from '../../words.js';
import { OptionField, fieldOptions, resetOptionField } from '../../components/option-field.js';
import { confirmDialog } from '../../components/dialog-shell.js';
import { isKnownValueField, knownValues, loadKnownValues, resolveValue, prefetchResolve, matchNotice, invalidateKnownValues } from '../../known-values.js';
const h = webjsx.createElement;

const REPORT_FIELD_MAXLEN = 2000;

const TYPING_PAUSE_MS = 600;
let typingTimer = null;

const SOURCE_WORD_KEYS = {
    ai: 'ui.report_field_source_ai',
    manual: 'ui.report_field_source_manual',
    both: 'ui.report_field_source_both',
};

function fieldEditKey(caseId, k) { return caseId + ':' + k; }

export function ReportField({ caseId, k, label, value, source, notes, multiline, onSaved, sayMissing = true, key } = {}) {
    const editKey = fieldEditKey(caseId, k);
    const editing = state._reportFieldEditing === editKey;
    const draftMap = state._reportFieldDrafts || (state._reportFieldDrafts = {});
    const errMap = state._reportFieldErrors || (state._reportFieldErrors = {});
    const savingSet = state._reportFieldSaving || (state._reportFieldSaving = new Set());

    const opts = fieldOptions(k);
    const combo = !opts.length && isKnownValueField(k);
    const canonMap = state._reportFieldCanon || (state._reportFieldCanon = {});
    const checkingSet = state._reportFieldChecking || (state._reportFieldChecking = new Set());

    const startEdit = () => {
        draftMap[editKey] = value || '';
        delete errMap[editKey];
        delete canonMap[editKey];
        resetOptionField('rf-' + k);
        state._reportFieldEditing = editKey;
        if (combo) loadKnownValues(k).then(schedule);
        schedule();
        setTimeout(() => {
            const row = document.querySelector('[data-field="' + CSS.escape(k) + '"]');
            const box = row && row.querySelector('select,input,textarea');
            if (box) { box.focus(); if (box.select) box.select(); }
        }, 0);
    };
    const focusTrigger = () => setTimeout(() => {
        const lost = !document.activeElement || document.activeElement === document.body;
        const row = document.querySelector('[data-field="' + CSS.escape(k) + '"]');
        const trigger = row && row.querySelector('.casey-rep-editable');
        if (lost && trigger) trigger.focus();
    }, 0);
    const cancelEdit = () => { state._reportFieldEditing = null; schedule(); focusTrigger(); };
    const onEditKeydown = (e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault(); e.stopPropagation();
        delete draftMap[editKey];
        delete errMap[editKey];
        cancelEdit();
    };

    const write = async (stored, canonInfo) => {
        const body = { [k]: stored };
        if (canonInfo && canonInfo.typed && canonInfo.typed !== stored) {
            body.canonicalized = { [k]: { typed: canonInfo.typed, how: canonInfo.how } };
        }
        await postIntake(caseId, body);
        if (combo) invalidateKnownValues(k);
    };

    const save = async () => {
        const val = draftMap[editKey] != null ? draftMap[editKey] : '';
        if (val === (value || '')) { state._reportFieldEditing = null; schedule(); focusTrigger(); return; }
        if (!val.trim() && value) {
            errMap[editKey] = word('ui.report_field_remove_hint');
            schedule();
            return;
        }
        savingSet.add(editKey); schedule();
        try {
            let resolved = null;
            if (combo) {
                checkingSet.add(editKey); schedule();
                try { resolved = await resolveValue(k, val); } finally { checkingSet.delete(editKey); }
            }
            const stored = resolved ? resolved.store : val;
            await write(stored, resolved);
            savingSet.delete(editKey);
            state._reportFieldEditing = null;
            delete errMap[editKey];
            const notice = matchNotice(resolved, label);
            if (notice) { canonMap[editKey] = resolved; toast(notice, 'warn', { ms: 9000 }); }
            else { delete canonMap[editKey]; toast(word('ui.report_field_saved'), 'ok'); }
            if (onSaved) await onSaved();
            focusTrigger();
        } catch (e) {
            savingSet.delete(editKey);
            checkingSet.delete(editKey);
            errMap[editKey] = (e && e.body && e.body.error) || word('ui.report_field_not_saved');
            schedule();
        }
    };

    const addNote = async () => {
        const text = ((await confirmDialog({ title: word('ui.report_field_note_title'), inputLabel: word('ui.report_field_note_input', { label }), confirmLabel: word('ui.report_field_note_save'), requireInput: true })) || '').trim();
        if (!text) return;
        try {
            await postNote(caseId, text, k);
            toast(word('ui.report_field_note_added'), 'ok');
            if (onSaved) await onSaved();
        } catch (e) { toast(await failMsg(e, word('ui.report_field_note_failed')), 'err'); }
    };

    const keepTyped = async () => {
        const r = canonMap[editKey];
        if (!r) return;
        delete canonMap[editKey];
        savingSet.add(editKey); schedule();
        try {
            await write(r.typed, null);
            savingSet.delete(editKey);
            toast(word('ui.report_field_kept', { typed: r.typed }), 'ok');
            if (onSaved) await onSaved();
        } catch (e) {
            savingSet.delete(editKey);
            canonMap[editKey] = r;
            toast(await failMsg(e, word('ui.report_field_put_back_failed', { typed: r.typed })), 'err');
        }
        schedule();
    };

    const canonNote = canonMap[editKey] ? h('div', { key: 'canon', class: 'casey-rep-field-note' },
        matchNotice(canonMap[editKey], label),
        ' ',
        Btn({
            size: 'sm', variant: 'ghost', disabled: savingSet.has(editKey),
            children: word('ui.report_field_keep_typed', { typed: canonMap[editKey].typed }), onClick: keepTyped,
        })) : null;

    const valueNode = editing && opts.length
        ? OptionField({
            key: 'edit', name: 'rf-' + k,
            value: draftMap[editKey] != null ? draftMap[editKey] : (value || ''),
            options: opts, maxLength: REPORT_FIELD_MAXLEN,
            hint: errMap[editKey] || null,
            onChange: (v) => { draftMap[editKey] = v; schedule(); },
        })
        : editing
        ? TextField({
            key: 'edit',
            name: 'rf-' + k,
            value: draftMap[editKey] != null ? draftMap[editKey] : (value || ''),
            maxLength: REPORT_FIELD_MAXLEN,
            error: errMap[editKey] || null,
            suggestions: combo ? knownValues(k) : null,
            hint: combo
                ? (checkingSet.has(editKey)
                    ? word('ui.report_field_checking')
                    : word('ui.report_field_pick_hint'))
                : null,
            onInput: (v) => {
                draftMap[editKey] = v;
                if (combo) {
                    clearTimeout(typingTimer);
                    typingTimer = setTimeout(() => prefetchResolve(k, v), TYPING_PAUSE_MS);
                }
                schedule();
            },
            onChange: save,
        })
        : h('span', {
            class: 'casey-rep-editable', tabindex: '0', role: 'button',
            title: word('ui.report_field_click_edit'), 'aria-label': word('ui.report_field_edit_label', { label }),
            onclick: startEdit,
            onkeydown: (e) => {
                if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); startEdit(); }
            }
        },
            value ? h('span', { class: 'casey-rep-value' }, reportValue(value)) : (sayMissing ? h('span', { class: 'casey-rep-missing ds-print-blank' }, word('ui.not_given_yet')) : null),
            value ? null : FillLines({ lines: multiline ? 3 : 1 }),
            Icon('pencil', { size: 12 }),
            source ? Chip({ size: 'sm', tone: source === 'ai' ? 'accent' : (source === 'manual' ? 'ok' : ''), children: SOURCE_WORD_KEYS[source] ? word(SOURCE_WORD_KEYS[source]) : (SOURCE_LABEL[source] || source) }) : null
        );

    return DetailRow({
        key, field: k, label,
        value: editing ? h('span', { key: 'edit-scope', onkeydown: onEditKeydown }, valueNode) : valueNode,
        trailing: editing
            ? h('div', { class: 'casey-rep-edit-actions' },
                Btn({ size: 'sm', variant: 'primary', disabled: savingSet.has(editKey), children: savingSet.has(editKey) ? word('ui.report_field_saving') : word('ui.report_field_save'), onClick: save }),
                Btn({ size: 'sm', variant: 'ghost', children: word('ui.report_field_cancel'), onClick: cancelEdit })
            )
            : h('button', { type: 'button', class: 'casey-rep-note-btn', 'aria-label': word('ui.report_field_note_label', { label }), title: word('ui.report_field_note_label', { label }), onclick: addNote }, Icon('pencil', { size: 11 }), word('ui.report_field_note_btn')),
        notes: [
            canonNote,
            ...(notes || []).map((n, i) => h('div', { key: 'n' + i, class: 'casey-rep-field-note' }, n.text)),
        ].filter(Boolean),
    });
}
