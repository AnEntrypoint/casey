import * as webjsx from '/design/vendor/webjsx/index.js';
import { AppShell, Topbar, Side, Crumb, Status, Icon, Btn } from '/design/src/components/shell.js';
import { Skeleton, Alert, Panel, Row as KitRow, SearchInput } from '/design/src/components/content.js';
import { state, schedule, closeModal } from '../state.js';
import { AccountMenu, LogoutEverywhereConfirmDialog } from '../components/account-menu.js';
import { ConnectionBanner } from '../components/connection-banner.js';
import { FeedbackDialog } from '../components/feedback-dialog.js';
import { ToastTray } from '../components/toast-tray.js';
import { Dialog, confirmDialog } from '../components/dialog-shell.js';
import { MapPanel } from '../panels/map-panel.js';
import { PillButton, QueueMore } from '../components/filter-chip.js';
import { toast, failMsg } from '../toasts.js';
import { createCase } from '../api.js';
import { fetchFieldCases, isTechnician, roleName } from '../api-roles.js';
import { pushHash } from '../route.js';
import { setActiveId } from '../state.js';
import { stageLabel, headline, rel } from '../format.js';
import { brandName, entityLabel, entityLabelPlural, EntityLabelPlural, countOf } from '../vocabulary.js';
import { word } from '../words.js';
import { ViewTitle, VIEW_TITLE_ID } from './view-title.js';
import { FieldCaseView, resetFieldCase } from './field-case.js';
import { MyDay, refreshMyDay } from './my-day.js';
import { holderName } from './field-names.js';
const h = webjsx.createElement;

const CLOSED_PAGE = 20;
const SEARCH_DEBOUNCE_MS = 300;
const HOLD_PILLS = ['open', 'claimed', 'closed'];
const ATTR_PILLS = ['sent-back', 'complete', 'incomplete', 'no-photo'];
const PILL_WORD = { open: 'ui.field_pill_open', claimed: 'ui.field_pill_claimed', closed: 'ui.field_pill_closed', 'sent-back': 'ui.field_pill_sent_back', complete: 'ui.field_pill_complete', incomplete: 'ui.field_pill_incomplete', 'no-photo': 'ui.field_pill_no_photo' };
const EXCLUSIVE = { complete: 'incomplete', incomplete: 'complete' };

const fs = { view: 'home', mine: [], signoff: [], mineTotal: 0, openTotal: 0, closed: [], closedTotal: 0, closedBusy: false, q: '', pills: new Set(), gen: 0, loaded: false, loading: false, error: '' };

let searchTimer = null;


export async function refreshFieldLists() {
  const gen = ++fs.gen;
  fs.loading = true;
  const q = fs.q.trim();
  try {
    const [mine, signoff, closed] = await Promise.all([
      fetchFieldCases('mine', { q, state: 'open' }),
      isTechnician() ? fetchFieldCases('signoff', { q }) : Promise.resolve({ cases: [] }),
      fetchFieldCases('mine', { q, state: 'closed', limit: CLOSED_PAGE }),
    ]);
    if (gen !== fs.gen) return;
    fs.mine = (mine && mine.cases) || [];
    fs.mineTotal = (mine && typeof mine.total === 'number') ? mine.total : fs.mine.length;
    if (!q) fs.openTotal = fs.mineTotal;
    fs.signoff = (signoff && signoff.cases) || [];
    fs.closed = (closed && closed.cases) || [];
    fs.closedTotal = (closed && typeof closed.total === 'number') ? closed.total : fs.closed.length;
    fs.error = '';
  } catch (e) { if (gen === fs.gen) fs.error = word('ui.load_list_failed'); }
  if (gen !== fs.gen) return;
  fs.loading = false; fs.loaded = true; schedule();
  refreshMyDay();
}


function setQuery(value) {
  fs.q = value;
  schedule();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refreshFieldLists, SEARCH_DEBOUNCE_MS);
}

function togglePill(key) {
  const next = new Set(fs.pills);
  if (next.has(key)) next.delete(key);
  else { next.add(key); if (EXCLUSIVE[key]) next.delete(EXCLUSIVE[key]); }
  fs.pills = next;
  schedule();
}

function clearFilters() {
  clearTimeout(searchTimer);
  const hadQuery = fs.q.trim() !== '';
  fs.q = ''; fs.pills = new Set();
  schedule();
  if (hadQuery) refreshFieldLists();
}

async function showMoreClosed() {
  if (fs.closedBusy) return;
  const gen = fs.gen;
  fs.closedBusy = true; schedule();
  try {
    const j = await fetchFieldCases('mine', { q: fs.q.trim(), state: 'closed', offset: fs.closed.length, limit: CLOSED_PAGE });
    if (gen === fs.gen) {
      const have = new Set(fs.closed.map((c) => c.id));
      fs.closed = fs.closed.concat(((j && j.cases) || []).filter((c) => !have.has(c.id)));
      if (j && typeof j.total === 'number') fs.closedTotal = j.total;
    }
  } catch (e) { toast(word('ui.field_more_failed'), 'err'); }
  fs.closedBusy = false; schedule();
}


function parseReport(raw) { try { return raw ? JSON.parse(raw) : {}; } catch { return {}; } }
const has = (r, k) => r[k] != null && String(r[k]).trim() !== '';
const mandatory = () => ((state.config || {}).mandatory_minimum || {}).fields || [];
const doneSet = () => new Set(['resolved', 'closed', ...((((state.config || {}).mandatory_minimum) || {}).blocks_transition_to || [])]);
const isOpen = (c) => !doneSet().has(c.status);
const missingOf = (c) => { const r = parseReport(c.report); return mandatory().filter((f) => !has(r, f.key)); };
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
const tagsOf = (c) => String(c.tags || '').split(',').map((t) => t.trim()).filter(Boolean);

function worstFirst(list) {
  const key = (c) => [tagsOf(c).includes('sent-back') ? 0 : 1, PRIORITY_RANK[c.priority] ?? 2, -missingOf(c).length, Date.parse(c.last_event_at) || 0];
  return [...list].sort((a, b) => { const x = key(a), y = key(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; });
}

function openReport(id) { pushHash({ caseId: id }); setActiveId(id); }
function openRef(ref) { const hit = [...fs.mine, ...fs.signoff, ...fs.closed].find((c) => c.ref === ref); if (hit) openReport(hit.id); }
function closeReport() { pushHash({ caseId: null }); setActiveId(null); resetFieldCase(); refreshFieldLists(); }

function holdState(c) {
  if (!isOpen(c)) return 'Closed';
  const holder = String(c.assignee || '').trim();
  return holder && holder !== 'agent' ? 'Claimed' : 'Open';
}

function handedNote(c) {
  if (!tagsOf(c).includes('handed-off')) return '';
  if (isTechnician()) { const from = holderName(c.assignee); return from ? 'Sent by ' + from : 'Sent by a ranger'; }
  return 'With the technician for sign-off';
}

function Row(c, { showMissing = true } = {}) {
  const r = parseReport(c.report);
  const missing = missingOf(c);
  const what = [has(r, 'species') ? String(r.species) : '', has(r, 'location') ? 'in ' + String(r.location) : ''].filter(Boolean).join(' ');
  const sentBack = tagsOf(c).includes('sent-back');
  const need = showMissing && mandatory().length ? (missing.length ? 'Still needed: ' + missing.map((f) => f.label).join(', ') : 'Everything needed is recorded') : '';
  return KitRow({
    key: c.id, title: what || headline(c.subject || 'No details yet'),
    sub: [c.ref, stageLabel(c.status) + (c.last_event_at ? ' -- ' + rel(c.last_event_at) : ''), has(r, 'photos') ? 'Photo attached' : 'No photo yet', sentBack ? 'Sent back to you -- open it to see what is needed' : '', handedNote(c), need].filter(Boolean).join('. '),
    meta: holdState(c),
    rail: sentBack ? 'flame' : (mandatory().length && !missing.length ? 'green' : undefined),
    onClick: () => openReport(c.id),
  });
}

function List(title, rows, empty, opts) {
  return Panel({ title, count: rows.length || undefined, children: rows.length ? rows.map((c) => Row(c, opts)) : h('p', { class: 'casey-hint' }, empty) });
}

async function addReport() {
  const subject = ((await confirmDialog({ title: 'New ' + entityLabel(), inputLabel: 'What is it about? (e.g. "sick cattle near Musina")' })) || '').trim();
  if (!subject) return;
  try {
    const created = await createCase({ subject });
    toast('Started ' + (created && created.ref ? created.ref : 'a new ' + entityLabel()) + '. It is assigned to you.', 'ok');
    await refreshFieldLists();
    if (created && created.id) openReport(created.id);
  } catch (e) { toast(await failMsg(e, 'The ' + entityLabel() + ' was not started. Nothing was saved -- try again.'), 'err'); }
}

function passesAttributes(c) {
  const on = (k) => fs.pills.has(k);
  if (on('sent-back') && !tagsOf(c).includes('sent-back')) return false;
  if (on('complete') && !(mandatory().length && !missingOf(c).length)) return false;
  if (on('incomplete') && !missingOf(c).length) return false;
  if (on('no-photo') && has(parseReport(c.report), 'photos')) return false;
  return true;
}

function passesHold(c) {
  const held = HOLD_PILLS.filter((k) => k !== 'closed' && fs.pills.has(k));
  if (!held.length && !fs.pills.has('closed')) return true;
  return fs.pills.has('open') || (fs.pills.has('claimed') && holdState(c) === 'Claimed');
}

function derive() {
  const tech = isTechnician();
  const closedOn = fs.pills.has('closed');
  const open = worstFirst(fs.mine.filter((c) => isOpen(c) && passesHold(c) && passesAttributes(c)));
  const closedSource = closedOn ? fs.closed : (tech ? fs.closed.slice(0, 10) : []);
  const closed = closedSource.filter(passesAttributes);
  let ready = [], rest = [];
  if (tech) {
    const ids = new Set();
    const signoff = fs.signoff.filter((c) => passesHold(c) && passesAttributes(c));
    ready = worstFirst([...signoff, ...open.filter((c) => !missingOf(c).length)].filter((c) => (ids.has(c.id) ? false : (ids.add(c.id), true))));
    rest = open.filter((c) => missingOf(c).length);
  }
  const shownIds = new Set([...(tech ? [...ready, ...rest] : open), ...closed].map((c) => c.id));
  const loadedIds = new Set([...fs.mine, ...(tech ? fs.signoff : []), ...closedSource].map((c) => c.id));
  return { tech, closedOn, open, closed, ready, rest, shown: shownIds.size, loaded: loadedIds.size, unloaded: Math.max(0, fs.mineTotal - fs.mine.length) };
}

const filtersActive = () => fs.q.trim() !== '' || fs.pills.size > 0;

function Filters(d) {
  const showing = d ? word('ui.field_showing', { shown: d.shown, loaded: d.loaded }) + (d.unloaded ? '. ' + word('ui.field_unloaded', { n: d.unloaded }) : '') : '';
  return h('div', { key: 'filters', class: 'field-filters', role: 'search', hidden: !d },
    h('div', { key: 'search', class: 'field-search' }, SearchInput({
      value: fs.q, label: word('ui.field_search_label'), placeholder: word('ui.field_search_placeholder'), onInput: setQuery,
    })),
    h('div', { key: 'pills', class: 'ds-filter-pills field-pills', role: 'group', 'aria-label': word('ui.field_filter_label') },
      ...[...HOLD_PILLS, ...ATTR_PILLS].map((k) => PillButton({ key: k, active: fs.pills.has(k), onClick: () => togglePill(k), children: word(PILL_WORD[k]) })),
      Btn({ key: 'clear', variant: 'link', size: 'sm', class: 'field-clear', disabled: !filtersActive(), children: word('ui.field_clear'), onClick: clearFilters })),
    h('p', { key: 'count', class: 'casey-hint field-count', role: 'status', 'aria-live': 'polite' }, showing));
}

function ClosedList(d) {
  const title = word('ui.field_closed_title');
  const more = d.closedOn && fs.closed.length < fs.closedTotal
    ? [QueueMore({ key: 'more', onClick: showMoreClosed, children: word('ui.field_show_more') })] : [];
  const rows = d.closed.map((c) => Row(c, { showMissing: false }));
  return Panel({ title, count: d.closed.length || undefined, children: [rows.length ? h('div', { key: 'rows' }, ...rows) : h('p', { key: 'empty', class: 'casey-hint' }, d.closedOn ? word('ui.field_closed_empty') : 'Nothing you handled has been closed yet.'), ...more] });
}

function Home(d) {
  if (!fs.loaded) { if (!fs.loading) refreshFieldLists(); return h('div', { key: 'home', class: 'field-home' }, Skeleton({ count: 5, height: '1.6em' })); }
  const body = [];
  if (fs.error) body.push(Alert({ kind: 'warn', children: fs.error }));
  if (d.tech) {
    body.push(List('Ready to sign off', d.ready, 'Nothing is waiting for sign-off right now.', { showMissing: false }));
    body.push(List('Your other ' + entityLabelPlural() + ', still being gathered', d.rest, 'You have no other open ' + entityLabelPlural() + '.'));
    body.push(ClosedList(d));
    body.push(MyDay({ onOpenRef: openRef, tech: true }));
    body.push(MyDay({ onOpenRef: openRef, tech: true, part: 'after' }));
  } else {
    body.push(MyDay({ onOpenRef: openRef }));
    body.push(List('My ' + entityLabelPlural(), d.open, 'No ' + entityLabel() + ' is assigned to you right now. When an operator gives you one it shows up here.'));
    if (d.closedOn) body.push(ClosedList(d));
    body.push(MyDay({ onOpenRef: openRef, part: 'after' }));
    if (d.open.length) body.push(Panel({ title: 'Where mine are', children: h('div', { class: 'field-map-small' }, MapPanel()) }));
  }
  return h('div', { key: 'home', class: 'field-home' }, ...body.filter(Boolean));
}


function MapView() {
  return h('div', { key: 'map', class: 'field-map-full' }, MapPanel());
}

function nav() {
  const tech = isTechnician();
  const go = (v) => (e) => { if (e && e.preventDefault) e.preventDefault(); if (state.activeId) closeReport(); fs.view = v; schedule(); };
  const home = tech ? 'Ready to sign off' : 'My ' + entityLabelPlural();
  return Side({
    sections: [{
      group: 'Your work',
      items: [
        { key: 'home', glyph: Icon(tech ? 'check' : 'rows', { size: 15 }), label: home, onClick: go('home'), active: fs.view === 'home' && !state.activeId },
        { key: 'map', glyph: Icon('globe', { size: 15 }), label: 'Map', onClick: go('map'), active: fs.view === 'map' && !state.activeId },
      ],
    }],
  });
}

function FieldHelp() {
  const tech = isTechnician();
  return Dialog({
    open: state.activeModal === 'help', title: 'How this screen works', onClose: closeModal,
    children: [
      h('p', { key: 'a' }, 'You only see the ' + entityLabelPlural() + ' that were given to you' + (tech ? ', plus the ones that are complete and waiting for someone to sign them off.' : '.')),
      h('p', { key: 'b' }, 'Open one to see what is still needed, message the person who reported it on WhatsApp, and record what they tell you. Before anything is saved, the screen shows you the reference so you never write to the wrong one.'),
      tech ? h('p', { key: 'c' }, 'Sign off only when help has been given and everything needed is recorded. If something is missing, use Send back to ranger and say what.') : null,
      h('p', { key: 'd' }, 'If a ' + entityLabel() + ' you expect is not here, ask an operator to give it to you.'),
    ].filter(Boolean),
  });
}

export function FieldApp() {
  const brand = brandName();
  const tech = isTechnician();
  const open = state.activeId != null;
  const derived = open || fs.view !== 'home' ? null : derive();
  const title = open ? 'One ' + entityLabel() : (fs.view === 'map' ? 'Map' : (tech ? 'Ready to sign off' : 'My ' + entityLabelPlural()));
  const main = open
    ? FieldCaseView({ id: state.activeId, onBack: closeReport })
    : h('div', { class: 'field-main' },
      ViewTitle(title),
      h('div', { class: 'casey-timeline-actions' },
        Btn({ variant: 'primary', children: [Icon('plus', { size: 15 }), ' New ' + entityLabel()], onClick: addReport, 'aria-label': 'Start a new ' + entityLabel() }),
        Btn({ variant: 'ghost', children: 'Refresh', onClick: refreshFieldLists })),
      Filters(fs.view === 'home' && fs.loaded ? derived : null),
      fs.view === 'map' ? MapView() : Home(derived));
  const crumb = Crumb({ trail: [brand], leaf: roleName(), right: [h('div', { key: 'appbar', class: 'ds-appbar' }, AccountMenu())] });
  return h('div', { class: 'ds-app-root field-app' },
    ConnectionBanner(),
    AppShell({
      topbar: Topbar({ brand, leaf: roleName(), items: [], themeToggle: false }), crumb, side: nav(),
      status: Status({ left: [h('span', { key: 'c' }, 'You have ' + countOf(fs.openTotal))], right: [h('span', { key: 'n' }, state.connLost ? 'Not connected -- showing the last data received' : 'Connected')], ariaLabel: 'Status bar' }),
      main: [main], bannerLabel: 'Top bar', mainLabelledby: VIEW_TITLE_ID,
    }),
    FieldHelp(),
    FeedbackDialog(),
    LogoutEverywhereConfirmDialog(),
    ToastTray());
}
