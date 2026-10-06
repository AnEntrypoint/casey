import * as webjsx from '/design/vendor/webjsx/index.js';
import { AppShell, Topbar, Side, Crumb, Status, Icon, Btn } from '/design/src/components/shell.js';
import { Skeleton, Alert, Panel, Row as KitRow } from '/design/src/components/content.js';
import { state, schedule, closeModal } from '../state.js';
import { AccountMenu, LogoutEverywhereConfirmDialog } from '../components/account-menu.js';
import { ConnectionBanner } from '../components/connection-banner.js';
import { FeedbackDialog } from '../components/feedback-dialog.js';
import { ToastTray } from '../components/toast-tray.js';
import { Dialog, confirmDialog } from '../components/dialog-shell.js';
import { MapPanel } from '../panels/map-panel.js';
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

const fs = { view: 'home', mine: [], signoff: [], mineTotal: 0, loaded: false, loading: false, error: '' };

export async function refreshFieldLists() {
  if (fs.loading) return;
  fs.loading = true;
  try {
    const [mine, signoff] = await Promise.all([
      fetchFieldCases('mine'),
      isTechnician() ? fetchFieldCases('signoff') : Promise.resolve({ cases: [] }),
    ]);
    fs.mine = (mine && mine.cases) || [];
    fs.mineTotal = (mine && typeof mine.total === 'number') ? mine.total : fs.mine.length;
    fs.signoff = (signoff && signoff.cases) || [];
    fs.error = '';
  } catch (e) { fs.error = word('ui.load_list_failed'); }
  fs.loading = false; fs.loaded = true; schedule();
  refreshMyDay();
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
function openRef(ref) { const hit = [...fs.mine, ...fs.signoff].find((c) => c.ref === ref); if (hit) openReport(hit.id); }
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
    sub: [c.ref, stageLabel(c.status) + (c.last_event_at ? ' -- ' + rel(c.last_event_at) : ''), sentBack ? 'Sent back to you -- open it to see what is needed' : '', handedNote(c), need].filter(Boolean).join('. '),
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

function Home() {
  if (!fs.loaded) { refreshFieldLists(); return Skeleton({ count: 5, height: '1.6em' }); }
  const tech = isTechnician();
  const open = worstFirst(fs.mine.filter(isOpen));
  const closed = fs.mine.filter((c) => !isOpen(c)).sort((a, b) => (Date.parse(b.last_event_at) || 0) - (Date.parse(a.last_event_at) || 0)).slice(0, 10);
  const body = [];
  if (fs.error) body.push(Alert({ kind: 'warn', children: fs.error }));
  if (fs.mineTotal > fs.mine.length) body.push(Alert({ kind: 'info', children: 'Showing the ' + fs.mine.length + ' most recently active of your ' + fs.mineTotal + ' ' + entityLabelPlural() + '. Ask an operator to hand some on if this is too many.' }));
  if (tech) {
    const ids = new Set();
    const ready = [...fs.signoff, ...open.filter((c) => !missingOf(c).length)].filter((c) => (ids.has(c.id) ? false : (ids.add(c.id), true)));
    const rest = open.filter((c) => missingOf(c).length);
    body.push(List('Ready to sign off', worstFirst(ready), 'Nothing is waiting for sign-off right now.', { showMissing: false }));
    body.push(List('Your other ' + entityLabelPlural() + ', still being gathered', rest, 'You have no other open ' + entityLabelPlural() + '.'));
    body.push(List('Recently closed', closed, 'Nothing you handled has been closed yet.', { showMissing: false }));
    body.push(MyDay({ onOpenRef: openRef, tech: true }));
    body.push(MyDay({ onOpenRef: openRef, tech: true, part: 'after' }));
  } else {
    body.push(MyDay({ onOpenRef: openRef }));
    body.push(List('My ' + entityLabelPlural(), open, 'No ' + entityLabel() + ' is assigned to you right now. When an operator gives you one it shows up here.'));
    body.push(MyDay({ onOpenRef: openRef, part: 'after' }));
    if (open.length) body.push(Panel({ title: 'Where mine are', children: h('div', { class: 'field-map-small' }, MapPanel()) }));
  }
  return h('div', { class: 'field-home' }, ...body.filter(Boolean));
}

function MapView() {
  return h('div', { class: 'field-map-full' }, MapPanel());
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
  const title = open ? 'One ' + entityLabel() : (fs.view === 'map' ? 'Map' : (tech ? 'Ready to sign off' : 'My ' + entityLabelPlural()));
  const main = open
    ? FieldCaseView({ id: state.activeId, onBack: closeReport })
    : h('div', { class: 'field-main' },
      ViewTitle(title),
      h('div', { class: 'casey-timeline-actions' },
        Btn({ variant: 'primary', children: [Icon('plus', { size: 15 }), ' New ' + entityLabel()], onClick: addReport, 'aria-label': 'Start a new ' + entityLabel() }),
        Btn({ variant: 'ghost', children: 'Refresh', onClick: refreshFieldLists })),
      fs.view === 'map' ? MapView() : Home());
  const crumb = Crumb({ trail: [brand], leaf: roleName(), right: [h('div', { key: 'appbar', class: 'ds-appbar' }, AccountMenu())] });
  return h('div', { class: 'ds-app-root field-app' },
    ConnectionBanner(),
    AppShell({
      topbar: Topbar({ brand, leaf: roleName(), items: [], themeToggle: false }), crumb, side: nav(),
      status: Status({ left: [h('span', { key: 'c' }, 'You have ' + countOf(fs.mine.length))], right: [h('span', { key: 'n' }, state.connLost ? 'Not connected -- showing the last data received' : 'Connected')], ariaLabel: 'Status bar' }),
      main: [main], bannerLabel: 'Top bar', mainLabelledby: VIEW_TITLE_ID,
    }),
    FieldHelp(),
    FeedbackDialog(),
    LogoutEverywhereConfirmDialog(),
    ToastTray());
}
