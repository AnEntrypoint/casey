import * as webjsx from 'webjsx';
import { Btn } from 'ds/components/shell.js';
import { Select } from 'ds/components/content.js';
import { state, clearBulkSelect } from '../../state.js';
import { postBulk } from '../../api.js';
import { toast, failMsg } from '../../toasts.js';
import { confirmDialog } from '../../components/dialog-shell.js';
import { stageLabel } from '../../format.js';
import { entityLabel, entityLabelPlural } from '../../vocabulary.js';
import { word } from '../../words.js';
const h = webjsx.createElement;

const VERB_KEY = { claim: 'ui.bulk_bar_verb_claim', transition: 'ui.bulk_bar_verb_transition', tag: 'ui.bulk_bar_verb_tag', untag: 'ui.bulk_bar_verb_untag', note: 'ui.bulk_bar_verb_note', draft_approve: 'ui.bulk_bar_verb_draft_approve', draft_discard: 'ui.bulk_bar_verb_draft_discard', remind: 'ui.bulk_bar_verb_remind' };

async function runBulk(action, extra, onDone) {
  const ids = [...state.bulkSelected];
  if (!ids.length) return;
  if (action === 'claim' && !(state.currentUser && state.currentUser.username)) {
    toast(word('ui.bulk_bar_pick_who'), 'warn');
    return;
  }
  try {
    const j = await postBulk(ids, action, extra);
    const verb = VERB_KEY[action] ? word(VERB_KEY[action]) : action;
    const noun = (j.ok === 1) ? entityLabel() : entityLabelPlural();
    const ok = word('ui.bulk_bar_result', { verb, n: j.ok || 0, noun });
    toast(j.failed
      ? word('ui.bulk_bar_result_failed', { ok, failed: j.failed })
      : ok, j.failed ? 'warn' : 'ok');
    clearBulkSelect();
    onDone && onDone();
  } catch (e) {
    toast(await failMsg(e, word('ui.bulk_bar_fail_nothing')), 'err');
  }
}

export function BulkBar({ stages, onDone, onPromptTag, onPromptNote }) {
  const n = state.bulkSelected.size;
  if (!n) return null;
  return h('div', { class: 'ds-bulkbar', role: 'toolbar', 'aria-label': word('ui.bulk_bar_toolbar_label') },
    h('span', { key: 'count', class: 'ds-bulkbar-count' }, word('ui.bulk_bar_selected', { n })),
    Btn({ key: 'claim', size: 'sm', onClick: () => runBulk('claim', null, onDone), children: word('ui.bulk_bar_claim') }),
    Select({
      key: 'stage', size: 'sm', placeholder: word('ui.bulk_bar_move_to'),
      options: (stages || []).map((s) => ({ value: s, label: stageLabel(s) })),
      onChange: (v) => { if (v) runBulk('transition', { to: v }, onDone); },
    }),
    Btn({ key: 'tag', size: 'sm', variant: 'ghost', onClick: () => onPromptTag && onPromptTag((tag) => runBulk('tag', { tag }, onDone)), children: word('ui.bulk_bar_tag') }),
    Btn({ key: 'untag', size: 'sm', variant: 'ghost', onClick: () => onPromptTag && onPromptTag((tag) => runBulk('untag', { tag }, onDone)), children: word('ui.bulk_bar_untag') }),
    Btn({ key: 'note', size: 'sm', variant: 'ghost', onClick: () => onPromptNote && onPromptNote((text) => runBulk('note', { text }, onDone)), children: word('ui.bulk_bar_note') }),
    Btn({
      key: 'draft-approve', size: 'sm', variant: 'ghost',
      title: word('ui.bulk_bar_send_drafts_title', { entity: entityLabel() }),
      onClick: async () => {
        const n = state.bulkSelected.size;
        if (!n) return;
        if (await confirmDialog({
          title: word('ui.bulk_bar_send_drafts_question', { n, people: word(n === 1 ? 'ui.bulk_bar_person' : 'ui.bulk_bar_people') }),
          message: word('ui.bulk_bar_send_drafts_message', { n, noun: n === 1 ? entityLabel() : entityLabelPlural(), entity: entityLabel() }),
          confirmLabel: word('ui.bulk_bar_send_drafts_confirm'),
        }) === null) return;
        runBulk('draft_approve', null, onDone);
      },
      children: word('ui.bulk_bar_send_drafts'),
    }),
    Btn({ key: 'draft-discard', size: 'sm', variant: 'ghost', title: word('ui.bulk_bar_discard_title', { entity: entityLabel() }), onClick: () => runBulk('draft_discard', null, onDone), children: word('ui.bulk_bar_discard') }),
    Btn({
      key: 'remind', size: 'sm', variant: 'ghost',
      title: word('ui.bulk_bar_remind_title', { entity: entityLabel() }),
      onClick: async () => {
        const n = state.bulkSelected.size;
        if (!n) return;
        if (await confirmDialog({
          title: word('ui.bulk_bar_remind_question', { n, people: word(n === 1 ? 'ui.bulk_bar_person' : 'ui.bulk_bar_people') }),
          message: word('ui.bulk_bar_remind_message', { entity: entityLabel() }),
          confirmLabel: word('ui.bulk_bar_remind_confirm'),
        }) === null) return;
        runBulk('remind', null, onDone);
      },
      children: word('ui.bulk_bar_remind'),
    }),
    Btn({ key: 'clear', size: 'sm', variant: 'ghost', title: word('ui.bulk_bar_clear_title'), onClick: () => clearBulkSelect(), children: word('ui.bulk_bar_clear') })
  );
}
