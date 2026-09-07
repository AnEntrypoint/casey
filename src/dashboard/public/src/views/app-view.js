// Root App() view: login gate -> AppShell({topbar, side, main, status})
// composition. Wires Topbar search, Side sections, main content router, and
// the modal-mount slot (Settings/Stats/Help/Onboarding/Skills overlays
// render here). Other agents' case-list/case-detail views attach into the
// #view-root placeholder mounted in main until they land.

import * as webjsx from 'webjsx';
import { AppShell, Topbar, Side, Status, Crumb, Icon, IconButton, Btn } from 'ds/components/shell.js';
import { state, setFilt, closeModal, openModal } from '../state.js';
import { buildSideSections, buildActionItems, backToCases } from './nav-config.js';
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
import { MapCommandCenter } from './map-command-center.js';
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
// Content-heavy dialogs (a wide data table, a multi-section form) need the
// Dialog's wide variant -- see dialog-shell.js's own Dialog({wide}) doc,
// which already named settings/stats as the intended cases; this registry
// was the only thing not actually passing it.
const WIDE_MODALS = new Set(['settings', 'stats']);
// help/onboarding/skills each call Dialog(...) themselves (their own title/
// footer/id needs), unlike settings/stats which return plain content meant
// to be wrapped once here -- wrapping an already-self-wrapped body in a
// second outer Dialog produced two stacked backdrops+panels (confirmed live:
// opening onboarding rendered both a "Quick start" and a nested "Quick start
// - three things" dialog on top of each other).
const SELF_WRAPPED_MODALS = new Set(['help', 'onboarding', 'skills']);
function ModalMount() {
  const name = state.activeModal;
  if (!name || name === 'confirm-logout-everywhere') return null;
  const body = modalBodies[name] ? modalBodies[name]() : h('p', {}, 'Loading...');
  if (SELF_WRAPPED_MODALS.has(name)) return body;
  return Dialog({ open: true, title: modalTitle(name), onClose: closeModal, children: body, wide: WIDE_MODALS.has(name) });
}

// Content-swap panel registry (Metrics/Clusters/Distribution/Geo/Map/
// Activity/Handover/Offline/Team/Contacts) -- other builders register their
// panel render fn here; unregistered panels degrade to a "not available yet"
// placeholder with a back-to-cases affordance rather than a dead click.
const panelBodies = {};
export function registerPanelBody(name, renderFn) { panelBodies[name] = renderFn; }
// One treatment for every content-swap panel, so none of them inherits a
// placeholder shell. The back control carries a real word rather than a bare
// chevron whose only text was a tooltip -- map-command-center.js already
// rejected a bare glyph for exactly this audience ("a worded back control, not
// a bare glyph"), and this is the same operator on the same screen.
//
// The not-available fallback keeps that control too. It previously rendered a
// lone sentence with no way back, so an unregistered panel was a dead end an
// operator could only escape by reloading the page.
function PanelSwap() {
  const name = state.activePanel;
  const known = !!panelBodies[name];
  const body = known
    ? panelBodies[name]()
    : h('p', {}, 'This screen is not available in this deployment.');
  const backLabel = state.homeView === 'cases' ? 'Back to cases' : 'Back to the map';
  return h('div', { class: 'ds-panel-swap' },
    h('div', { class: 'ds-panel-swap-head' },
      Btn({ variant: 'ghost', children: backLabel, onClick: backToCases })),
    h('div', { class: 'ds-panel-swap-body' }, body)
  );
}

// The five verbs that used to occupy the top of the destination nav. `focus`
// is a toggle, `new_case` is the one primary action, and the rest are rare
// enough to sit quietly at the end of the row rather than above the map.
function ActionRow() {
  const items = buildActionItems({});
  if (!items.length) return null;
  return h('div', { class: 'ds-action-row' }, ...items.map((it) => {
    if (it.href) {
      // A real anchor, not a JS click -- Export has to actually download.
      return h('a', { key: it.key, class: 'ds-action-link', href: it.href, title: it.ariaLabel || it.label }, it.label);
    }
    // Anything that is neither the primary action nor a mode toggle is desk
    // work (Sweep now, Refresh) and gives way first on a narrow screen -- see
    // the .ds-action-rare rule in app.css.
    const rare = !it.primary && it.active === undefined;
    return h('span', { key: it.key, class: rare ? 'ds-action-rare' : 'ds-action-common' },
      Btn({
        variant: it.primary ? 'primary' : 'ghost',
        children: it.label,
        onClick: it.onClick,
        title: it.ariaLabel || it.label,
        'aria-pressed': it.active === undefined ? undefined : (it.active ? 'true' : 'false'),
      }));
  }));
}

// The status bar used to render as chrome around nothing (Status({left:[],
// right:[]})). In an operational console this is where "can I trust what I am
// looking at" belongs, so it carries the two facts that answer it: how much is
// loaded, and whether the connection is still live.
function StatusBar() {
  const total = state.allCasesTotal || (state.allCases || []).length;
  const attn = (state.attention || []).length;
  const left = [
    h('span', { key: 'c' }, `${total} report(s) loaded`),
    attn ? h('span', { key: 'a' }, `${attn} need a person`) : null,
  ].filter(Boolean);
  const right = [
    h('span', { key: 'conn' }, state.connLost ? 'Not connected -- showing the last data received' : 'Connected'),
  ];
  return Status({ left, right });
}

function MainContent() {
  if (state.activePanel) return PanelSwap();
  if (state.homeView === 'cases') return CaseListDetailLayout();
  return MapCommandCenter();
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
    ActionRow(),
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
  const status = StatusBar();

  // is-map-home marks the one view whose whole point is the size of the map,
  // so the CSS can buy the map its width back from the chrome around it (see
  // app.css). Measured at 1440x900 before this: the map held 49% of the width
  // against the ~78% the operational consoles this layout is modelled on give
  // it, and the difference was entirely nav width plus main-region padding.
  const mapHome = state.homeView === 'map' && !state.activePanel;
  return h('div', { class: 'ds-app-root' + (mapHome ? ' is-map-home' : '') },
    ConnectionBanner(),
    HandoffBanner(),
    AppShell({ topbar, crumb, side, status, main: [MainContent()] }),
    ModalMount(),
    LogoutEverywhereConfirmDialog(),
    ToastTray()
  );
}
