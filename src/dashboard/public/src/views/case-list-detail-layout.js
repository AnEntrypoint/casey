import * as webjsx from 'webjsx';
import { state, schedule, setActiveId, setCases } from '../state.js';
import * as api from '../api.js';
import { toast, failMsg } from '../toasts.js';
import { entityLabel, EntityLabel, EntityLabelPlural } from '../vocabulary.js';
import { CaseListView, setListError } from './case-list-view.js';
import { CaseDetailView } from './case-detail-view.js';
import { ViewTitle } from './view-title.js';
import { panelTitle } from './nav-config.js';
import { confirmDialog } from '../components/dialog-shell.js';
import { word } from '../words.js';
const h = webjsx.createElement;

function closeCase() {
  setActiveId(null);
  try {
    const url = new URL(location.href);
    if (url.hash.startsWith('#case=')) history.replaceState(null, '', location.pathname + location.search);
  } catch {  }
  schedule();
}

function openCase(id) {
  setActiveId(id);
  try { location.hash = 'case=' + encodeURIComponent(id); } catch {  }
  schedule();
}

async function promptNewCase() {
  const subject = ((await confirmDialog({ title: word('ui.case_list_detail_layout_new_title', { entity: entityLabel() }), inputLabel: word('ui.case_list_detail_layout_subject_label') })) || '').trim();
  if (!subject) return;
  try {
    const created = await api.createCase({ subject });
    toast(word('ui.case_list_detail_layout_created', { entity: EntityLabel() }), 'ok');
    await reloadCases();
    if (created && created.id) openCase(created.id);
  } catch (e) { toast(await failMsg(e, word('ui.case_list_detail_layout_not_created', { entity: entityLabel() })), 'err'); }
}

async function promptTag(onTag) {
  const tag = ((await confirmDialog({ title: word('ui.case_list_detail_layout_add_tag'), inputLabel: word('ui.case_list_detail_layout_tag_label') })) || '').trim();
  if (!tag) return;
  onTag(tag);
}

async function promptNote(onNote) {
  const text = ((await confirmDialog({ title: word('ui.case_list_detail_layout_add_note'), inputLabel: word('ui.case_list_detail_layout_note_label'), confirmLabel: word('ui.case_list_detail_layout_save_note'), requireInput: true })) || '').trim();
  if (!text) return;
  onNote(text);
}

async function reloadCases() {
  try {
    const rows = await api.fetchCases();
    const list = Array.isArray(rows) ? rows : (rows && rows.cases) || [];
    setListError('');
    setCases(list, rows && typeof rows.total === 'number' ? rows.total : list.length);
  } catch {
    setListError(word('ui.load_list_failed'));
    schedule();
  }
}

export function CaseListDetailLayout() {
  const hasActive = state.activeId != null;
  return h('div', { class: 'app-two-pane grow' + (hasActive ? ' has-active' : '') },
    ViewTitle(panelTitle('home_cases') || EntityLabelPlural()),
    h('div', { class: 'case-list-pane', key: 'list' },
      CaseListView({
        onPromptTag: promptTag,
        onPromptNote: promptNote,
        onReloadCases: reloadCases,
      })
    ),
    h('div', Object.assign({ class: 'case-detail-pane', key: 'detail' }, hasActive ? {} : { tabindex: '0', role: 'region', 'aria-label': word('ui.case_list_detail_layout_details_aria', { entity: EntityLabel() }) }),
      CaseDetailView({ onClose: closeCase, onOpenCase: openCase, key: 'detail-view' })
    )
  );
}

export { openCase, closeCase, reloadCases, promptNewCase };
