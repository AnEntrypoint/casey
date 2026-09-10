// fields-editor.js -- priority / autonomy / assignee / case_type fields plus
// subject/tags/summary, the case-detail "Save edits" form. Config-declared
// enums (priority/case_type) come from state.config with the shipped
// defaults as fallback, matching the legacy CASEY_PRIORITIES/CASEY_CASE_TYPES
// behavior. Internal system tags (health:*/intake_mode:*/snoozed-until:*
// /needs-human/draft-pending/etc) are preserved untouched and never exposed
// in the editable Tags field -- same operatorTagsOnly()/isInternalTag() split
// as the legacy app.js.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn } from '/design/src/components/shell.js';
import { TextField, Select } from '/design/src/components/content.js';
import { autonomyExplanation } from './autonomy-badge.js';
import { state, schedule } from '../../state.js';
import { toast, failMsg } from '../../toasts.js';
import { patchCaseApi } from '../../api.js';
const h = webjsx.createElement;

const DEFAULT_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const DEFAULT_CASE_TYPES = ['unset', 'outbreak', 'follow_up', 'lab_sample', 'import_alert'];
const AUTONOMY_OPTS = ['auto', 'assisted', 'observe'];

// The dropdowns used to render the stored keys straight onto the screen, so
// an operator picked between "follow_up", "lab_sample" and "import_alert" --
// underscores, lower case, a database column read out loud. Select() takes
// {value,label} pairs, so the key still goes to the server and the person
// reads English. A value with no entry here falls back to its own key, which
// is what a deployment-added case type should do: show as itself rather than
// vanish from the list.
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
const INTERNAL_TAG_PREFIXES = ['health:', 'intake_mode:', 'snoozed-until:'];
const INTERNAL_TAG_EXACT = new Set(['needs-human', 'draft-pending', 'unsent_draft', 'ai-offline', 'degraded-turn-seen']);

function isInternalTag(t) { return INTERNAL_TAG_EXACT.has(t) || INTERNAL_TAG_PREFIXES.some(p => t.startsWith(p)); }
function operatorTagsOnly(tags) { return String(tags || '').split(',').map(s => s.trim()).filter(t => t && !isInternalTag(t)).join(','); }

function draftFor(c) {
    return {
        subject: c.subject || '', summary: c.summary || '', priority: c.priority || '',
        autonomy: c.autonomy || 'auto', assignee: c.assignee || '', case_type: c.case_type || 'unset',
        tags: operatorTagsOnly(c.tags),
    };
}

// Agent-suggested vs operator-confirmed marker: casey may only set case_type
// from a directly-stated fact, never its own inference (the report-not-assert
// paradigm -- see case-tools.js), so an agent-set value is still unverified
// until a human confirms it. Renders nothing once an operator has confirmed
// (edited/saved) it, since 'operator' becomes the source at that point.
//
// It read "unverified: agent-reported" at 10px: a colon taxonomy and two enum
// words, set smaller than anything else on the form, saying a thing that
// changes whether you trust the value above it. The words that were hidden in
// its `title` were the ones worth reading, and a title is a hover affordance
// -- it does not exist on a phone. Now it is one sentence, at the size the
// rest of the form's help text uses, with nothing behind a hover.
function SourceNote({ source }) {
    const brand = state.config?.dashboard_ui?.brand || 'casey';
    if (source !== 'agent') return null;
    return h('p', { class: 'casey-source-note casey-hint' },
        brand + ' filled this in from what the reporter said. Nobody has checked it yet.');
}

export function FieldsEditor({ c, caseTypeSource, onSaved, key } = {}) {
    if (!state._fieldsDraft || state._fieldsDraftFor !== c.id) {
        state._fieldsDraft = draftFor(c);
        state._fieldsDraftFor = c.id;
    }
    const d = state._fieldsDraft;
    const set = (k, v) => { d[k] = v; schedule(); };
    const cfg = state.config || {};
    const priorities = (cfg.priority && cfg.priority.length) ? cfg.priority : DEFAULT_PRIORITIES;
    const caseTypes = (cfg.case_type && cfg.case_type.length) ? cfg.case_type : DEFAULT_CASE_TYPES;
    const saving = !!state._fieldsSaving;

    const save = async () => {
        state._fieldsSaving = true; schedule();
        const internalTags = String(c.tags || '').split(',').map(s => s.trim()).filter(t => t && isInternalTag(t));
        const editedTags = d.tags.split(',').map(s => s.trim()).filter(Boolean);
        const body = {
            subject: d.subject, summary: d.summary, priority: d.priority,
            tags: [...internalTags, ...editedTags].join(','), assignee: d.assignee, autonomy: d.autonomy,
        };
        if (d.case_type !== (c.case_type || 'unset')) body.case_type = d.case_type;
        try {
            await patchCaseApi(c.id, body);
            state._fieldsSaving = false;
            toast('saved', 'ok');
            state._fieldsDraft = null;
            if (onSaved) await onSaved();
        } catch (e) {
            state._fieldsSaving = false;
            toast(await failMsg(e, 'save failed'), 'err');
            schedule();
        }
    };

    return h('div', { key, class: 'casey-fields-editor' },
        h('div', { class: 'casey-fields-row' },
            Select({ label: 'Priority', value: d.priority, options: labelled(priorities), onChange: (v) => set('priority', v) }),
            Select({
                label: 'Who answers', value: d.autonomy, options: labelled(AUTONOMY_OPTS),
                onChange: (v) => set('autonomy', v), hint: autonomyExplanation(d.autonomy)
            }),
            TextField({ label: 'Assignee', value: d.assignee, onInput: (v) => set('assignee', v) }),
            h('div', {},
                // The old hint was written for whoever wrote the endpoint:
                // "Segments every report aggregate. Changing it records a
                // case_type a -> b audit event." An operator does not have a
                // report aggregate, and case_type is the column name, not the
                // field they are looking at.
                Select({
                    label: 'Case type', value: d.case_type, options: labelled(caseTypes),
                    onChange: (v) => set('case_type', v),
                    hint: 'Groups this report in the totals. Changing it is written to the timeline.'
                }),
                SourceNote({ source: caseTypeSource })
            )
        ),
        TextField({ label: 'Subject', value: d.subject, onInput: (v) => set('subject', v) }),
        // The hint used to end "...is already shown above as badges", which
        // described the page's own chrome to the person looking at it -- and
        // stopped being true the moment those badges became sentences. What an
        // operator needs from this field is that their tags are kept apart
        // from the ones the system keeps for itself, and that editing here
        // cannot wipe those.
        TextField({ label: 'Tags', value: d.tags, onInput: (v) => set('tags', v), hint: 'Your own labels for this case. The ones the system keeps for itself are held separately and cannot be lost by editing here.' }),
        TextField({ label: 'Summary', multiline: true, rows: 3, value: d.summary, onInput: (v) => set('summary', v) }),
        Btn({ variant: 'primary', disabled: saving, children: saving ? 'Saving...' : 'Save edits', onClick: save })
    );
}
