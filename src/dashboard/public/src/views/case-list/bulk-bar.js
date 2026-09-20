// Bulk selection toolbar: claim / move to stage / tag / untag / note / send
// drafts / discard drafts / clear. Renders only while something is selected.

import * as webjsx from 'webjsx';
import { Btn } from 'ds/components/shell.js';
import { Select } from 'ds/components/content.js';
import { state, clearBulkSelect } from '../../state.js';
import { postBulk } from '../../api.js';
import { toast, failMsg } from '../../toasts.js';
import { stageLabel } from '../../format.js';
import { entityLabel, entityLabelPlural } from '../../vocabulary.js';
const h = webjsx.createElement;

const VERB = { claim: 'Claimed', transition: 'Moved', tag: 'Tagged', untag: 'Untagged', note: 'Noted', draft_approve: 'Sent', draft_discard: 'Discarded' };

async function runBulk(action, extra, onDone) {
  const ids = [...state.bulkSelected];
  if (!ids.length) return;
  if (action === 'claim' && !(state.currentUser && state.currentUser.username)) {
    toast('Pick who you are first (log in) so claims are recorded against you.', 'warn');
    return;
  }
  try {
    const j = await postBulk(ids, action, extra);
    // A bulk result has two numbers and the failure half used to be stated as
    // "moved 7, 2 could not be moved" -- a count with no reason, which leaves
    // an operator unable to tell a permissions refusal from a stage that does
    // not exist from a row somebody else had already moved. The server does
    // not itemise, so this says plainly where to look instead of implying the
    // two are interchangeable.
    const verb = VERB[action] || action;
    const noun = (j.ok === 1) ? entityLabel() : entityLabelPlural();
    const ok = verb + ' ' + (j.ok || 0) + ' ' + noun + '.';
    toast(j.failed
      ? ok + ' ' + j.failed + ' did not change -- open those to see why.'
      : ok, j.failed ? 'warn' : 'ok');
    clearBulkSelect();
    onDone && onDone();
  } catch (e) {
    toast(await failMsg(e, 'Nothing was changed -- the bulk action did not reach the server. Your selection is still here, so try again.'), 'err');
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
      // label: s rendered the raw thatcher enum, so this dropdown offered
      // "in_progress" and "triaging" while every other stage surface on the
      // same screen -- the row, the pill strip, the case header -- said
      // "Working on it" and "Looking into it" through stageLabel(). One
      // vocabulary, and this was the one control still speaking the database's.
      options: (stages || []).map((s) => ({ value: s, label: stageLabel(s) })),
      onChange: (v) => { if (v) runBulk('transition', { to: v }, onDone); },
    }),
    Btn({ key: 'tag', size: 'sm', variant: 'ghost', onClick: () => onPromptTag && onPromptTag((tag) => runBulk('tag', { tag }, onDone)), children: 'Tag' }),
    Btn({ key: 'untag', size: 'sm', variant: 'ghost', onClick: () => onPromptTag && onPromptTag((tag) => runBulk('untag', { tag }, onDone)), children: 'Untag' }),
    Btn({ key: 'note', size: 'sm', variant: 'ghost', onClick: () => onPromptNote && onPromptNote((text) => runBulk('note', { text }, onDone)), children: 'Note' }),
    Btn({ key: 'draft-approve', size: 'sm', variant: 'ghost', title: 'Send the waiting draft on each selected ' + entityLabel() + ', exactly as written', onClick: () => runBulk('draft_approve', null, onDone), children: 'Send drafts' }),
    Btn({ key: 'draft-discard', size: 'sm', variant: 'ghost', title: 'Discard the waiting draft on each selected ' + entityLabel(), onClick: () => runBulk('draft_discard', null, onDone), children: 'Discard drafts' }),
    Btn({ key: 'clear', size: 'sm', variant: 'ghost', title: 'Clear selection', onClick: () => clearBulkSelect(), children: 'Clear' })
  );
}
