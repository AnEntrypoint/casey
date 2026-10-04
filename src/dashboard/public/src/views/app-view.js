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
const h = webjsx.createElement;

const modalBodies = {};
export function registerModalBody(name, renderFn) { modalBodies[name] = renderFn; }
function modalTitle(name) {
  return { settings: 'Settings', stats: 'Stats', help: 'How this screen works', onboarding: 'Your first shift', skills: 'Ways to work faster' }[name] || name;
}
const WIDE_MODALS = new Set(['settings', 'stats']);
const SELF_WRAPPED_MODALS = new Set(['help', 'onboarding', 'skills']);
function ModalMount() {
  const name = state.activeModal;
  if (!name || name === 'confirm-logout-everywhere' || name === 'feedback') return null;
  const body = modalBodies[name] ? modalBodies[name]() : h('p', {}, 'Loading...');
  if (SELF_WRAPPED_MODALS.has(name)) return body;
  return Dialog({ open: true, title: modalTitle(name), onClose: closeModal, children: body, wide: WIDE_MODALS.has(name) });
}

const panelBodies = {};
export function registerPanelBody(name, renderFn) { panelBodies[name] = renderFn; }
function panelPageTitle(name) { return panelTitle(name) || 'Screen not available'; }
function PanelSwap() {
  const name = state.activePanel;
  const known = !!panelBodies[name];
  const body = known
    ? panelBodies[name]()
    : h('p', {}, 'This screen is not available in this deployment.');
  const backLabel = state.homeView === 'cases' ? 'Back to ' + EntityLabelPlural().toLowerCase() : 'Back to the map';
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
  const label = n === 0 ? 'Nothing needs a person' : (n + (n === 1 ? ' needs a person' : ' need a person'));
  return h('button', {
    type: 'button',
    class: 'ds-attn-lead' + (n ? ' is-waiting' : ''),
    title: 'Open the "' + queueName() + '" list',
    'aria-label': label + ', open the ' + queueName() + ' list',
    onclick: openQueue,
  },
    h('span', { key: 'g', class: 'ds-action-glyph', 'aria-hidden': 'true' }, Icon('activity', { size: 15 })),
    h('span', { key: 'l', class: 'ds-action-label' }, label));
}

function StatusBar() {
  const total = state.allCasesTotal || (state.allCases || []).length;
  const hl = state.health.ai;
  const gw = hl && hl.gateway;
  const left = [h('span', { key: 'c' }, `${countOf(total)} loaded`)];
  const right = [
    hl && hl.source === 'unwired'
      ? h('span', { key: 'mode' }, 'Replies are not sent from this screen')
      : (gw && gw.ok ? h('span', { key: 'rx' }, 'Receiving reports') : null),
    h('span', { key: 'conn' }, state.connLost ? 'Not connected -- showing the last data received' : 'Connected'),
  ].filter(Boolean);
  return Status({ left, right, ariaLabel: 'Status bar' });
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
      Btn({ variant: 'ghost', title: 'What does this screen mean?', 'aria-label': 'Help: what does this screen mean?', onClick: () => openModal('help'),
        children: [h('span', { key: 'g', class: 'ds-action-glyph', 'aria-hidden': 'true' }, Icon('help')), h('span', { key: 'l', class: 'ds-action-label' }, 'Help')] })),
    AccountMenu(),
    h('span', { key: 'more', class: 'ds-appbar-more' },
      Btn({ variant: 'ghost', 'aria-expanded': state._appbarMore ? 'true' : 'false', title: 'Show or hide the other buttons',
        'aria-label': state._appbarMore ? 'Fewer buttons' : 'More buttons', onClick: () => { state._appbarMore = !state._appbarMore; schedule(); },
        children: [h('span', { key: 'g', class: 'ds-action-glyph', 'aria-hidden': 'true' }, Icon('chevron-down')), h('span', { key: 'l', class: 'ds-action-label' }, state._appbarMore ? 'Fewer' : 'More')] })),
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
    AppShell({ topbar, crumb, side, status, main: [MainContent()], bannerLabel: 'Top bar', mainLabelledby: VIEW_TITLE_ID }),
    ModalMount(),
    FeedbackDialog(),
    LogoutEverywhereConfirmDialog(),
    ToastTray()
  );
}
