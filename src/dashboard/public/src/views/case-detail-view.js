// case-detail-view.js -- right-pane case detail composer: fetches the case
// on activeId change, wires the header/progress/report-sections/timeline/
// reply-box/transitions/dedup/site-history/split-dialog/snooze-dialog/
// share-dialog children, and owns the "pause polling while editing" guard
// (state.editing) so a background refresh never clobbers an in-progress
// edit -- ported behavior from the legacy app.js openCase()'s focus/blur
// pause-polling discipline, generalized to every input/select/textarea via
// a single delegated focusin/focusout listener on the pane root.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn, IconButton, Icon } from '/design/src/components/shell.js';
import { Skeleton } from '/design/src/components/content.js';
import { state, schedule, setCaseDetail, setCaseDetailLoading, setCaseDetailError, setEditing, setRunConfig } from '../state.js';
import { fetchCase, fetchRunConfig, postNote } from '../api.js';
import { toast, failMsg } from '../toasts.js';
import { CaseHeader } from './case-detail/header.js';
import { CaseProgress } from './case-detail/progress.js';
import { ReportSections } from './case-detail/report-sections.js';
import { ResearchNotesPanel } from './case-detail/research-notes.js';
import { FieldsEditor } from './case-detail/fields-editor.js';
import { Transitions } from './case-detail/transitions.js';
import { ReplyBox } from './case-detail/reply-box.js';
import { Timeline } from './case-detail/timeline.js';
import { DedupPanel, loadDuplicateSuggestions } from './case-detail/dedup-panel.js';
import { SiteHistoryPanel, loadSiteHistory } from './case-detail/site-history.js';
import { SplitDialogTrigger, SplitDialog } from './case-detail/split-dialog.js';
import { SnoozeDialog, openSnoozeDialog } from './case-detail/snooze-dialog.js';
import { ShareDialog, openShareDialog } from './case-detail/share-dialog.js';
const h = webjsx.createElement;

let _loadedFor = null;

export async function loadCaseDetail(id) {
    setCaseDetailLoading(true);
    try {
        const data = await fetchCase(id);
        setCaseDetail(data);
        _loadedFor = id;
        loadDuplicateSuggestions(id);
        loadSiteHistory(id);
        // Best-effort per-run config override (see fetchRunConfig) -- resolves
        // null on a plain casey/uhh deployment (no /api/runs/:id/config route)
        // or a network failure, in which case report-sections.js falls back to
        // the global config exactly as before this existed.
        fetchRunConfig(id).then((cfg) => { if (state.activeId === id) setRunConfig(cfg); });
    } catch (e) {
        setCaseDetailError((e && e.message) || 'Could not load this case.');
    }
}

async function reload(id) { await loadCaseDetail(id || state.activeId); }

function pauseWhileEditing(el) {
    if (!el || el._caseyEditGuard) return;
    el._caseyEditGuard = true;
    el.addEventListener('focusin', (e) => { if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) setEditing(true); });
    el.addEventListener('focusout', (e) => { if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) setEditing(false); });
}

export function CaseDetailView({ onClose, onOpenCase, key } = {}) {
    const id = state.activeId;
    if (!id) return h('div', { key, class: 'casey-detail-empty' },
        Icon('paw', { size: 32 }),
        h('h2', { class: 'casey-detail-empty-title' }, 'No case selected'),
        h('p', { class: 'casey-hint' }, 'Select a case to observe, edit, reply, or override its workflow stage.'),
        h('p', { class: 'casey-hint casey-empty-kbd-hint' }, h('span', { class: 'ds-kbd' }, 'j'), '/', h('span', { class: 'ds-kbd' }, 'k'), ' to move through the list, ', h('span', { class: 'ds-kbd' }, 'Enter'), ' to open the highlighted case.'));

    if (_loadedFor !== id && !state.caseDetailLoading) loadCaseDetail(id);

    if (state.caseDetailError) {
        return h('div', { key, class: 'casey-detail-error' },
            h('button', { type: 'button', class: 'casey-back-btn', onclick: onClose }, Icon('chevron-left', { size: 14 }), ' cases'),
            h('p', { class: 'casey-hint' }, state.caseDetailError));
    }
    if (!state.caseDetail || state.caseDetail.case.id !== id) {
        return h('div', { key, class: 'casey-detail-loading' }, Skeleton({ count: 6, height: '1.4em' }));
    }

    const { case: c, events, transitions, events_total, suggested_assignee, case_type_source } = state.caseDetail;

    return h('div', { key, class: 'casey-detail-pane', tabindex: '-1', ref: pauseWhileEditing },
        h('button', { type: 'button', class: 'casey-back-btn', onclick: onClose }, Icon('chevron-left', { size: 14 }), ' cases'),
        CaseHeader({ c, suggestedAssignee: suggested_assignee, onReload: reload, onOpenShare: openShareDialog, onOpenSnooze: openSnoozeDialog }),
        CaseProgress({ status: c.status }),
        ReportSections({ c, events, onSaved: () => reload(id) }),
        ResearchNotesPanel({ case: c }),
        FieldsEditor({ c, caseTypeSource: case_type_source, onSaved: () => reload(id) }),
        Transitions({ c, transitions, onReload: reload }),
        ReplyBox({ c, events, onReload: reload }),
        DedupPanel({ caseId: id, onReload: reload }),
        SiteHistoryPanel({ onOpenCase }),
        h('div', { class: 'casey-timeline-actions' },
            SplitDialogTrigger({ caseId: id }),
            Btn({ size: 'sm', variant: 'ghost', children: '+ Note', onClick: async () => {
                const text = (prompt('Add a note to this case') || '').trim();
                if (!text) return;
                try { await postNote(id, text); toast('note saved', 'ok'); await reload(id); }
                catch (e) { toast(await failMsg(e, 'note failed'), 'err'); }
            } })
        ),
        Timeline({ caseId: id, events, eventsTotal: events_total }),
        SplitDialog({ onReload: reload }),
        SnoozeDialog({ onReload: reload }),
        ShareDialog({})
    );
}
