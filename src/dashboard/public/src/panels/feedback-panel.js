import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { DetailRow } from '/design/src/components/content/row.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { state } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchFeedback, fetchOperatorNames } from '../api-team.js';
import { fmtTime, NO_TIME_TEXT } from '../format.js';
import { tierLabel } from '../vocabulary.js';
import { word } from '../words.js';

const h = webjsx.createElement;

const loader = createPanelLoader({
  what: () => word('ui.feedback_panel_what'),
  label: () => word('ui.feedback_panel_loading'),
  fetch: async () => {
    const [f, ops] = await Promise.all([fetchFeedback(), fetchOperatorNames().catch(() => ({ operators: [] }))]);
    const names = new Map(((ops && ops.operators) || []).map((o) => [o.id, o.name]));
    return { ...f, items: (f.items || []).map((i) => ({ ...i, from: names.get(i.from) || i.from })) };
  },
  apply: (j) => { state._feedback = j; },
});

const ROLE_KEY = { admin: 'ui.feedback_panel_role_admin', operator: 'ui.feedback_panel_role_operator', secretary: 'ui.feedback_panel_role_operator' };
export function roleWord(k) {
  if (ROLE_KEY[k]) return word(ROLE_KEY[k]);
  const t = k === 'eco_ranger' ? 'field_worker' : k;
  return tierLabel(t);
}

function weekWord(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return isNaN(d) ? iso : word('ui.feedback_panel_week_of', { date: d.toLocaleDateString('en-ZA', { timeZone: 'UTC', day: 'numeric', month: 'short' }) });
}

export function FeedbackPanel() {
  loader.ensureLoaded();
  const body = loader.slot(() => {
    const f = state._feedback || { total: 0, by_week: [], by_tier: {}, items: [] };
    if (!f.total) return Alert({ kind: 'info', children: word('ui.feedback_panel_none') });
    const roles = Object.entries(f.by_tier || {}).sort((a, b) => b[1] - a[1]);
    return h('div', { class: 'ds-people-page' },
      h('div', { key: 'counts', class: 'ds-feedback-counts' },
        Panel({ title: word('ui.feedback_panel_by_week'), children: Table({ headers: [word('ui.feedback_panel_h_week'), word('ui.feedback_panel_h_comments')], rows: f.by_week.map((w) => [weekWord(w.week), String(w.count)]) }) }),
        Panel({ title: word('ui.feedback_panel_by_kind'), children: Table({ headers: [word('ui.feedback_panel_h_who'), word('ui.feedback_panel_h_comments')], rows: roles.map(([k, n]) => [roleWord(k), String(n)]) }) })),
      Panel({
        key: 'items', title: word('ui.feedback_panel_comments_title'), count: f.total,
        children: [
          ...f.items.map((i) => DetailRow({
            key: i.id,
            label: word('ui.feedback_panel_item_label', {
              from: i.from || word('ui.feedback_panel_someone'),
              role: roleWord(i.tier),
              time: fmtTime(i.at) || NO_TIME_TEXT,
              source: i.source === 'gui' ? word('ui.feedback_panel_from_dashboard') : word('ui.feedback_panel_on_whatsapp'),
            }),
            value: i.text,
          })),
          f.total > f.items.length ? h('p', { key: 'more', class: 'casey-hint' }, word('ui.feedback_panel_showing', { shown: f.items.length, total: f.total })) : null,
        ].filter(Boolean),
      }));
  });
  return Panel({ children: [body] });
}
