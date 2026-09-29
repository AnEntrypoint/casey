// area-note.js -- where this report sits on the area list, and the warning when it
// looks like it is with the wrong area's ranger. Staff only: GET /api/cases/:id
// carries `area` for a staff login and never for a field login, so nothing renders
// for the field team. The server works the flag out (areas.js possiblyWrongArea);
// this says it in words and offers the fix (POST /api/cases/:id/relocate).

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { postRelocate } from '../../api-team.js';
import { toast, failMsg } from '../../toasts.js';
import { confirmDialog } from '../../components/dialog-shell.js';
import { entityLabel } from '../../vocabulary.js';
import { wrongAreaSentences, suggestedArea } from '../../panels/area-common.js';
const h = webjsx.createElement;

function parseReport(raw) { try { return raw ? JSON.parse(raw) : {}; } catch { return {}; } }

async function move(c, target, onReload) {
  const ok = await confirmDialog({
    title: 'Move ' + c.ref + ' to ' + target.name + '?',
    message: 'It will be handed to the first ranger for ' + target.name + '. Whoever holds it now will no longer have it. The change is written on the ' + entityLabel() + "'s history.",
    confirmLabel: 'Move ' + c.ref,
  });
  if (ok === null) return;
  try {
    const j = await postRelocate(c.id, { area: target.id, reassign: true, reason: 'Corrected from the ' + entityLabel() + ' page', expected_ref: c.ref });
    toast('Moved ' + c.ref + ' to ' + target.name + (j.assigned_to ? '. It is now with ' + j.assigned_to.name + '.' : '.'), 'ok');
    if (onReload) await onReload();
  } catch (e) { toast(await failMsg(e, c.ref + ' was not moved. Nothing changed.'), 'err'); }
}

export function AreaNote({ c, area, onReload }) {
  if (!area) return null;
  const report = parseReport(c.report);
  const flag = area.possibly_wrong_area;
  const where = area.area
    ? 'Area: ' + area.area.name
    : (area.association ? 'Area written on the report: "' + area.association + '". No area on the list covers it yet.' : null);
  const target = suggestedArea(flag);
  return h('div', { class: 'casey-area-note' },
    where ? h('p', { key: 'where', class: 'casey-hint' }, where) : null,
    flag ? Alert({
      key: 'wrong', kind: 'warn', title: 'This ' + entityLabel() + ' may be in the wrong area',
      children: [
        ...wrongAreaSentences(flag, report).map((t, i) => h('p', { key: 's' + i }, t)),
        target ? h('div', { key: 'act', class: 'ds-contact-actions' }, Btn({ variant: 'primary', children: 'Move it to ' + target.name, onClick: () => move(c, target, onReload) })) : null,
      ].filter(Boolean),
    }) : null);
}
