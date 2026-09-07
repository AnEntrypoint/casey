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
import { confirmDialog } from '../components/dialog-shell.js';
import { clusterNoteFor, canDispatchFor, dispatchWorkerFor } from '../panels/map-panel.js';
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

// "What is going on HERE", not "what is this one pin". The cluster linkage is
// computed server-side (clusters.js buildClusters, shipped in /api/map/cases)
// and used to be visible only inside the map pin's popup; the popup is gone
// (see map-leaflet.js) and this is its new home, where it sits beside the rest
// of the case rather than on top of the neighbouring pins. Renders nothing
// when there is no live map or the case stands alone -- on the case-list side
// of the app that is always, and silence is the correct output there.
function LinkedReportsNote({ caseId }) {
    const note = clusterNoteFor(caseId);
    if (!note) return null;
    const names = note.diseases.length ? ': ' + note.diseases.join(', ') : '';
    return h('div', {
        class: 'casey-linked-reports',
        title: 'Reports nearby that may be the same or a related situation',
    }, `Linked to ${note.others} other report(s) nearby${names}`);
}

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
        // Plain instruction first, keyboard shortcuts second and explicitly
        // marked optional: this pane is the first thing a new operator reads
        // on the map-first home view, and "j/k to move through the list" is
        // meaningless to the field/secretarial staff this dashboard is for.
        // The shortcuts still earn their place for daily desk users, so they
        // are demoted rather than removed.
        h('h2', { class: 'casey-detail-empty-title' }, 'No report open yet'),
        h('p', { class: 'casey-hint' }, 'Tap a pin on the map, or a report in the list, to read it and reply.'),
        h('p', { class: 'casey-hint casey-empty-kbd-hint' }, 'Keyboard (optional): ', h('span', { class: 'ds-kbd' }, 'j'), '/', h('span', { class: 'ds-kbd' }, 'k'), ' moves through the list, ', h('span', { class: 'ds-kbd' }, 'Enter'), ' opens it.'));

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
        LinkedReportsNote({ caseId: id }),
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
            // The pin popup was this action's ONLY entry point in the whole
            // app, so removing the popup without re-homing it would have
            // silently deleted a capability. Offered only when a live map
            // actually has this case plotted -- the picker ranks workers by
            // distance from the case and reads its roster from the worker
            // overlay, so without a map there is nothing to rank and nothing
            // to pick from.
            canDispatchFor(id)
                ? Btn({
                    size: 'sm', variant: 'ghost', children: 'Dispatch a worker',
                    title: 'Suggest a field worker for this case -- casey never messages them directly, they hear about it on their own next reply-in',
                    onClick: () => dispatchWorkerFor(id),
                })
                : null,
            Btn({ size: 'sm', variant: 'ghost', children: '+ Note', onClick: async () => {
                const text = ((await confirmDialog({ title: 'Add a note', inputLabel: 'Add a note to this case' })) || '').trim();
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
