// Bulk selection toolbar: claim/transition/tag/untag/note/draft-approve/
// draft-discard/clear, restyled onto Btn/Dropdown (ux-case-list-bulk-actions,
// kept behaviorally identical to the legacy toolbar, restyled onto the SDK).

import * as ds from '/design/dist/247420.js';
import { state, clearBulkSelect } from '../../state.js';
import { postBulk } from '../../api.js';
import { toast, failMsg } from '../../toasts.js';
const { Btn, Select, Dropdown } = ds.components;
const h = ds.h;

const VERB = { claim: 'claimed', transition: 'moved', tag: 'tagged', untag: 'untagged', note: 'noted', draft_approve: 'sent', draft_discard: 'discarded' };

async function runBulk(action, extra, onDone) {
  const ids = [...state.bulkSelected];
  if (!ids.length) return;
  if (action === 'claim' && !(state.currentUser && state.currentUser.username)) {
    toast('Pick who you are first (log in) so claims are recorded against you.', 'warn');
    return;
  }
  try {
    const j = await postBulk(ids, action, extra);
    const verb = VERB[action] || action;
    toast(verb + ' ' + (j.ok || 0) + (j.failed ? (', ' + j.failed + ' could not be ' + verb) : ''), j.failed ? 'warn' : 'ok');
    clearBulkSelect();
    onDone && onDone();
  } catch (e) {
    toast('Bulk error: ' + (await failMsg(e, 'bulk action failed')), 'err');
  }
}

export function BulkBar({ stages, onDone, onPromptTag, onPromptNote }) {
  const n = state.bulkSelected.size;
  if (!n) return null;
  return h('div', { class: 'ds-bulk-bar', role: 'toolbar', 'aria-label': 'Bulk actions' },
    h('span', { key: 'count', class: 'ds-bulk-count' }, n + ' selected'),
    Btn({ key: 'claim', size: 'sm', onClick: () => runBulk('claim', null, onDone), children: 'Claim' }),
    Select({
      key: 'stage', size: 'sm', placeholder: 'Move to...',
      options: (stages || []).map((s) => ({ value: s, label: s })),
      onChange: (v) => { if (v) runBulk('transition', { to: v }, onDone); },
    }),
    Btn({ key: 'tag', size: 'sm', variant: 'ghost', onClick: () => onPromptTag && onPromptTag((tag) => runBulk('tag', { tag }, onDone)), children: 'Tag' }),
    Btn({ key: 'untag', size: 'sm', variant: 'ghost', onClick: () => onPromptTag && onPromptTag((tag) => runBulk('untag', { tag }, onDone)), children: 'Untag' }),
    Btn({ key: 'note', size: 'sm', variant: 'ghost', onClick: () => onPromptNote && onPromptNote((text) => runBulk('note', { text }, onDone)), children: 'Note' }),
    Btn({ key: 'draft-approve', size: 'sm', variant: 'ghost', title: "Send each selected case's pending draft as composed", onClick: () => runBulk('draft_approve', null, onDone), children: 'Send drafts' }),
    Btn({ key: 'draft-discard', size: 'sm', variant: 'ghost', title: "Discard each selected case's pending draft", onClick: () => runBulk('draft_discard', null, onDone), children: 'Discard drafts' }),
    Btn({ key: 'clear', size: 'sm', variant: 'ghost', title: 'Clear selection', onClick: () => clearBulkSelect(), children: 'Clear' })
  );
}
