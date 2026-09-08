// Root App() view: login gate -> AppShell({topbar, crumb, side, main, status})
// composition. Owns the frame -- the attention lead, the health pills, the
// action row, the account menu, the status bar -- plus the two mounts that
// swap what is under it: MainContent (a home view or a content-swap panel) and
// ModalMount (Settings/Stats/Help/Onboarding/Skills).

import * as webjsx from 'webjsx';
import { AppShell, Topbar, Side, Status, Crumb, Icon, IconButton, Btn } from 'ds/components/shell.js';
import { state, closeModal, openModal } from '../state.js';
import { buildSideSections, buildActionItems, backToCases, panelTitle, openQueue } from './nav-config.js';
import { HealthNotices } from '../components/health-notices.js';
import { QUEUE_NAME } from '../map-model.js';
import { AccountMenu, LogoutEverywhereConfirmDialog } from '../components/account-menu.js';
import { NotificationsCenter } from '../components/notifications-center.js';
import { HandoffBanner } from '../components/handoff-banner.js';
import { ConnectionBanner } from '../components/connection-banner.js';
import { ToastTray } from '../components/toast-tray.js';
import { LoginGate } from './login-gate.js';
import { Dialog } from '../components/dialog-shell.js';
import { CaseListDetailLayout } from './case-list-detail-layout.js';
import { MapCommandCenter } from './map-command-center.js';
const h = webjsx.createElement;

// The single modal-rendering code path: every activeModal value maps to a
// body -> Dialog wrap here. main.js registers all five at boot; the registry
// exists so this module does not import them and close an import cycle
// through main.js.
const modalBodies = {};
export function registerModalBody(name, renderFn) { modalBodies[name] = renderFn; }
function modalTitle(name) {
  return { settings: 'Settings', stats: 'Stats', help: 'How this screen works', onboarding: 'Your first shift', skills: 'Ways to work faster' }[name] || name;
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

// Content-swap panel registry, populated by main.js at boot. There is no
// 'map' entry and there must not be one: the map is a HOME VIEW
// (state.homeView), and the last time it was also a panel, dashboard_ui's
// default_view called openPanel('map') and landed every map-first deployment
// on the legacy stacked page instead of the command centre. A name with no
// body registered still renders a titled page with a way back, never a dead
// click.
const panelBodies = {};
export function registerPanelBody(name, renderFn) { panelBodies[name] = renderFn; }
// ONE treatment for every content-swap panel: a full-swap page with real
// chrome -- a named heading and a worded way back -- never an overlay sheet
// over a retained map, and never a bare body inheriting a placeholder shell.
//
// Why full-swap rather than a sheet over the map: all seven of these are
// NON-SPATIAL working surfaces (metrics, distribution, activity, handover,
// offline, team, contacts, secretary), so a map behind them answers nothing
// they ask, while a sheet floating over live pins is precisely the thing
// mapuipatterns bars in situational-awareness domains -- covering potentially
// important data with a floating panel. At 390px a sheet covers the map
// completely anyway, so the "retained" map is fiction on the screen where the
// audience actually works. The two panels that ARE spatial answers (geo,
// clusters) never come through here on the map side at all: they render in the
// rail with the map still mounted (state.railMode).
//
// The head is one row for every panel with no per-panel branch: the escape
// first, the page's own name second. The back control carries a real word,
// never a bare chevron whose only text is a tooltip -- map-command-center.js
// rejected exactly that for exactly this audience ("a worded back control, not
// a bare glyph"). The name comes from nav-config's panelTitle(), i.e. from the
// nav item the operator clicked, so the page is never titled something the
// control that opened it does not say.
//
// The not-available fallback gets the identical head. It previously rendered a
// lone sentence with no way back, so an unregistered panel was a dead end an
// operator could only escape by reloading the page.
//
// THE CONTRACT FOR A REGISTERED PANEL: render the BODY only. Do not give a
// panel its own page title or its own back control -- this head is both, for
// all of them. Every one of the seven used to carry a private copy
// (`Panel({title:'Reporters'})` plus a `Btn('Back to cases')` as its first
// child), which is what "seven pages inheriting a placeholder shell" actually
// looked like on screen: two back controls disagreeing about where back was
// (this head correctly said "Back to the map"; the body's copy said "Back to
// cases" from the map home view), and a hardcoded English title that ignored
// the deployer's own dashboard_ui.nav.relabel -- live-witnessed on uhh, whose
// nav says "Trends over time" while the page under it said "Metrics".
// A panel page always has a name, even when nothing is registered under it --
// an untitled page is one an operator cannot describe when they call for help.
function panelPageTitle(name) { return panelTitle(name) || 'Screen not available'; }
function PanelSwap() {
  const name = state.activePanel;
  const known = !!panelBodies[name];
  const body = known
    ? panelBodies[name]()
    : h('p', {}, 'This screen is not available in this deployment.');
  const backLabel = state.homeView === 'cases' ? 'Back to cases' : 'Back to the map';
  return h('div', { class: 'ds-panel-swap' },
    h('div', { class: 'ds-panel-swap-head' },
      Btn({ variant: 'ghost', children: backLabel, onClick: backToCases }),
      h('h1', { class: 'ds-panel-swap-title' }, panelPageTitle(name))),
    h('div', { class: 'ds-panel-swap-body' }, body)
  );
}

// The five verbs that used to occupy the top of the destination nav. `focus`
// is a toggle, `new_case` is the one primary action, and the rest are rare
// enough to sit quietly at the end of the row rather than above the map.
function ActionRow() {
  const items = buildActionItems({});
  if (!items.length) return null;
  // Each verb renders its glyph BESIDE its word, always, at every width. The
  // glyph is what the mobile icon grid is built out of (app.css), and a
  // control whose icon appears only on a phone is one an operator has to
  // learn twice.
  //
  // The explicit aria-label is load-bearing, not belt-and-braces: the SDK's
  // Btn derives an accessible name from `children` ONLY when children is a
  // string (atoms.js: `typeof children === 'string'`). Passing [glyph, label]
  // makes it an array, so without this every verb in the header would render
  // as an unnamed button -- the same defect as the map pins announcing eight
  // identical "button"s.
  const face = (it) => [
    h('span', { key: 'g', class: 'ds-action-glyph', 'aria-hidden': 'true' }, it.glyph),
    h('span', { key: 'l', class: 'ds-action-label' }, it.label),
  ];
  return h('div', { class: 'ds-action-row' }, ...items.map((it) => {
    if (it.href) {
      // A real anchor, not a JS click -- Export has to actually download.
      return h('a', {
        key: it.key, class: 'ds-action-link', href: it.href,
        title: it.ariaLabel || it.label, 'aria-label': it.ariaLabel || it.label,
      }, ...face(it));
    }
    // Anything that is neither the primary action nor a mode toggle is desk
    // work (Sweep now, Refresh) and gives way first on a narrow screen -- see
    // the .ds-action-rare rule in app.css. In the mobile grid they come back:
    // space is no longer the constraint there.
    const rare = !it.primary && it.active === undefined;
    return h('span', { key: it.key, class: rare ? 'ds-action-rare' : 'ds-action-common' },
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

// THE FRAME'S BOTTOM LINE, and therefore the first thing in the chrome.
//
// A persistent frame exists to answer two questions instantly -- "is anything
// wrong" and "where do I go" -- and then get out of the way. For this
// deployment the answer to the first one is a single number: how many reports
// are waiting for a person right now. That number used to be rendered three
// times and led with none of them: as a bare unlabelled orange badge in this
// same row (components/quick-start-badge.js, now deleted), as a clause buried
// in the status line at the bottom of the page, and as a count in the browser
// tab title. A number with no noun beside it is not information -- on a phone
// it is an orange dot -- and none of the three was clickable, so the frame
// stated the operator's job and then offered no way to start it.
//
// It renders at zero too, deliberately, unlike the exception-only health
// pills beside it: "nothing is waiting" is an answer to the frame's own
// question, not an absence of one, and a control that appears and disappears
// is one an operator never learns the position of. It is a real button with a
// real destination (the worst-first queue -- the same place the Map nav item
// goes), sized for a thumb, with the word carried in the label rather than a
// hover-only title that does not exist on touch.
function AttentionLead() {
  const n = (state.attention || []).length;
  const label = n === 0 ? 'Nothing needs a person' : (n + (n === 1 ? ' needs a person' : ' need a person'));
  // Carries a glyph like every other control in the row so it survives into
  // the mobile icon grid as a tile rather than a lone run of words. The label
  // stays visible under the glyph there -- this is the frame's bottom line
  // and the one control that must not become a guess.
  return h('button', {
    type: 'button',
    class: 'ds-attn-lead' + (n ? ' is-waiting' : ''),
    title: 'Open the "' + QUEUE_NAME + '" list',
    'aria-label': label + ', open the ' + QUEUE_NAME + ' list',
    onclick: openQueue,
  },
    h('span', { key: 'g', class: 'ds-action-glyph', 'aria-hidden': 'true' }, Icon('activity', { size: 15 })),
    h('span', { key: 'l', class: 'ds-action-label' }, label));
}

// The status bar used to render as chrome around nothing (Status({left:[],
// right:[]})). In an operational console this is where "can I trust what I am
// looking at" belongs, so it carries the facts that answer it: how much is
// loaded, whether casey is still hearing the field, and whether this browser
// is still talking to the dashboard.
//
// The attention count is NOT one of them any more -- it is a fact about the
// work, not about whether the screen can be trusted, and it now leads the top
// chrome (AttentionLead above) instead of trailing the bottom of the page in a
// second copy.
//
// "Receiving reports" is the quiet half of the one signal that matters most in
// a surveillance deployment: when the channel is deaf, nothing on this screen
// looks broken and reports simply stop arriving. The loud half is a banner
// (health-notices.js's receivingNotice), and exactly one of the two is ever on
// screen, so they can never disagree. Absent when no channel is configured at
// all -- claiming either way would be inventing a fact.
//
// Dashboard-only mode is stated HERE and nowhere else. It is a property of how
// this console was started (`casey dashboard` passes no llmStatus), true for
// the whole session and unchanged by anything the operator can do on this
// screen -- so it is standing context, not an exception, and health-notices.js
// deliberately raises nothing for it. What it costs is real and specific, which
// is why the phrasing names the store as still live rather than only naming the
// absence.
function StatusBar() {
  const total = state.allCasesTotal || (state.allCases || []).length;
  const hl = state.health.ai;
  const gw = hl && hl.gateway;
  const left = [h('span', { key: 'c' }, `${total} report(s) loaded`)];
  const right = [
    hl && hl.source === 'unwired'
      ? h('span', { key: 'mode' }, 'Reading the store only -- not attached to the running agent')
      : (gw && gw.ok ? h('span', { key: 'rx' }, 'Receiving reports') : null),
    h('span', { key: 'conn' }, state.connLost ? 'Not connected -- showing the last data received' : 'Connected'),
  ].filter(Boolean);
  return Status({ left, right });
}

function MainContent() {
  if (state.activePanel) return PanelSwap();
  if (state.homeView === 'cases') return CaseListDetailLayout();
  return MapCommandCenter();
}

export function App() {
  // The banner renders WITH the gate, not below it. This early return used to
  // hand back LoginGate() alone, and ConnectionBanner() sits further down this
  // function -- so an operator whose link dropped before the session was
  // confirmed got a login form and nothing else, while the app already knew
  // the link was down (api.js had the worker's 503 offline envelope in hand).
  // A form nobody can submit, with no statement of why, on the one screen with
  // no other chrome to say it.
  if (!state.authed) return h('div', { class: 'ds-app-root is-gated' }, ConnectionBanner(), LoginGate());

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
  // Ordered bottom-line-first: the answer, then the verbs, then the account.
  // System-health exceptions are NOT here any more -- they render as sentences
  // in the banner stack below (health-notices.js), where the offline banner
  // already speaks for the same class of fact. The appbar carries what the
  // operator acts on: the attention lead, the verbs, alerts, help, account.
  const crumbRight = [
    AttentionLead(),
    ActionRow(),
    NotificationsCenter(),
    IconButton({ icon: Icon('help'), title: 'What does this screen mean?', onClick: () => openModal('help') }),
    AccountMenu(),
  ].filter(Boolean);
  // trail:[brand] gives the merged topbar+crumb chrome its left identity --
  // the design system hides the topbar's own standalone .brand in merged
  // mode on the assumption the crumb already carries it (app-shell/topbar.css);
  // omitting it here left the titlebar with no brand at all.
  // The breadcrumb names the page the operator is actually on. A content-swap
  // panel is a full page, so leaving the leaf at the deployment's own "Cases"
  // label meant the chrome overhead read "casey / Cases" while the operator was
  // looking at Reporters -- the one piece of shell that exists to say where you
  // are, saying somewhere else. Same lookup as the page's own heading, so the
  // two can never disagree.
  // One wrapper so the whole cluster is a single addressable toolbar rather
  // than a loose run of siblings the crumb lays out however they happen to
  // fall. Desktop: one inline row, one control height, no wrapping. Phone:
  // the same children as a grid of icon tiles (app.css .ds-appbar).
  const crumb = Crumb({
    trail: [brand],
    leaf: state.activePanel ? panelPageTitle(state.activePanel) : leaf,
    right: [h('div', { key: 'appbar', class: 'ds-appbar' }, ...crumbRight)],
  });
  const status = StatusBar();

  // is-map-home marks the one view whose whole point is the size of the map,
  // so the CSS can buy the map its width back from the chrome around it (see
  // app.css). Measured at 1440x900 before this: the map held 49% of the width
  // against the ~78% the operational consoles this layout is modelled on give
  // it, and the difference was entirely nav width plus main-region padding.
  const mapHome = state.homeView === 'map' && !state.activePanel;
  return h('div', { class: 'ds-app-root' + (mapHome ? ' is-map-home' : '') },
    ConnectionBanner(),
    // The link being down outranks everything below it: with no link, none of
    // the health data behind these notices is current, so it speaks first.
    ...HealthNotices(),
    HandoffBanner(),
    AppShell({ topbar, crumb, side, status, main: [MainContent()] }),
    ModalMount(),
    LogoutEverywhereConfirmDialog(),
    ToastTray()
  );
}
