// Feedback panel (staff) -- what testers and the team say about the system itself,
// newest first, with how much arrives each week and from which kind of person.
// Comments come from the "Send feedback" control every login has (components/
// feedback-dialog.js) and from people writing to the assistant on WhatsApp. They
// are kept apart from reports. Content-swap panel (state.activePanel ===
// 'feedback'); the page title and the way back come from app-view.js.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { DetailRow } from '/design/src/components/content/row.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { state } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchFeedback, fetchOperatorNames } from '../api-team.js';
import { fmtTime } from '../format.js';
import { tierLabel } from '../vocabulary.js';

const h = webjsx.createElement;

const loader = createPanelLoader({
  what: 'the feedback',
  label: 'loading feedback',
  // A comment from a dashboard login is stored under the login name; the person's own name comes from
  // the dashboard logins list.
  fetch: async () => {
    const [f, ops] = await Promise.all([fetchFeedback(), fetchOperatorNames().catch(() => ({ operators: [] }))]);
    const names = new Map(((ops && ops.operators) || []).map((o) => [o.id, o.name]));
    return { ...f, items: (f.items || []).map((i) => ({ ...i, from: names.get(i.from) || i.from })) };
  },
  apply: (j) => { state._feedback = j; },
});

// The stored kind of person is either a dashboard role or a WhatsApp rung; both
// are shown as the words this deployment uses for that person.
const ROLE_WORD = { admin: 'Administrator', operator: 'Operator', secretary: 'Operator' };
export function roleWord(k) {
  if (ROLE_WORD[k]) return ROLE_WORD[k];
  const t = k === 'eco_ranger' ? 'field_worker' : k;
  return tierLabel(t);
}

// "Week of 28 Sep" for the Monday a week starts on (the server groups by Monday).
function weekWord(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return isNaN(d) ? iso : 'Week of ' + d.toLocaleDateString('en-ZA', { timeZone: 'UTC', day: 'numeric', month: 'short' });
}

export function FeedbackPanel() {
  loader.ensureLoaded();
  const body = loader.slot(() => {
    const f = state._feedback || { total: 0, by_week: [], by_tier: {}, items: [] };
    if (!f.total) return Alert({ kind: 'info', children: 'No feedback yet. Everyone can send a note from their account menu (top right), and people can write to the assistant on WhatsApp.' });
    const roles = Object.entries(f.by_tier || {}).sort((a, b) => b[1] - a[1]);
    return h('div', { class: 'ds-people-page' },
      h('div', { key: 'counts', class: 'ds-feedback-counts' },
        Panel({ title: 'By week', children: Table({ headers: ['Week', 'Comments'], rows: f.by_week.map((w) => [weekWord(w.week), String(w.count)]) }) }),
        Panel({ title: 'By kind of person', children: Table({ headers: ['Who', 'Comments'], rows: roles.map(([k, n]) => [roleWord(k), String(n)]) }) })),
      Panel({
        key: 'items', title: 'Comments, newest first', count: f.total,
        children: [
          ...f.items.map((i) => DetailRow({ key: i.id, label: (i.from || 'Someone') + ' (' + roleWord(i.tier) + '), ' + fmtTime(i.at) + (i.source === 'gui' ? ', from the dashboard' : ', on WhatsApp'), value: i.text })),
          f.total > f.items.length ? h('p', { key: 'more', class: 'casey-hint' }, 'Showing the newest ' + f.items.length + ' of ' + f.total + '.') : null,
        ].filter(Boolean),
      }));
  });
  return Panel({ children: [body] });
}
