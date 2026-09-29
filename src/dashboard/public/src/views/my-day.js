// my-day.js -- "how many are in my area today and where do they stand", on the
// field team's home. Built from GET /api/my-day (routes/areas.js): counts by stage,
// what has changed since the day began, and what each report still needs. The
// server sends no phone number, no reporter name and no assignee key; this only
// words it. Three kit panels, each answering one question, so the ranger reads down
// the page in the order they would ask them.
import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Row, DetailRow } from '/design/src/components/content/row.js';
import { Kpi } from '/design/src/components/content/charts.js';
import { Alert, Skeleton } from '/design/src/components/content/feedback.js';
import { schedule } from '../state.js';
import { fetchMyDay } from '../api-team.js';
import { stageLabel } from '../format.js';
import { entityLabelPlural } from '../vocabulary.js';
const h = webjsx.createElement;

const md = { data: null, loading: false, loaded: false, error: '' };

export async function refreshMyDay() {
  if (md.loading) return;
  md.loading = true;
  try { md.data = await fetchMyDay(); md.error = ''; }
  catch { md.error = 'Could not load your day. The lists below are still right.'; }
  md.loading = false; md.loaded = true; schedule();
}

const stages = (by) => Object.entries(by || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => stageLabel(k) + ': ' + n).join('. ');

const CHANGED = [
  ['new_cases', 'New reports'], ['reporter_replies', 'Replies from reporters'], ['newly_assigned_to_you', 'Newly given to you'],
  ['sent_back', 'Sent back to you'], ['handed_to_desk', 'Handed to the technician'], ['signed_off', 'Signed off'], ['moved_stage', 'Moved to another stage'],
];

function AreaPanel(d) {
  const a = d.in_your_area;
  if (!a) return Panel({ key: 'area', title: 'My day: in your area', children: h('p', { class: 'casey-hint' }, 'No area is set for you yet, so this page covers only the ' + entityLabelPlural() + ' given to you. An operator can set your area.') });
  const more = ['With someone else: ' + a.with_someone_else, 'with nobody yet: ' + a.unassigned].join(', ') + '.' + (Object.keys(a.by_stage || {}).length ? ' By stage: ' + stages(a.by_stage) + '.' : '');
  return Panel({
    key: 'area', title: 'My day: in your area',
    children: [
      Kpi({ items: [[a.open_now, 'Open now'], [a.new_today, 'New today'], [a.with_you, 'With you'], [a.handed_to_desk, 'With the technician']] }),
      h('p', { key: 'more', class: 'casey-hint' }, more),
    ],
  });
}

function YoursPanel(d, tech) {
  const y = d.yours;
  const items = [[y.open_now, 'Open now']];
  if (!tech) items.push([y.record_full_not_handed_over, 'Complete, not yet sent'], [y.with_the_technician, 'With the technician']);
  items.push([y.finished_today, 'Finished today']);
  return Panel({
    key: 'yours', title: 'My day: your ' + entityLabelPlural(),
    children: [
      Kpi({ items }),
      Object.keys(y.by_stage || {}).length ? h('p', { key: 'stage', class: 'casey-hint' }, 'By stage: ' + stages(y.by_stage) + '.') : null,
    ].filter(Boolean),
  });
}

function Changed(d) {
  const s = d.since_the_day_began || {};
  const rows = CHANGED.filter(([k]) => s[k] > 0).map(([k, label]) => DetailRow({ key: k, label, value: String(s[k]) }));
  return rows.length ? rows : h('p', { class: 'casey-hint' }, 'Nothing has changed since the day began.');
}

function SignOffDesk(d) {
  const s = d.sign_off_desk;
  if (!s) return null;
  return Panel({
    title: 'The sign-off desk', children: [
      DetailRow({ key: 'w', label: 'Waiting for sign-off', value: String(s.waiting) }),
      DetailRow({ key: 'r', label: 'Sent by rangers', value: String(s.handed_over_by_rangers) }),
      DetailRow({ key: 'u', label: 'Complete, with nobody', value: String(s.unassigned_and_full) }),
      DetailRow({ key: 'd', label: 'Still to record: the disease and what to do', value: String(s.diagnosis_still_to_record) }),
    ],
  });
}

// part 'top': how many are in the area and where they stand (and, for a technician, the sign-off
// desk). part 'after': what changed since the day began and what each report still needs, placed after
// the person's own list so that list stays near the top on a phone.
export function MyDay({ onOpenRef, part = 'top', tech = false }) {
  if (!md.loaded) { refreshMyDay(); return part === 'top' ? Panel({ title: 'My day', children: Skeleton({ count: 4, height: '1.4em', label: 'loading your day' }) }) : null; }
  if (!md.data) return part === 'top' && md.error ? Alert({ kind: 'warn', children: md.error }) : null;
  const d = md.data;
  const needs = d.needs || [];
  if (part === 'after') {
    return h('div', { class: 'field-day' },
      Panel({ key: 'changed', title: 'My day: what changed since it began', children: Changed(d) }),
      needs.length ? Panel({
        key: 'needs', title: 'My day: what each one still needs', count: d.needs_total || needs.length,
        children: [
          ...needs.map((n) => Row({ key: n.ref, title: n.what || n.ref, sub: n.ref + '. ' + stageLabel(n.stage) + '. ' + (n.needs || []).join('. '), onClick: onOpenRef ? () => onOpenRef(n.ref) : undefined })),
          d.needs_total > d.needs_shown ? h('p', { key: 'more', class: 'casey-hint' }, 'Showing ' + d.needs_shown + ' of ' + d.needs_total + ' ' + entityLabelPlural() + '.') : null,
        ].filter(Boolean),
      }) : null);
  }
  return h('div', { class: 'field-day' }, tech ? null : AreaPanel(d), YoursPanel(d, tech), SignOffDesk(d));
}
