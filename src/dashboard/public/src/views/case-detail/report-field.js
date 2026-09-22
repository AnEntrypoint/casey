// report-field.js -- single report field row: label, value, AI/Manual/Both
// source Chip, inline click-to-edit (TextField swap, save on Enter/blur),
// per-field note button -> Dialog. This is the ux-forms-edit-mode-toggle +
// ux-forms-inline-validation-save-feedback unit -- TextField's own `error`
// prop stands in for the old ad-hoc validation-message DOM.
//
// A field the config lists as a known-value field (species/location -- see
// known-values.js and src/field-values.js) edits as a COMBO BOX instead of a
// bare text box: the same TextField, given the list of values this deployment's
// reports already use. Typing something new is completely unblocked; on save,
// a value nobody has used before is checked once against that list, and if it is
// an existing value written differently it is stored under the existing spelling
// and the row says so.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn, Chip, Icon } from '/design/src/components/shell.js';
import { TextField, FillLines, DetailRow } from '/design/src/components/content.js';
import { state, schedule } from '../../state.js';
import { toast, failMsg } from '../../toasts.js';
import { postIntake, postNote } from '../../api.js';
import { SOURCE_LABEL } from '../../icons-map.js';
import { reportValue } from '../../format.js';
import { confirmDialog } from '../../components/dialog-shell.js';
import { isKnownValueField, knownValues, loadKnownValues, resolveValue, prefetchResolve, matchNotice, invalidateKnownValues } from '../../known-values.js';
const h = webjsx.createElement;

const REPORT_FIELD_MAXLEN = 2000;

// How long a pause in typing counts as "they have typed what they mean", at
// which point the canonicalize check for that text is started in the background
// (see known-values.js prefetchResolve). Long enough not to fire mid-word,
// short enough that the answer is usually there before the operator's hand
// reaches Save.
const TYPING_PAUSE_MS = 600;
let typingTimer = null;

// Who put this value here, in the words a person would use. Falls through to
// icons-map.js's SOURCE_LABEL, and then to the raw key, for any source value
// added later without a word here.
const SOURCE_WORDS = {
    ai: 'AI collected',
    manual: 'Operator entered',
    both: 'AI, then checked',
};

function fieldEditKey(caseId, k) { return caseId + ':' + k; }

export function ReportField({ caseId, k, label, value, source, notes, multiline, onSaved, sayMissing = true, key } = {}) {
    const editKey = fieldEditKey(caseId, k);
    const editing = state._reportFieldEditing === editKey;
    const draftMap = state._reportFieldDrafts || (state._reportFieldDrafts = {});
    const errMap = state._reportFieldErrors || (state._reportFieldErrors = {});
    const savingSet = state._reportFieldSaving || (state._reportFieldSaving = new Set());

    const combo = isKnownValueField(k);
    const canonMap = state._reportFieldCanon || (state._reportFieldCanon = {});
    const checkingSet = state._reportFieldChecking || (state._reportFieldChecking = new Set());

    const startEdit = () => {
        draftMap[editKey] = value || '';
        delete errMap[editKey];
        delete canonMap[editKey];
        state._reportFieldEditing = editKey;
        // Warm the option list as the editor opens. Cached and shared, so this
        // is a no-op on every open after the first (and the case-detail load
        // already asked for it) -- never a fetch per keystroke.
        if (combo) loadKnownValues(k).then(schedule);
        schedule();
        // FOCUS HAS TO FOLLOW THE SWAP. Opening the editor replaces the
        // role=button span with a TextField, which destroys the node the
        // keyboard user was standing on -- focus falls to <body>, so the
        // operator who pressed Enter to edit a field has to Tab in from the top
        // of a 200-stop document to reach the box they just opened. Deferred a
        // macrotask because schedule() renders asynchronously, so the input
        // does not exist yet on this tick. Scoped by data-field to THIS row:
        // twenty-eight of these render at once.
        setTimeout(() => {
            const row = document.querySelector('[data-field="' + CSS.escape(k) + '"]');
            const box = row && row.querySelector('input,textarea');
            if (box) { box.focus(); if (box.select) box.select(); }
        }, 0);
    };
    const cancelEdit = () => { state._reportFieldEditing = null; schedule(); };

    // The one write path, shared by the ordinary save and the "keep what I
    // typed" override below so both record the same way.
    const write = async (stored, canonInfo) => {
        const body = { [k]: stored };
        // Only when the stored value is not what they typed: the timeline has to
        // carry both halves or it claims they typed a word they never typed.
        if (canonInfo && canonInfo.typed && canonInfo.typed !== stored) {
            body.canonicalized = { [k]: { typed: canonInfo.typed, how: canonInfo.how } };
        }
        await postIntake(caseId, body);
        // A value just recorded belongs on the list from now on; the server drops
        // its own memo on the same write, so the next read is already current.
        if (combo) invalidateKnownValues(k);
    };

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
            // Is this text an existing value written differently? A value already
            // on the list answers with no request at all; anything else costs one
            // short call that is bounded server-side and falls through to
            // "store it as typed" on any failure, so the save below always runs.
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
            // Say what happened to their text INSTEAD of a bare "Saved." when it
            // is not their text that got stored -- a silent substitution is the
            // one outcome this control must never produce.
            const notice = matchNotice(resolved, label);
            if (notice) { canonMap[editKey] = resolved; toast(notice, 'warn', { ms: 9000 }); }
            else { delete canonMap[editKey]; toast('Saved.', 'ok'); }
            if (onSaved) await onSaved();
        } catch (e) {
            savingSet.delete(editKey);
            checkingSet.delete(editKey);
            // Rendered inline under the field, so it stays short -- but it has
            // to say the value did not land, not merely that something failed.
            errMap[editKey] = (e && e.body && e.body.error) || 'Not saved -- your text is still here, press Save again.';
            schedule();
        }
    };

    const addNote = async () => {
        const text = ((await confirmDialog({ title: 'Add a note', inputLabel: 'Note for: ' + label })) || '').trim();
        if (!text) return;
        try {
            await postNote(caseId, text, k);
            toast('Note added to this field.', 'ok');
            if (onSaved) await onSaved();
        } catch (e) { toast(await failMsg(e, 'The note was not saved, so nothing was added to this field. Try again.'), 'err'); }
    };

    // A matched value the operator may not have wanted matched. One button, only
    // after a substitution actually happened, and it is the escape hatch that
    // makes accepting the match safe: re-save their own words and the value is on
    // the list from then on, so nothing matches it away again.
    const keepTyped = async () => {
        const r = canonMap[editKey];
        if (!r) return;
        delete canonMap[editKey];
        savingSet.add(editKey); schedule();
        try {
            await write(r.typed, null);
            savingSet.delete(editKey);
            toast('Kept "' + r.typed + '" as its own value.', 'ok');
            if (onSaved) await onSaved();
        } catch (e) {
            savingSet.delete(editKey);
            canonMap[editKey] = r;
            toast(await failMsg(e, 'Could not put "' + r.typed + '" back. The matched value is still saved.'), 'err');
        }
        schedule();
    };

    const canonNote = canonMap[editKey] ? h('div', { key: 'canon', class: 'casey-rep-field-note' },
        matchNotice(canonMap[editKey], label),
        ' ',
        Btn({
            size: 'sm', variant: 'ghost', disabled: savingSet.has(editKey),
            children: 'Keep "' + canonMap[editKey].typed + '" instead', onClick: keepTyped,
        })) : null;

    const valueNode = editing
        ? TextField({
            key: 'edit',
            // name is what the kit derives the datalist id from, so it has to be
            // distinct per field on a page that renders twenty-eight of these.
            name: 'rf-' + k,
            value: draftMap[editKey] != null ? draftMap[editKey] : (value || ''),
            maxLength: REPORT_FIELD_MAXLEN,
            error: errMap[editKey] || null,
            // The combo box. An empty list (nothing recorded yet for this field,
            // or the list has not loaded) is simply a plain text box.
            suggestions: combo ? knownValues(k) : null,
            hint: combo
                ? (checkingSet.has(editKey)
                    ? 'Checking whether this is already on record...'
                    : 'Pick one already in use, or type a new one.')
                : null,
            onInput: (v) => {
                draftMap[editKey] = v;
                if (combo) {
                    // One timer for the whole form: only one field is ever in
                    // edit mode, so a second field starting to type legitimately
                    // cancels the first field's pending warm-up.
                    clearTimeout(typingTimer);
                    typingTimer = setTimeout(() => prefetchResolve(k, v), TYPING_PAUSE_MS);
                }
                schedule();
            },
            onChange: save,
        })
        : h('span', {
            class: 'casey-rep-editable', tabindex: '0', role: 'button',
            title: 'Click to edit', 'aria-label': 'Edit ' + label,
            onclick: startEdit,
            // Space as well as Enter: a role=button must answer both (a native
            // <button> does, and every other role=button in this app -- the
            // rail's queue rows, the handoff banner, the handover refs, the
            // activity rows -- accepts both). With Enter alone, Space on the
            // focused field scrolled the page instead of opening the editor.
            onkeydown: (e) => {
                if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); startEdit(); }
            }
        },
            // On paper this page is often a form to complete by hand, so an
            // empty field must not print the word "not given yet" into the
            // space someone needs to write in. ds-print-blank hides it in
            // print (the kit's own rule) and FillLines supplies the ruled
            // writing space instead -- more lines where the config says the
            // answer is a paragraph, one where it is a species or a count.
            // The value is its OWN span, not a bare text child of this
            // inline-flex box: an anonymous flex item cannot be given
            // min-width:0 and is measured at max-content, which is what froze
            // the renderer on an oversized field (see format.js reportValue).
            value ? h('span', { class: 'casey-rep-value' }, reportValue(value)) : (sayMissing ? h('span', { class: 'casey-rep-missing ds-print-blank' }, 'not given yet') : null),
            value ? null : FillLines({ lines: multiline ? 3 : 1 }),
            Icon('pencil', { size: 12 }),
            // THIS MARKER STAYS, and it is the one place in the case view
            // where a chip passes the test the header's four failed. There
            // are twenty-eight of these rows. Who put a fact there -- the AI
            // from what someone said, or a person who typed it -- is what an
            // operator weighs before driving two hours on it, and it differs
            // row by row. A shape you can pick out while running your eye
            // down a long column is doing work no sentence per row could do
            // without tripling the column's height.
            //
            // What it said was wrong, though. icons-map.js's SOURCE_LABEL
            // renders 'manual' as "Manual" and 'ai' as "AI" -- the storage
            // words -- while report-sections.js's legend above it called the
            // same two things "Operator entered" and "AI collected". One
            // screen, one fact, two vocabularies. The legend is gone and this
            // row now carries the readable half of that pair.
            source ? Chip({ size: 'sm', tone: source === 'ai' ? 'accent' : (source === 'manual' ? 'ok' : ''), children: SOURCE_WORDS[source] || SOURCE_LABEL[source] || source }) : null
        );

    // The row itself is the kit's DetailRow: a record field is label + value +
    // whatever is said about that value, and the hairline that closes it
    // belongs to one rule in the kit rather than to a copy of it here. What
    // stays casey's is what is genuinely casey's -- the click-to-edit value,
    // the save/cancel pair, the per-field note button and the notes.
    return DetailRow({
        key, field: k, label,
        value: valueNode,
        trailing: editing
            ? h('div', { class: 'casey-rep-edit-actions' },
                Btn({ size: 'sm', variant: 'primary', disabled: savingSet.has(editKey), children: savingSet.has(editKey) ? 'Saving...' : 'Save', onClick: save }),
                Btn({ size: 'sm', variant: 'ghost', children: 'Cancel', onClick: cancelEdit })
            )
            // NAMED BY ITS FIELD, like the edit control beside it. The visible
            // word stays "note" -- it sits in a column of twenty-eight rows
            // where the label already says which field it belongs to -- but the
            // accessible name cannot borrow that column: read aloud, the page
            // was twenty-eight consecutive "note, button" with nothing to tell
            // them apart, while the value beside each already said "Edit
            // <field>". title is not a substitute: it is only consulted when an
            // element has no text content, and this one has text.
            : h('button', { type: 'button', class: 'casey-rep-note-btn', 'aria-label': 'Add a note to ' + label, title: 'Add a note to ' + label, onclick: addNote }, Icon('pencil', { size: 11 }), ' note'),
        notes: [
            canonNote,
            ...(notes || []).map((n, i) => h('div', { key: 'n' + i, class: 'casey-rep-field-note' }, n.text)),
        ].filter(Boolean),
    });
}
