import * as webjsx from 'webjsx';
import { Btn } from 'ds/components/shell.js';
import { Select } from 'ds/components/content.js';
import { state, clearBulkSelect } from '../../state.js';
import { postBulk } from '../../api.js';
import { toast, failMsg } from '../../toasts.js';
import { confirmDialog } from '../../components/dialog-shell.js';
import { stageLabel } from '../../format.js';
import { entityLabel, entityLabelPlural } from '../../vocabulary.js';
const h = webjsx.createElement;

const VERB = { claim: 'Claimed', transition: 'Moved', tag: 'Tagged', untag: 'Untagged', note: 'Noted', draft_approve: 'Sent', draft_discard: 'Discarded', remind: 'Asked' };

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
  return h('div', { class: 'ds-bulkbar', role: 'toolbar', 'aria-label': 'Bulk actions' },
    h('span', { key: 'count', class: 'ds-bulkbar-count' }, n + ' selected'),
    Btn({ key: 'claim', size: 'sm', onClick: () => runBulk('claim', null, onDone), children: 'Claim' }),
    Select({
      key: 'stage', size: 'sm', placeholder: 'Move to...',
      options: (stages || []).map((s) => ({ value: s, label: stageLabel(s) })),
      onChange: (v) => { if (v) runBulk('transition', { to: v }, onDone); },
    }),
    Btn({ key: 'tag', size: 'sm', variant: 'ghost', onClick: () => onPromptTag && onPromptTag((tag) => runBulk('tag', { tag }, onDone)), children: 'Tag' }),
    Btn({ key: 'untag', size: 'sm', variant: 'ghost', onClick: () => onPromptTag && onPromptTag((tag) => runBulk('untag', { tag }, onDone)), children: 'Untag' }),
    Btn({ key: 'note', size: 'sm', variant: 'ghost', onClick: () => onPromptNote && onPromptNote((text) => runBulk('note', { text }, onDone)), children: 'Note' }),
    Btn({ key: 'draft-approve', size: 'sm', variant: 'ghost', title: 'Send the waiting draft on each selected ' + entityLabel() + ', exactly as written', onClick: () => runBulk('draft_approve', null, onDone), children: 'Send drafts' }),
    Btn({ key: 'draft-discard', size: 'sm', variant: 'ghost', title: 'Discard the waiting draft on each selected ' + entityLabel(), onClick: () => runBulk('draft_discard', null, onDone), children: 'Discard drafts' }),
    Btn({
      key: 'remind', size: 'sm', variant: 'ghost',
      title: 'Ask the person behind each selected ' + entityLabel() + ' to report back',
      onClick: async () => {
        const n = state.bulkSelected.size;
        if (!n) return;
        if (await confirmDialog({
          title: 'Ask ' + n + ' ' + (n === 1 ? 'person' : 'people') + ' to report back?',
          message: 'Sends ONE short message per selected ' + entityLabel() + ', on the channel that ' + entityLabel()
            + ' came in on, asking if anything has changed. Each names its own reference and how long it has been quiet.'
            + ' Anyone who asked us to stop, is outside their channel\'s reply window, or has already been asked without writing back is skipped and reported.',
          confirmLabel: 'Send the reminders',
        }) === null) return;
        runBulk('remind', null, onDone);
      },
      children: 'Ask to report back',
    }),
    Btn({ key: 'clear', size: 'sm', variant: 'ghost', title: 'Clear selection', onClick: () => clearBulkSelect(), children: 'Clear' })
  );
}
