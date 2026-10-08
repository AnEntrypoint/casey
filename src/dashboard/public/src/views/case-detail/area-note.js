import * as webjsx from '/design/vendor/webjsx/index.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { postRelocate } from '../../api-team.js';
import { toast, failMsg } from '../../toasts.js';
import { confirmDialog } from '../../components/dialog-shell.js';
import { entityLabel } from '../../vocabulary.js';
import { wrongAreaSentences, suggestedArea } from '../../panels/area-common.js';
import { word } from '../../words.js';
const h = webjsx.createElement;

function parseReport(raw) { try { return raw ? JSON.parse(raw) : {}; } catch { return {}; } }

async function move(c, target, onReload) {
  const ok = await confirmDialog({
    title: word('ui.area_note_move_title', { ref: c.ref, name: target.name }),
    message: word('ui.area_note_move_message', { name: target.name, entity: entityLabel() }),
    confirmLabel: word('ui.area_note_move_confirm', { ref: c.ref }),
  });
  if (ok === null) return;
  try {
    const j = await postRelocate(c.id, { area: target.id, reassign: true, reason: 'Corrected from the ' + entityLabel() + ' page', expected_ref: c.ref });
    toast(j.assigned_to
      ? word('ui.area_note_moved_with', { ref: c.ref, name: target.name, assignee: String(j.assigned_to.name) })
      : word('ui.area_note_moved', { ref: c.ref, name: target.name }), 'ok');
    if (onReload) await onReload();
  } catch (e) { toast(await failMsg(e, word('ui.area_note_not_moved', { ref: c.ref })), 'err'); }
}

export function AreaNote({ c, area, onReload }) {
  if (!area) return null;
  const report = parseReport(c.report);
  const flag = area.possibly_wrong_area;
  const where = area.area
    ? word('ui.area_note_area', { name: area.area.name })
    : (area.association ? word('ui.area_note_written', { association: area.association }) : null);
  const target = suggestedArea(flag);
  return h('div', { class: 'casey-area-note' },
    where ? h('p', { key: 'where', class: 'casey-hint' }, where) : null,
    flag ? Alert({
      key: 'wrong', kind: 'warn', title: word('ui.area_note_wrong_title', { entity: entityLabel() }),
      children: [
        ...wrongAreaSentences(flag, report).map((t, i) => h('p', { key: 's' + i }, t)),
        target ? h('div', { key: 'act', class: 'ds-contact-actions' }, Btn({ variant: 'primary', children: word('ui.area_note_move_to', { name: target.name }), onClick: () => move(c, target, onReload) })) : null,
      ].filter(Boolean),
    }) : null);
}
