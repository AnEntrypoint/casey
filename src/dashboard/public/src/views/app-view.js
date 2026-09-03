// Root App() view: login gate -> AppShell({topbar, side, main, status})
// composition. Wires Topbar search, Side sections, main content router, and
// the modal-mount slot (Settings/Stats/Help/Onboarding/Skills overlays
// render here). Other agents' case-list/case-detail views attach into the
// #view-root placeholder mounted in main until they land.

import * as webjsx from 'webjsx';
import { AppShell, Topbar, Side, Status, Crumb, Icon, IconButton } from 'ds/components/shell.js';
import { state, setFilt, closeModal, openModal } from '../state.js';
import { buildSideSections, backToCases } from './nav-config.js';
import { HealthPills } from '../components/health-pills.js';
import { AccountMenu, LogoutEverywhereConfirmDialog } from '../components/account-menu.js';
import { NotificationsCenter } from '../components/notifications-center.js';
import { QuickStartBadge } from '../components/quick-start-badge.js';
import { HandoffBanner } from '../components/handoff-banner.js';
import { ConnectionBanner } from '../components/connection-banner.js';
import { ToastTray } from '../components/toast-tray.js';
import { LoginGate } from './login-gate.js';
import { Dialog } from '../components/dialog-shell.js';
import { CaseListDetailLayout } from './case-list-detail-layout.js';
const h = webjsx.createElement;

// The single modal-rendering code path: every activeModal value maps to a
// PanelComponent -> Dialog wrap here. Panel bodies (settings/stats/help/etc)
// are owned by other builders' modules; this shell renders the shared
// Dialog chrome and a placeholder body until those land, via a registry other
// agents populate with registerModalBody().
const modalBodies = {};
export function registerModalBody(name, renderFn) { modalBodies[name] = renderFn; }
function modalTitle(name) {
  return { settings: 'Settings', stats: 'Stats', help: 'Help', onboarding: 'Quick start', skills: 'Getting the hang of it' }[name] || name;
}
function ModalMount() {
  const name = state.activeModal;
  if (!name || name === 'confirm-logout-everywhere') return null;
  const body = modalBodies[name] ? modalBodies[name]() : h('p', {}, 'Loading...');
  return Dialog({ open: true, title: modalTitle(name), onClose: closeModal, children: body });
}

// Content-swap panel registry (Metrics/Clusters/Distribution/Geo/Map/
// Activity/Handover/Offline/Team/Contacts) -- other builders register their
// panel render fn here; unregistered panels degrade to a "not available yet"
// placeholder with a back-to-cases affordance rather than a dead click.
const panelBodies = {};
export function registerPanelBody(name, renderFn) { panelBodies[name] = renderFn; }
function PanelSwap() {
  const name = state.activePanel;
  const body = panelBodies[name] ? panelBodies[name]() : h('p', {}, 'This panel is not available yet.');
  return h('div', { class: 'ds-panel-swap' },
    IconButton({ icon: Icon('chevron-left'), title: 'Back to cases', onClick: backToCases }),
    h('div', { class: 'ds-panel-swap-body' }, body)
  );
}

function MainContent() {
  if (state.activePanel) return PanelSwap();
  return CaseListDetailLayout();
}

export function App() {
  if (!state.authed) return LoginGate();

  // brand/leaf are config-driven (dashboard_ui.brand/dashboard_ui.leaf, see
  // report-shape.js's DASHBOARD_UI, threaded through /api/config) so a
  // deployer whose domain isn't "casey"/"Cases" (e.g. serpent's research
  // runs) can rebrand the app shell without a fork. Absent (casey's own
  // default, uhh) -- falls back to today's exact literals.
  const brand = state.config?.dashboard_ui?.brand || 'casey';
  const leaf = state.config?.dashboard_ui?.leaf || 'Cases';

  const side = Side({ sections: buildSideSections({}) });
  const topbar = Topbar({
    brand, leaf,
    items: [], themeToggle: false,
  });
  const crumbRight = [
    QuickStartBadge(),
    h('div', { class: 'ds-health-pill-group' }, HealthPills()),
    NotificationsCenter(),
    IconButton({ icon: Icon('help'), title: 'What does this screen mean?', onClick: () => openModal('help') }),
    AccountMenu(),
  ].filter(Boolean);
  // trail:[brand] gives the merged topbar+crumb chrome its left identity --
  // the design system hides the topbar's own standalone .brand in merged
  // mode on the assumption the crumb already carries it (app-shell/topbar.css);
  // omitting it here left the titlebar with no brand at all.
  const crumb = Crumb({ trail: [brand], leaf, right: crumbRight });
  const status = Status({ left: [], right: [] });

  return h('div', { class: 'ds-app-root' },
    ConnectionBanner(),
    HandoffBanner(),
    AppShell({ topbar, crumb, side, status, main: [MainContent()] }),
    ModalMount(),
    LogoutEverywhereConfirmDialog(),
    ToastTray()
  );
}
