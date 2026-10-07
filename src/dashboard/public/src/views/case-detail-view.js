import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn, Icon } from '/design/src/components/shell.js';
import { Skeleton } from '/design/src/components/content.js';
import { state, schedule, setCaseDetail, setCaseDetailLoading, setCaseDetailError, setEditing, setRunConfig } from '../state.js';
import { fetchCase, fetchRunConfig, postNote } from '../api.js';
import { knownValueFields, loadKnownValues } from '../known-values.js';
import { toast, failMsg } from '../toasts.js';
import { CaseHeader } from './case-detail/header.js';
import { CaseProgress } from './case-detail/progress.js';
import { ReportSections } from './case-detail/report-sections.js';
import { ResearchNotesPanel } from './case-detail/research-notes.js';
import { FieldsEditor } from './case-detail/fields-editor.js';
import { Transitions } from './case-detail/transitions.js';
import { ReplyBox } from './case-detail/reply-box.js';
import { Timeline, reportLanguage } from './case-detail/timeline.js';
import { AreaNote } from './case-detail/area-note.js';
import { DedupPanel, loadDuplicateSuggestions } from './case-detail/dedup-panel.js';
import { SiteHistoryPanel, loadSiteHistory } from './case-detail/site-history.js';
import { SplitDialogTrigger, SplitDialog } from './case-detail/split-dialog.js';
import { SnoozeDialog, openSnoozeDialog } from './case-detail/snooze-dialog.js';
import { ShareDialog, openShareDialog } from './case-detail/share-dialog.js';
import { confirmDialog } from '../components/dialog-shell.js';
import { clusterNoteFor, canDispatchFor, dispatchWorkerFor } from '../panels/map-panel.js';
import { brandName, entityLabel, entityLabelPlural, countOf } from '../vocabulary.js';
import { word } from '../words.js';
const h = webjsx.createElement;

let _loadedFor = null;

export async function loadCaseDetail(id) {
    _loadedFor = id;
    setCaseDetailLoading(true);
    try {
        const data = await fetchCase(id);
        setCaseDetail(data);
        loadDuplicateSuggestions(id);
        loadSiteHistory(id);
        fetchRunConfig(id).then((cfg) => { if (state.activeId === id) setRunConfig(cfg); });
        for (const f of knownValueFields()) loadKnownValues(f).then(schedule);
    } catch (e) {
        setCaseDetailError((e && e.status === 404)
            ? 'This ' + entityLabel() + ' is not here any more. It may have been merged or removed -- go back to the list and open it again.'
            : word('ui.load_one_failed'));
    }
}

async function reload(id) { await loadCaseDetail(id || state.activeId); }

function LinkedReportsNote({ caseId }) {
    const note = clusterNoteFor(caseId);
    if (!note) return null;
    const names = note.reportedDiseaseNames.length
        ? ' -- as reported: ' + note.reportedDiseaseNames.join(', ')
        : '';
    return h('div', { class: 'casey-linked-reports' },
        `Linked to ${countOf(note.others, 'other ' + entityLabel(), 'other ' + entityLabelPlural())} nearby${names}`,
        names ? h('p', { class: 'casey-hint' }, 'Reports nearby that may be the same or a related situation. The names were given by the worker or farmer, not confirmed by a lab.') : null);
}

function pauseWhileEditing(el) {
    if (!el || el._caseyEditGuard) return;
    el._caseyEditGuard = true;
    el.addEventListener('focusin', (e) => { if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) setEditing(true); });
    el.addEventListener('focusout', (e) => { if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) setEditing(false); });
}

function backControl(onClose) {
    return Btn({ variant: 'link', size: 'sm', class: 'casey-back-btn', 'aria-label': 'Back to the list', onClick: onClose,
        children: [Icon('chevron-left', { size: 14 }), ' Back to the list'] });
}

export function CaseDetailView({ onClose, onOpenCase, key, showBack = true } = {}) {
    const id = state.activeId;
    if (!id) return h('div', { key, class: 'casey-detail-empty' },
        Icon('paw', { size: 32 }),
        h('h2', { class: 'casey-detail-empty-title' }, 'No report open yet'),
        h('p', { class: 'casey-hint' }, 'Tap a pin on the map, or a report in the list, to read it and reply.'),
        h('p', { class: 'casey-hint casey-empty-kbd-hint' }, 'Keyboard (optional): ', h('span', { class: 'ds-kbd' }, 'j'), '/', h('span', { class: 'ds-kbd' }, 'k'), ' moves through the list, ', h('span', { class: 'ds-kbd' }, 'Enter'), ' opens it.'));

    if (_loadedFor !== id && !state.caseDetailLoading) loadCaseDetail(id);

    if (state.caseDetailError) {
        return h('div', { key, class: 'casey-detail-error' },
            showBack ? backControl(onClose) : null,
            h('p', { class: 'casey-hint' }, state.caseDetailError),
            h('div', { class: 'casey-timeline-actions' },
                Btn({ size: 'sm', variant: 'primary', children: 'Try again', onClick: () => { _loadedFor = null; setCaseDetailError(null); loadCaseDetail(id); } })));
    }
    if (!state.caseDetail || state.caseDetail.case.id !== id) {
        return h('div', { key, class: 'casey-detail-loading' }, Skeleton({ count: 6, height: '1.4em', label: 'loading the report' }));
    }

    const { case: c, events, transitions, events_total, suggested_assignee, case_type_source } = state.caseDetail;

    return h('div', { key, class: 'casey-detail-pane', tabindex: '-1', ref: pauseWhileEditing },
        showBack ? backControl(onClose) : null,
        CaseHeader({ c, suggestedAssignee: suggested_assignee, reporter: state.caseDetail.reporter, onReload: reload, onOpenShare: openShareDialog, onOpenSnooze: openSnoozeDialog }),
        LinkedReportsNote({ caseId: id }),
        AreaNote({ c, area: state.caseDetail.area, onReload: () => reload(id) }),
        CaseProgress({ status: c.status }),
        ReportSections({ c, events, onSaved: () => reload(id) }),
        Transitions({ c, transitions, onReload: reload }),
        ReplyBox({ c, events, onReload: reload }),
        FieldsEditor({ c, caseTypeSource: case_type_source, onSaved: () => reload(id) }),
        ResearchNotesPanel({ case: c }),
        DedupPanel({ caseId: id, onReload: reload }),
        SiteHistoryPanel({ onOpenCase }),
        h('div', { class: 'casey-timeline-actions' },
            SplitDialogTrigger({ caseId: id }),
            canDispatchFor(id)
                ? Btn({
                    size: 'sm', variant: 'ghost', children: 'Dispatch a worker',
                    onClick: () => dispatchWorkerFor(id),
                })
                : null,
            canDispatchFor(id)
                ? h('p', { class: 'casey-hint' }, 'Suggests a field worker for this ' + entityLabel() + '. ' + brandName() + ' never messages the worker directly -- they are told the next time they message in themselves.')
                : null,
            Btn({ size: 'sm', variant: 'ghost', children: '+ Note', onClick: async () => {
                const text = ((await confirmDialog({ title: 'Add a note', inputLabel: 'Add a note to this ' + entityLabel(), confirmLabel: 'Save note', requireInput: true })) || '').trim();
                if (!text) return;
                try { await postNote(id, text); toast('Note added to the timeline.', 'ok'); await reload(id); }
                catch (e) { toast(await failMsg(e, 'The note was not saved. Nothing was added to the timeline -- try again.'), 'err'); }
            } })
        ),
        Timeline({ caseId: id, events, eventsTotal: events_total, canTranslate: true, caseRef: c.ref, language: reportLanguage(c) }),
        SplitDialog({ onReload: reload }),
        SnoozeDialog({ onReload: reload }),
        ShareDialog({})
    );
}
