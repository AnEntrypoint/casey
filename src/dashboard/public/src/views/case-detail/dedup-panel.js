// dedup-panel.js -- "possibly the same case" duplicate-suggestion panel
// inside the case-detail view: casey's grouping suggestions with a one-click
// merge (folds the other case into the one being viewed). Isolated and
// best-effort -- a suggestions failure must never break the case view.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn } from '/design/src/components/shell.js';
import { Alert } from '/design/src/components/content.js';
import { TextField } from '/design/src/components/content.js';
import { Dialog } from '../../components/dialog-shell.js';
import { state, schedule, setDuplicateSuggestions } from '../../state.js';
import { toast, failMsg } from '../../toasts.js';
import { fetchSuggestions, postMerge } from '../../api.js';
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
            toast(res.alreadyMerged ? 'already merged' : 'merged ' + target.ref + ' in (' + (res.movedEvents || 0) + ' events)', 'ok');
            closeMerge();
            if (onReload) await onReload(caseId);
        } catch (e) { toast(await failMsg(e, 'merge failed'), 'err'); }
    };

    return h('div', { key, class: 'casey-dedup-panel' },
        h('h3', {}, 'Possibly the same case'),
        h('p', { class: 'casey-hint' }, 'casey thinks these reports may be the same outbreak. Merge folds the other case into this one (you can review before confirming).'),
        ...suggestions.map(s => h('div', { key: s.id, class: 'casey-dup-row' },
            h('b', {}, s.ref), ' ', s.subject || '',
            h('span', { class: 'casey-hint' }, ' -- ' + (s.reasons || []).join(', ')),
            Btn({ size: 'sm', variant: 'danger', children: 'Merge ' + s.ref + ' into this', onClick: () => openMerge(s) })
        )),
        Dialog({
            open: mergeOpen, title: 'Merge ' + (target.ref || '') + ' into this case?', onClose: closeMerge,
            children: [
                h('p', { key: 'lead' }, 'The other case becomes a redirect. This is lossless and can be reviewed on the timeline.'),
                TextField({ key: 'reason', label: 'Why are these the same outbreak? (optional)', multiline: true, rows: 2, placeholder: 'e.g. same farm, same symptoms reported separately', value: state._mergeReason || '', onInput: (v) => { state._mergeReason = v; schedule(); } }),
                h('div', { key: 'acts', class: 'casey-dialog-actions' },
                    Btn({ key: 'cancel', variant: 'ghost', children: 'Cancel', onClick: closeMerge }),
                    Btn({ key: 'ok', variant: 'danger', children: 'Merge cases', onClick: confirmMerge })
                )
            ]
        })
    );
}
