import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn } from '/design/src/components/shell.js';
import { TextField, Select } from '/design/src/components/content.js';
import { autonomyExplanation } from './autonomy-badge.js';
import { state, schedule } from '../../state.js';
import { toast, failMsg } from '../../toasts.js';
import { patchCaseApi, fetchCase } from '../../api.js';
import { patchFieldCase, teamRoster, loadRoster } from '../../api-roles.js';
import { brandName, entityLabel, EntityLabel } from '../../vocabulary.js';
const h = webjsx.createElement;

const DEFAULT_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const DEFAULT_CASE_TYPES = ['unset', 'outbreak', 'follow_up', 'lab_sample', 'import_alert'];
const AUTONOMY_OPTS = ['auto', 'assisted', 'observe'];

const OPTION_LABEL = {
    unset: 'Not set yet',
    outbreak: 'Symptom cluster',
    follow_up: 'Follow-up',
    lab_sample: 'Lab sample',
    import_alert: 'Import alert',
    low: 'Low',
    normal: 'Normal',
    high: 'High',
    urgent: 'Urgent',
    auto: 'Answer on its own',
    assisted: 'Draft, then I send',
    observe: 'Log only, I reply',
};

function labelled(values) {
    return values.map(v => ({ value: v, label: OPTION_LABEL[v] || v }));
}
const INTERNAL_TAG_PREFIXES = ['health:', 'intake_mode:', 'snoozed-until:', 'stop-pending:'];
const INTERNAL_TAG_EXACT = new Set(['needs-human', 'draft-pending', 'unsent_draft', 'ai-offline', 'degraded-turn-seen', 'sent-back']);

function isInternalTag(t) { return INTERNAL_TAG_EXACT.has(t) || INTERNAL_TAG_PREFIXES.some(p => t.startsWith(p)); }
function operatorTagsOnly(tags) { return String(tags || '').split(',').map(s => s.trim()).filter(t => t && !isInternalTag(t)).join(','); }

function draftFor(c) {
    return {
        subject: c.subject || '', summary: c.summary || '', priority: c.priority || '',
        autonomy: c.autonomy || 'auto', assignee: c.assignee || '', assignee_label: c.assignee_name || c.assignee || '', case_type: c.case_type || 'unset',
        tags: operatorTagsOnly(c.tags),
    };
}

function SourceNote({ source }) {
    const brand = brandName();
    if (source !== 'agent') return null;
    return h('p', { class: 'casey-source-note casey-hint' },
        brand + ' filled this in from what the reporter said. Nobody has checked it yet.');
}

function assigneeControl(d, set) {
    const roster = teamRoster();
    if (!roster.length) return h('div', { key: 'assignee-text' }, TextField({ label: 'Assignee', value: d.assignee, onInput: (v) => set('assignee', v) }));
    const opts = [{ value: '', label: 'Nobody yet' }, ...roster.filter((m) => !m.alias_of).map((m) => ({ value: m.key, label: m.name + ' (' + m.role + ', ' + m.via + ')' }))];
    const held = d.assignee === 'agent' ? '' : (d.assignee || '');
    const aliasOf = (roster.find((m) => m.key === held) || {}).alias_of;
    const current = aliasOf || held;
    if (current && !opts.some((o) => o.value === current)) opts.push({ value: current, label: d.assignee_label || current });
    return h('div', { key: 'assignee-pick' }, Select({ label: 'Assigned to', value: current, options: opts, onChange: (v) => set('assignee', v) }));
}

export function FieldsEditor({ c, caseTypeSource, onSaved, key, limited = false, expectedRef = null, beforeSave = null, titleNote = null } = {}) {
    if (!limited) loadRoster(schedule);
    if (!state._fieldsDraft || state._fieldsDraftFor !== c.id) {
        state._fieldsDraft = draftFor(c);
        state._fieldsBase = draftFor(c);
        state._fieldsDraftFor = c.id;
    }
    const d = state._fieldsDraft;
    const base = state._fieldsBase || draftFor(c);
    const set = (k, v) => { d[k] = v; schedule(); };
    const cfg = state.config || {};
    const priorities = (cfg.priority && cfg.priority.length) ? cfg.priority : DEFAULT_PRIORITIES;
    const caseTypes = (cfg.case_type && cfg.case_type.length) ? cfg.case_type : DEFAULT_CASE_TYPES;
    const saving = !!state._fieldsSaving;

    const save = async () => {
        if (beforeSave && !(await beforeSave())) return;
        state._fieldsSaving = true; schedule();
        const patch = {};
        const expected = {};
        for (const k of (limited ? ['subject', 'summary', 'priority'] : ['subject', 'summary', 'priority', 'assignee', 'autonomy'])) {
            if (d[k] === base[k]) continue;
            patch[k] = d[k];
            expected[k] = base[k];
        }
        if (d.case_type !== base.case_type) { patch.case_type = d.case_type; expected.case_type = base.case_type; }
        try {
            if (d.tags !== base.tags) {
                const fresh = await fetchCase(c.id).catch(() => null);
                const tagSource = (fresh && fresh.case && fresh.case.tags != null) ? fresh.case.tags : c.tags;
                const internalTags = String(tagSource || '').split(',').map(s => s.trim()).filter(t => t && isInternalTag(t));
                const editedTags = d.tags.split(',').map(s => s.trim()).filter(Boolean);
                patch.tags = [...internalTags, ...editedTags].join(',');
                expected.tags = [...internalTags, ...base.tags.split(',').map(s => s.trim()).filter(Boolean)].join(',');
            }
            if (!Object.keys(patch).length) {
                state._fieldsSaving = false;
                toast('Nothing to save -- no field was changed.', 'ok');
                schedule();
                return;
            }
            if (expectedRef) await patchFieldCase(c.id, expectedRef, { ...patch, expected });
            else await patchCaseApi(c.id, { ...patch, expected });
            state._fieldsSaving = false;
            toast(expectedRef ? 'Your edits are saved to ' + expectedRef + '.' : 'Your edits are saved.', 'ok');
            if (onSaved) await onSaved();
            state._fieldsDraft = null;
            state._fieldsBase = null;
            schedule();
        } catch (e) {
            state._fieldsSaving = false;
            if (e && e.status === 409) {
                toast(await failMsg(e, 'Somebody else edited this ' + entityLabel() + ' while you were typing. Your edits were not saved -- their values are on screen now, so check them and edit again if you still need to.'), 'warn');
                if (onSaved) await onSaved();
                state._fieldsDraft = null;
                state._fieldsBase = null;
                schedule();
                return;
            }
            toast(await failMsg(e, 'Your edits were not saved. They are still on the form, so press Save edits again.'), 'err');
            schedule();
        }
    };

    return h('div', { key, class: 'casey-fields-editor' },
        titleNote ? h('p', { class: 'casey-hint field-editing-note' }, titleNote) : null,
        h('div', { class: 'casey-fields-row' },
            Select({ label: 'Priority', value: d.priority, options: labelled(priorities), onChange: (v) => set('priority', v) }),
            limited ? null : Select({
                label: 'Who answers', value: d.autonomy, options: labelled(AUTONOMY_OPTS),
                onChange: (v) => set('autonomy', v), hint: autonomyExplanation(d.autonomy)
            }),
            limited ? null : assigneeControl(d, set),
            h('div', {},
                Select({
                    label: EntityLabel() + ' type', value: d.case_type, options: labelled(caseTypes),
                    onChange: (v) => set('case_type', v),
                    hint: 'Groups this ' + entityLabel() + ' in the totals. Changing it is written to the timeline.'
                }),
                SourceNote({ source: caseTypeSource })
            )
        ),
        TextField({ label: 'Subject', value: d.subject, onInput: (v) => set('subject', v) }),
        TextField({ label: 'Tags', value: d.tags, onInput: (v) => set('tags', v), hint: 'Your own labels for this ' + entityLabel() + '. The ones the system keeps for itself are held separately and cannot be lost by editing here.' }),
        TextField({ label: 'Summary', multiline: true, rows: 3, value: d.summary, onInput: (v) => set('summary', v) }),
        Btn({ variant: 'primary', disabled: saving, children: saving ? 'Saving...' : 'Save edits', onClick: save })
    );
}
