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
import { AutonomyBadge } from './autonomy-badge.js';
import { state, schedule } from '../../state.js';
import { toast, failMsg } from '../../toasts.js';
import { patchCaseApi } from '../../api.js';
const h = webjsx.createElement;

const DEFAULT_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const DEFAULT_CASE_TYPES = ['unset', 'outbreak', 'follow_up', 'lab_sample', 'import_alert'];
const AUTONOMY_OPTS = ['auto', 'assisted', 'observe'];
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

export function FieldsEditor({ c, onSaved, key } = {}) {
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
            Select({ label: 'Priority', value: d.priority, options: priorities, onChange: (v) => set('priority', v) }),
            h('div', {},
                Select({ label: 'Autonomy', value: d.autonomy, options: AUTONOMY_OPTS, onChange: (v) => set('autonomy', v) }),
                AutonomyBadge({ autonomy: d.autonomy })
            ),
            TextField({ label: 'Assignee', value: d.assignee, onInput: (v) => set('assignee', v) }),
            Select({ label: 'Case type', value: d.case_type, options: caseTypes, onChange: (v) => set('case_type', v), hint: 'Segments every report aggregate. Changing it records a case_type a -> b audit event.' })
        ),
        TextField({ label: 'Subject', value: d.subject, onInput: (v) => set('subject', v) }),
        TextField({ label: 'Tags', value: d.tags, onInput: (v) => set('tags', v), hint: 'Your own labels for this case. System-tracked status (health/intake/snooze) is already shown above as badges and is not edited here.' }),
        TextField({ label: 'Summary', multiline: true, rows: 3, value: d.summary, onInput: (v) => set('summary', v) }),
        Btn({ variant: 'primary', disabled: saving, children: saving ? 'Saving...' : 'Save edits', onClick: save })
    );
}
