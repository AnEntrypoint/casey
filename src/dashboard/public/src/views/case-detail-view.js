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
            ? word('ui.case_detail_view_not_here', { entity: entityLabel() })
            : word('ui.load_one_failed'));
    }
}

async function reload(id) { await loadCaseDetail(id || state.activeId); }

function LinkedReportsNote({ caseId }) {
    const note = clusterNoteFor(caseId);
    if (!note) return null;
    const names = note.reportedDiseaseNames.length
        ? word('ui.case_detail_view_as_reported', { names: note.reportedDiseaseNames.join(', ') })
        : '';
    const others = countOf(note.others,
        word('ui.case_detail_view_other_one', { entity: entityLabel() }),
        word('ui.case_detail_view_other_many', { entity_plural: entityLabelPlural() }));
    return h('div', { class: 'casey-linked-reports' },
        word('ui.case_detail_view_linked', { count: others, names }),
        names ? h('p', { class: 'casey-hint' }, word('ui.case_detail_view_nearby_hint')) : null);
}

function pauseWhileEditing(el) {
    if (!el || el._caseyEditGuard) return;
    el._caseyEditGuard = true;
    el.addEventListener('focusin', (e) => { if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) setEditing(true); });
    el.addEventListener('focusout', (e) => { if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) setEditing(false); });
}

function backControl(onClose) {
    return Btn({ variant: 'link', size: 'sm', class: 'casey-back-btn', 'aria-label': word('ui.case_detail_view_back_label'), onClick: onClose,
        children: [Icon('chevron-left', { size: 14 }), word('ui.case_detail_view_back')] });
}

export function CaseDetailView({ onClose, onOpenCase, key, showBack = true } = {}) {
    const id = state.activeId;
    if (!id) return h('div', { key, class: 'casey-detail-empty' },
        Icon('paw', { size: 32 }),
        h('h2', { class: 'casey-detail-empty-title' }, word('ui.case_detail_view_empty_title')),
        h('p', { class: 'casey-hint' }, word('ui.case_detail_view_empty_hint')),
        h('p', { class: 'casey-hint casey-empty-kbd-hint' }, word('ui.case_detail_view_kbd_intro'), h('span', { class: 'ds-kbd' }, word('ui.case_detail_view_key_j')), '/', h('span', { class: 'ds-kbd' }, word('ui.case_detail_view_key_k')), word('ui.case_detail_view_kbd_moves'), h('span', { class: 'ds-kbd' }, word('ui.case_detail_view_key_enter')), word('ui.case_detail_view_kbd_opens')));

    if (_loadedFor !== id && !state.caseDetailLoading) loadCaseDetail(id);

    if (state.caseDetailError) {
        return h('div', { key, class: 'casey-detail-error' },
            showBack ? backControl(onClose) : null,
            h('p', { class: 'casey-hint' }, state.caseDetailError),
            h('div', { class: 'casey-timeline-actions' },
                Btn({ size: 'sm', variant: 'primary', children: word('ui.case_detail_view_try_again'), onClick: () => { _loadedFor = null; setCaseDetailError(null); loadCaseDetail(id); } })));
    }
    if (!state.caseDetail || state.caseDetail.case.id !== id) {
        return h('div', { key, class: 'casey-detail-loading' }, Skeleton({ count: 6, height: '1.4em', label: word('ui.case_detail_view_loading') }));
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
                    size: 'sm', variant: 'ghost', children: word('ui.case_detail_view_dispatch'),
                    onClick: () => dispatchWorkerFor(id),
                })
                : null,
            canDispatchFor(id)
                ? h('p', { class: 'casey-hint' }, word('ui.case_detail_view_dispatch_hint', { entity: entityLabel(), brand: brandName() }))
                : null,
            Btn({ size: 'sm', variant: 'ghost', children: word('ui.case_detail_view_note_button'), onClick: async () => {
                const text = ((await confirmDialog({ title: word('ui.case_detail_view_note_title'), inputLabel: word('ui.case_detail_view_note_input', { entity: entityLabel() }), confirmLabel: word('ui.case_detail_view_note_save'), requireInput: true })) || '').trim();
                if (!text) return;
                try { await postNote(id, text); toast(word('ui.case_detail_view_note_added'), 'ok'); await reload(id); }
                catch (e) { toast(await failMsg(e, word('ui.case_detail_view_note_failed')), 'err'); }
            } })
        ),
        Timeline({ caseId: id, events, eventsTotal: events_total, canTranslate: true, caseRef: c.ref, language: reportLanguage(c) }),
        SplitDialog({ onReload: reload }),
        SnoozeDialog({ onReload: reload }),
        ShareDialog({})
    );
}
