// Two-pane layout composer per architecture spec section 5: CaseListView and
// CaseDetailView as siblings inside AppShell's main slot -- the list stays
// put while a case is open (j/k/o/Escape keyboard triage, worst-first inbox
// workflow). Below the mobile breakpoint CSS (.app-two-pane) stacks the
// detail pane full-viewport; state.activeId is the single source of truth
// either layout branch keys off, so no separate mobile-only component is
// needed.

import * as webjsx from 'webjsx';
import { state, schedule } from '../state.js';
import * as api from '../api.js';
import { toast } from '../toasts.js';
import { CaseListView } from './case-list-view.js';
import { CaseDetailView } from './case-detail-view.js';
import { confirmDialog } from '../components/dialog-shell.js';
const h = webjsx.createElement;

function closeCase() {
  state.activeId = null;
  try {
    const url = new URL(location.href);
    if (url.hash.startsWith('#case=')) history.replaceState(null, '', location.pathname + location.search);
  } catch { /* hash sync best-effort */ }
  schedule();
}

function openCase(id) {
  state.activeId = id;
  try { location.hash = 'case=' + encodeURIComponent(id); } catch { /* hash sync best-effort */ }
  schedule();
}

async function promptNewCase() {
  const subject = ((await confirmDialog({ title: 'New case', inputLabel: 'What is it about? (e.g. "sick cattle near Musina")' })) || '').trim();
  if (!subject) return;
  try {
    const created = await api.createCase({ subject });
    toast('Case created', 'ok');
    await reloadCases();
    if (created && created.id) openCase(created.id);
  } catch (e) { toast('Could not create case: ' + (e.message || ''), 'err'); }
}

async function promptTag(id) {
  const tag = ((await confirmDialog({ title: 'Add a tag', inputLabel: 'Tag' })) || '').trim();
  if (!tag) return;
  try { await api.postBulk([id], 'tag', { tag }); toast('Tagged', 'ok'); await reloadCases(); }
  catch (e) { toast('Could not tag: ' + (e.message || ''), 'err'); }
}

async function promptNote(id) {
  const text = ((await confirmDialog({ title: 'Add a note', inputLabel: 'Note' })) || '').trim();
  if (!text) return;
  try { await api.postNote(id, text); toast('Note saved', 'ok'); }
  catch (e) { toast('Could not save note: ' + (e.message || ''), 'err'); }
}

async function reloadCases() {
  try {
    const rows = await api.fetchCases();
    const list = Array.isArray(rows) ? rows : (rows && rows.cases) || [];
    state.allCases = list;
    schedule();
  } catch { /* connection banner already surfaces the failure */ }
}

export function CaseListDetailLayout() {
  const hasActive = state.activeId != null;
  return h('div', { class: 'app-two-pane' + (hasActive ? ' has-active' : '') },
    h('div', { class: 'case-list-pane', key: 'list' },
      CaseListView({
        onOpenIntake: promptNewCase,
        onPromptTag: promptTag,
        onPromptNote: promptNote,
        onReloadCases: reloadCases,
      })
    ),
    h('div', { class: 'case-detail-pane', key: 'detail' },
      CaseDetailView({ onClose: closeCase, onOpenCase: openCase, key: 'detail-view' })
    )
  );
}

export { openCase, closeCase, reloadCases, promptNewCase };
