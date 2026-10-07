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
  const subject = ((await confirmDialog({ title: 'New ' + entityLabel(), inputLabel: 'What is it about? (e.g. "sick cattle near Musina")' })) || '').trim();
  if (!subject) return;
  try {
    const created = await api.createCase({ subject });
    toast(EntityLabel() + ' created.', 'ok');
    await reloadCases();
    if (created && created.id) openCase(created.id);
  } catch (e) { toast(await failMsg(e, 'The ' + entityLabel() + ' was not created. Nothing was saved -- try again.'), 'err'); }
}

async function promptTag(onTag) {
  const tag = ((await confirmDialog({ title: 'Add a tag', inputLabel: 'Tag' })) || '').trim();
  if (!tag) return;
  onTag(tag);
}

async function promptNote(onNote) {
  const text = ((await confirmDialog({ title: 'Add a note', inputLabel: 'Note', confirmLabel: 'Save note', requireInput: true })) || '').trim();
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
    h('div', Object.assign({ class: 'case-detail-pane', key: 'detail' }, hasActive ? {} : { tabindex: '0', role: 'region', 'aria-label': EntityLabel() + ' details' }),
      CaseDetailView({ onClose: closeCase, onOpenCase: openCase, key: 'detail-view' })
    )
  );
}

export { openCase, closeCase, reloadCases, promptNewCase };
