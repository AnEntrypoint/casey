import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn } from '/design/src/components/shell.js';
import { TextField } from '/design/src/components/content.js';
import { Dialog } from '../../components/dialog-shell.js';
import { state, schedule, setDuplicateSuggestions } from '../../state.js';
import { toast, failMsg } from '../../toasts.js';
import { fetchSuggestions, postMerge } from '../../api.js';
import { brandName, entityLabel, entityLabelPlural } from '../../vocabulary.js';
import { word } from '../../words.js';
const h = webjsx.createElement;

export function loadDuplicateSuggestions(caseId) {
    fetchSuggestions(caseId).then(j => setDuplicateSuggestions((j && j.suggestions) || [])).catch(() => setDuplicateSuggestions([]));
}

export function DedupPanel({ caseId, onReload, key } = {}) {
    const suggestions = state.duplicateSuggestions;
    if (!suggestions || !suggestions.length) return null;
    const mergeOpen = !!state._mergeDialogFor;
    const target = state._mergeDialogTarget || {};

    const openMerge = (s) => { state._mergeDialogFor = caseId; state._mergeDialogTarget = s; state._mergeReason = ''; schedule(); };
    const closeMerge = () => { state._mergeDialogFor = null; schedule(); };
    const confirmMerge = async () => {
        try {
            const res = await postMerge(caseId, target.id, (state._mergeReason || '').trim());
            toast(res.alreadyMerged
                ? word('ui.dedup_panel_already')
                : word('ui.dedup_panel_merged', { ref: target.ref, count: res.movedEvents || 0 }), 'ok');
            closeMerge();
            if (onReload) await onReload(caseId);
        } catch (e) { toast(await failMsg(e, word('ui.dedup_panel_failed')), 'err'); }
    };

    return h('div', { key, class: 'casey-dedup-panel' },
        h('h3', {}, word('ui.dedup_panel_heading', { entity: entityLabel() })),
        h('p', { class: 'casey-hint' }, word('ui.dedup_panel_lead', { brand: brandName(), entity_plural: entityLabelPlural() })),
        ...suggestions.map(s => h('div', { key: s.id, class: 'casey-dup-row' },
            h('b', {}, s.ref), ' ', s.subject || '',
            h('span', { class: 'casey-hint' }, word('ui.dedup_panel_reasons', { reasons: (s.reasons || []).join(', ') })),
            Btn({ size: 'sm', variant: 'danger', children: word('ui.dedup_panel_merge_into', { ref: s.ref }), onClick: () => openMerge(s) })
        )),
        Dialog({
            open: mergeOpen, title: word('ui.dedup_panel_dialog_title', { ref: target.ref || '', entity: entityLabel() }), onClose: closeMerge,
            children: [
                h('p', { key: 'lead' }, word('ui.dedup_panel_dialog_lead', { entity: entityLabel() })),
                TextField({ key: 'reason', label: word('ui.dedup_panel_reason_label'), multiline: true, rows: 2, placeholder: word('ui.dedup_panel_reason_placeholder'), value: state._mergeReason || '', onInput: (v) => { state._mergeReason = v; schedule(); } }),
                h('div', { key: 'acts', class: 'ds-dialog-actions' },
                    Btn({ key: 'cancel', variant: 'ghost', children: word('ui.dedup_panel_cancel'), onClick: closeMerge }),
                    Btn({ key: 'ok', variant: 'danger', children: word('ui.dedup_panel_merge_plural', { entity_plural: entityLabelPlural() }), onClick: confirmMerge })
                )
            ]
        })
    );
}
