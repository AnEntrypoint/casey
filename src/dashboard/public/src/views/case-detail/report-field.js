// report-field.js -- single report field row: label, value, AI/Manual/Both
// source Chip, inline click-to-edit (TextField swap, save on Enter/blur),
// per-field note button -> Dialog. This is the ux-forms-edit-mode-toggle +
// ux-forms-inline-validation-save-feedback unit -- TextField's own `error`
// prop stands in for the old ad-hoc validation-message DOM.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn, Chip, Icon } from '/design/src/components/shell.js';
import { TextField } from '/design/src/components/content.js';
import { state, schedule } from '../../state.js';
import { toast, failMsg } from '../../toasts.js';
import { postIntake, postNote } from '../../api.js';
import { SOURCE_LABEL } from '../../icons-map.js';
const h = webjsx.createElement;

const REPORT_FIELD_MAXLEN = 2000;

function fieldEditKey(caseId, k) { return caseId + ':' + k; }

export function ReportField({ caseId, k, label, value, source, notes, onSaved, key } = {}) {
    const editKey = fieldEditKey(caseId, k);
    const editing = state._reportFieldEditing === editKey;
    const draftMap = state._reportFieldDrafts || (state._reportFieldDrafts = {});
    const errMap = state._reportFieldErrors || (state._reportFieldErrors = {});
    const savingSet = state._reportFieldSaving || (state._reportFieldSaving = new Set());

    const startEdit = () => {
        draftMap[editKey] = value || '';
        delete errMap[editKey];
        state._reportFieldEditing = editKey;
        schedule();
    };
    const cancelEdit = () => { state._reportFieldEditing = null; schedule(); };

    const save = async () => {
        const val = draftMap[editKey] != null ? draftMap[editKey] : '';
        if (val === (value || '')) { state._reportFieldEditing = null; schedule(); return; }
        if (!val.trim() && value) {
            errMap[editKey] = 'To remove a value, use the full edit form.';
            schedule();
            return;
        }
        savingSet.add(editKey); schedule();
        try {
            const r = await postIntake(caseId, { [k]: val });
            savingSet.delete(editKey);
            state._reportFieldEditing = null;
            delete errMap[editKey];
            toast('saved', 'ok');
            if (onSaved) await onSaved();
        } catch (e) {
            savingSet.delete(editKey);
            errMap[editKey] = (e && e.body && e.body.error) || 'Save failed';
            schedule();
        }
    };

    const addNote = async () => {
        const text = (prompt('Note for: ' + label) || '').trim();
        if (!text) return;
        try {
            await postNote(caseId, text, k);
            toast('note saved', 'ok');
            if (onSaved) await onSaved();
        } catch (e) { toast(await failMsg(e, 'note failed'), 'err'); }
    };

    const valueNode = editing
        ? TextField({
            key: 'edit', value: draftMap[editKey] != null ? draftMap[editKey] : (value || ''),
            maxLength: REPORT_FIELD_MAXLEN,
            error: errMap[editKey] || null,
            onInput: (v) => { draftMap[editKey] = v; schedule(); },
            onChange: save,
        })
        : h('span', {
            class: 'casey-rep-editable', tabindex: '0', role: 'button',
            title: 'Click to edit', 'aria-label': 'Edit ' + label,
            onclick: startEdit,
            onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); startEdit(); } }
        },
            value ? value : h('span', { class: 'casey-rep-missing' }, 'not given yet'),
            Icon('pencil', { size: 12 }),
            source ? Chip({ size: 'sm', tone: source === 'ai' ? 'accent' : (source === 'manual' ? 'ok' : ''), children: SOURCE_LABEL[source] || source }) : null
        );

    return h('div', { key, class: 'casey-rep-row', 'data-field': k },
        h('span', { class: 'casey-rep-label' }, label),
        h('span', { class: 'casey-rep-val' },
            valueNode,
            editing ? h('div', { class: 'casey-rep-edit-actions' },
                Btn({ size: 'sm', variant: 'primary', disabled: savingSet.has(editKey), children: savingSet.has(editKey) ? 'Saving...' : 'Save', onClick: save }),
                Btn({ size: 'sm', variant: 'ghost', children: 'Cancel', onClick: cancelEdit })
            ) : h('button', { type: 'button', class: 'casey-rep-note-btn', title: 'Add a note to this field', onclick: addNote }, Icon('pencil', { size: 11 }), ' note'),
            ...(notes || []).map((n, i) => h('div', { key: 'n' + i, class: 'casey-rep-field-note' }, n.text))
        )
    );
}
