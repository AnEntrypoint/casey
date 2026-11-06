import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Row, DetailRow } from '/design/src/components/content/row.js';
import { Kpi } from '/design/src/components/content/charts.js';
import { Alert, Skeleton } from '/design/src/components/content/feedback.js';
import { schedule } from '../state.js';
import { pollMyDay } from '../api-team.js';
import { stageLabel } from '../format.js';
import { entityLabelPlural } from '../vocabulary.js';
import { word } from '../words.js';
const h = webjsx.createElement;

const md = { data: null, loading: false, loaded: false, error: '' };

export async function refreshMyDay() {
  if (md.loading) return;
  md.loading = true;
  const hadError = md.error;
  let changed = !md.loaded;
  try {
    const { body, unchanged } = await pollMyDay();
    if (!unchanged) { md.data = body; changed = true; }
    md.error = '';
  }
  catch { md.error = word('ui.my_day_load_failed'); changed = true; }
  if (md.error !== hadError) changed = true;
  md.loading = false; md.loaded = true;
  if (changed) schedule();
}

const stages = (by) => Object.entries(by || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => word('ui.my_day_stage_count', { stage: stageLabel(k), n })).join(word('ui.my_day_sep_sentence'));

const CHANGED = [
  ['new_cases', 'ui.my_day_changed_new'], ['reporter_replies', 'ui.my_day_changed_replies'], ['newly_assigned_to_you', 'ui.my_day_changed_assigned'],
  ['sent_back', 'ui.my_day_changed_sent_back'], ['handed_to_desk', 'ui.my_day_changed_handed'], ['signed_off', 'ui.my_day_changed_signed_off'], ['moved_stage', 'ui.my_day_changed_moved'],
];

function AreaPanel(d) {
  const a = d.in_your_area;
  if (!a) return Panel({ key: 'area', title: word('ui.my_day_area_title'), children: h('p', { class: 'casey-hint' }, word('ui.my_day_no_area', { entity_plural: entityLabelPlural() })) });
  const more = word('ui.my_day_area_counts', { someone: a.with_someone_else, nobody: a.unassigned }) + (Object.keys(a.by_stage || {}).length ? word('ui.my_day_by_stage_area', { stages: stages(a.by_stage) }) : '');
  return Panel({
    key: 'area', title: word('ui.my_day_area_title'),
    children: [
      Kpi({ items: [[a.open_now, word('ui.my_day_open_now')], [a.new_today, word('ui.my_day_new_today')], [a.with_you, word('ui.my_day_with_you')], [a.handed_to_desk, word('ui.my_day_with_technician')]] }),
      h('p', { key: 'more', class: 'casey-hint' }, more),
    ],
  });
}

function YoursPanel(d, tech) {
  const y = d.yours;
  const items = [[y.open_now, word('ui.my_day_open_now')]];
  if (!tech) items.push([y.record_full_not_handed_over, word('ui.my_day_complete_not_sent')], [y.with_the_technician, word('ui.my_day_with_technician')]);
  items.push([y.finished_today, word('ui.my_day_finished_today')]);
  return Panel({
    key: 'yours', title: word('ui.my_day_your_title', { entity_plural: entityLabelPlural() }),
    children: [
      Kpi({ items }),
      Object.keys(y.by_stage || {}).length ? h('p', { key: 'stage', class: 'casey-hint' }, word('ui.my_day_by_stage_plain', { stages: stages(y.by_stage) })) : null,
    ].filter(Boolean),
  });
}

function Changed(d) {
  const s = d.since_the_day_began || {};
  const rows = CHANGED.filter(([k]) => s[k] > 0).map(([k, labelKey]) => DetailRow({ key: k, label: word(labelKey), value: String(s[k]) }));
  return rows.length ? rows : h('p', { class: 'casey-hint' }, word('ui.my_day_nothing_changed'));
}

function SignOffDesk(d) {
  const s = d.sign_off_desk;
  if (!s) return null;
  return Panel({
    title: word('ui.my_day_signoff_title'), children: [
      DetailRow({ key: 'w', label: word('ui.my_day_waiting'), value: String(s.waiting) }),
      DetailRow({ key: 'r', label: word('ui.my_day_sent_by_rangers'), value: String(s.handed_over_by_rangers) }),
      DetailRow({ key: 'u', label: word('ui.my_day_complete_nobody'), value: String(s.unassigned_and_full) }),
      DetailRow({ key: 'd', label: word('ui.my_day_still_to_record'), value: String(s.diagnosis_still_to_record) }),
    ],
  });
}

export function MyDay({ onOpenRef, part = 'top', tech = false }) {
  if (!md.loaded) { refreshMyDay(); return part === 'top' ? Panel({ title: word('ui.my_day_title'), children: Skeleton({ count: 4, height: '1.4em', label: word('ui.my_day_loading_label') }) }) : null; }
  if (!md.data) return part === 'top' && md.error ? Alert({ kind: 'warn', children: md.error }) : null;
  const d = md.data;
  const needs = d.needs || [];
  const stale = part === 'top' && md.error ? Alert({ kind: 'warn', children: word('ui.my_day_refresh_failed') }) : null;
  if (part === 'after') {
    return h('div', { class: 'field-day' },
      Panel({ key: 'changed', title: word('ui.my_day_changed_title'), children: Changed(d) }),
      needs.length ? Panel({
        key: 'needs', title: word('ui.my_day_needs_title'), count: d.needs_total || needs.length,
        children: [
          ...needs.map((n) => Row({ key: n.ref, title: n.what || n.ref, sub: word('ui.my_day_need_sub', { ref: n.ref, stage: stageLabel(n.stage), needs: (n.needs || []).join(word('ui.my_day_sep_sentence')) }), onClick: onOpenRef ? () => onOpenRef(n.ref) : undefined })),
          d.needs_total > d.needs_shown ? h('p', { key: 'more', class: 'casey-hint' }, word('ui.my_day_showing', { shown: d.needs_shown, total: d.needs_total, entity_plural: entityLabelPlural() })) : null,
        ].filter(Boolean),
      }) : null);
  }
  return h('div', { class: 'field-day' }, stale, tech ? null : AreaPanel(d), YoursPanel(d, tech), SignOffDesk(d));
}
