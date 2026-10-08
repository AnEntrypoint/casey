import * as webjsx from 'webjsx';
import { AppShell, Topbar, Side, Status, Crumb, Icon, Btn } from 'ds/components/shell.js';
import { state, schedule, closeModal, openModal } from '../state.js';
import { buildSideSections, buildActionItems, backToCases, panelTitle, openQueue } from './nav-config.js';
import { HealthNotices } from '../components/health-notices.js';
import { queueName } from '../map-model.js';
import { AccountMenu, LogoutEverywhereConfirmDialog } from '../components/account-menu.js';
import { NotificationsCenter } from '../components/notifications-center.js';
import { HandoffBanner } from '../components/handoff-banner.js';
import { ConnectionBanner } from '../components/connection-banner.js';
import { ToastTray } from '../components/toast-tray.js';
import { LoginGate } from './login-gate.js';
import { FieldApp } from './field-app.js';
import { ViewerApp } from './viewer-app.js';
import { FeedbackDialog } from '../components/feedback-dialog.js';
import { isFieldRole, isViewerRole } from '../api-roles.js';
import { Dialog } from '../components/dialog-shell.js';
import { CaseListDetailLayout } from './case-list-detail-layout.js';
import { MapCommandCenter } from './map-command-center.js';
import { ViewTitle, VIEW_TITLE_ID } from './view-title.js';
import { brandName, EntityLabelPlural, countOf } from '../vocabulary.js';
import { word } from '../words.js';
const h = webjsx.createElement;

const modalBodies = {};
export function registerModalBody(name, renderFn) { modalBodies[name] = renderFn; }
const MODAL_TITLE_KEY = { settings: 'ui.app_view_settings', stats: 'ui.app_view_stats', help: 'ui.app_view_help_screen', onboarding: 'ui.app_view_onboarding', skills: 'ui.app_view_skills' };
function modalTitle(name) {
  return MODAL_TITLE_KEY[name] ? word(MODAL_TITLE_KEY[name]) : name;
}
const WIDE_MODALS = new Set(['settings', 'stats']);
const SELF_WRAPPED_MODALS = new Set(['help', 'onboarding', 'skills']);
function ModalMount() {
  const name = state.activeModal;
  if (!name || name === 'confirm-logout-everywhere' || name === 'feedback') return null;
  const body = modalBodies[name] ? modalBodies[name]() : h('p', {}, word('ui.app_view_unavailable'));
  if (SELF_WRAPPED_MODALS.has(name)) return body;
  return Dialog({ open: true, title: modalTitle(name), onClose: closeModal, children: body, wide: WIDE_MODALS.has(name) });
}

const panelBodies = {};
export function registerPanelBody(name, renderFn) { panelBodies[name] = renderFn; }
function panelPageTitle(name) { return panelTitle(name) || word('ui.app_view_screen_unavailable'); }
function PanelSwap() {
  const name = state.activePanel;
  const known = !!panelBodies[name];
  const body = known
    ? panelBodies[name]()
    : h('p', {}, word('ui.app_view_unavailable'));
  const backLabel = state.homeView === 'cases' ? word('ui.app_view_back_cases', { entity_plural: EntityLabelPlural().toLowerCase() }) : word('ui.app_view_back_map');
  return h('div', { class: 'ds-panel-swap' },
    h('div', { class: 'ds-panel-swap-head' },
      Btn({ variant: 'ghost', children: backLabel, onClick: backToCases }),
      ViewTitle(panelPageTitle(name), 'ds-panel-swap-title')),
    h('div', { class: 'ds-panel-swap-body' }, body)
  );
}

function ActionRow() {
  const items = buildActionItems({});
  if (!items.length) return null;
  const face = (it) => [
    h('span', { key: 'g', class: 'ds-action-glyph', 'aria-hidden': 'true' }, it.glyph),
    h('span', { key: 'l', class: 'ds-action-label' }, it.label),
  ];
  return h('div', { class: 'ds-btn-row ds-action-row' }, ...items.map((it) => {
    if (it.href) {
      return h('span', { key: it.key, class: 'ds-action-rare ds-appbar-overflow' },
        Btn({
          variant: 'ghost', href: it.href, children: face(it),
          title: it.ariaLabel || it.label, 'aria-label': it.ariaLabel || it.label,
        }));
    }
    const rare = !it.primary && it.active === undefined;
    return h('span', { key: it.key, class: (rare ? 'ds-action-rare' : 'ds-action-common') + (it.primary ? '' : ' ds-appbar-overflow') },
      Btn({
        variant: it.primary ? 'primary' : 'ghost',
        children: face(it),
        onClick: it.onClick,
        title: it.ariaLabel || it.label,
        'aria-label': it.ariaLabel || it.label,
        'aria-pressed': it.active === undefined ? undefined : (it.active ? 'true' : 'false'),
      }));
  }));
}

function AttentionLead() {
  const n = (state.attention || []).length;
  const label = n === 0 ? word('ui.app_view_nothing_needs') : word(n === 1 ? 'ui.app_view_one_needs' : 'ui.app_view_many_need', { n });
  return h('button', {
    type: 'button',
    class: 'ds-attn-lead' + (n ? ' is-waiting' : ''),
    title: word('ui.app_view_open_queue_title', { queue: queueName() }),
    'aria-label': word('ui.app_view_open_queue_aria', { label, queue: queueName() }),
    onclick: openQueue,
  },
    h('span', { key: 'g', class: 'ds-action-glyph', 'aria-hidden': 'true' }, Icon('activity', { size: 15 })),
    h('span', { key: 'l', class: 'ds-action-label' }, label));
}

function StatusBar() {
  const total = state.allCasesTotal || (state.allCases || []).length;
  const hl = state.health.ai;
  const gw = hl && hl.gateway;
  const left = [h('span', { key: 'c' }, word('ui.app_view_loaded', { count: countOf(total) }))];
  const right = [
    hl && hl.source === 'unwired'
      ? h('span', { key: 'mode' }, word('ui.app_view_replies_not_sent'))
      : (gw && gw.ok ? h('span', { key: 'rx' }, word('ui.app_view_receiving')) : null),
    h('span', { key: 'conn' }, state.connLost ? word('ui.app_view_not_connected') : word('ui.app_view_connected')),
  ].filter(Boolean);
  return Status({ left, right, ariaLabel: word('ui.app_view_status_aria') });
}

function MainContent() {
  if (state.activePanel) return PanelSwap();
  if (state.homeView === 'cases') return CaseListDetailLayout();
  return MapCommandCenter();
}

export function App() {
  if (!state.authed) return h('div', { class: 'ds-app-root is-gated' }, ConnectionBanner(), LoginGate());

  if (isViewerRole()) return ViewerApp();
  if (isFieldRole()) return FieldApp();

  const brand = brandName();
  const leaf = state.config?.dashboard_ui?.leaf || EntityLabelPlural();

  const side = Side({ sections: buildSideSections({}) });
  const topbar = Topbar({
    brand, leaf,
    items: [], themeToggle: false,
  });
  const crumbRight = [
    AttentionLead(),
    ActionRow(),
    NotificationsCenter(),
    h('span', { key: 'help', class: 'ds-action-common ds-appbar-overflow' },
      Btn({ variant: 'ghost', title: word('ui.app_view_help_hint'), 'aria-label': word('ui.app_view_help_aria'), onClick: () => openModal('help'),
        children: [h('span', { key: 'g', class: 'ds-action-glyph', 'aria-hidden': 'true' }, Icon('help')), h('span', { key: 'l', class: 'ds-action-label' }, word('ui.app_view_help'))] })),
    AccountMenu(),
    h('span', { key: 'more', class: 'ds-appbar-more' },
      Btn({ variant: 'ghost', 'aria-expanded': state._appbarMore ? 'true' : 'false', title: word('ui.app_view_more_title'),
        'aria-label': state._appbarMore ? word('ui.app_view_fewer_buttons') : word('ui.app_view_more_buttons'), onClick: () => { state._appbarMore = !state._appbarMore; schedule(); },
        children: [h('span', { key: 'g', class: 'ds-action-glyph', 'aria-hidden': 'true' }, Icon('chevron-down')), h('span', { key: 'l', class: 'ds-action-label' }, state._appbarMore ? word('ui.app_view_fewer') : word('ui.app_view_more'))] })),
  ].filter(Boolean);
  const crumb = Crumb({
    trail: [brand],
    leaf: state.activePanel ? panelPageTitle(state.activePanel) : leaf,
    right: [h('div', { key: 'appbar', class: 'ds-appbar' + (state._appbarMore ? ' is-more-open' : '') }, ...crumbRight)],
  });
  const status = StatusBar();

  const mapHome = state.homeView === 'map' && !state.activePanel;
  return h('div', { class: 'ds-app-root' + (mapHome ? ' is-map-home' : '') },
    ConnectionBanner(),
    ...HealthNotices(),
    HandoffBanner(),
    AppShell({ topbar, crumb, side, status, main: [MainContent()], bannerLabel: word('ui.app_view_top_bar'), mainLabelledby: VIEW_TITLE_ID }),
    ModalMount(),
    FeedbackDialog(),
    LogoutEverywhereConfirmDialog(),
    ToastTray()
  );
}
