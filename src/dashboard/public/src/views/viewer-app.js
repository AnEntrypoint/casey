import * as webjsx from '/design/vendor/webjsx/index.js';
import { AppShell, Topbar, Side, Crumb, Status, Icon } from '/design/src/components/shell.js';
import { state, schedule } from '../state.js';
import { AccountMenu, LogoutEverywhereConfirmDialog } from '../components/account-menu.js';
import { ConnectionBanner } from '../components/connection-banner.js';
import { ToastTray } from '../components/toast-tray.js';
import { brandName } from '../vocabulary.js';
import { ViewTitle, VIEW_TITLE_ID } from './view-title.js';
import { ResolvedMapPanel } from '../panels/resolved-map-panel.js';
import { DiseaseReportsPanel } from '../panels/disease-reports-panel.js';
import { rd } from '../panels/reports-data.js';
const h = webjsx.createElement;

const vs = { view: 'home' };
const TITLES = { home: 'Diseases found', map: 'Resolved cases map', reports: 'Disease reports' };

function nav() {
  const go = (v) => (e) => { if (e && e.preventDefault) e.preventDefault(); vs.view = v; schedule(); };
  return Side({
    sections: [{
      group: 'Reports',
      items: [
        { key: 'home', glyph: Icon('activity', { size: 15 }), label: 'Overview', onClick: go('home'), active: vs.view === 'home' },
        { key: 'map', glyph: Icon('globe', { size: 15 }), label: 'Resolved cases map', onClick: go('map'), active: vs.view === 'map' },
        { key: 'reports', glyph: Icon('page', { size: 15 }), label: 'Disease reports', onClick: go('reports'), active: vs.view === 'reports' },
      ],
    }],
  });
}

export function ViewerApp() {
  const brand = brandName();
  const body = vs.view === 'map' ? [ResolvedMapPanel()]
    : vs.view === 'reports' ? [DiseaseReportsPanel()]
      : [ResolvedMapPanel(), DiseaseReportsPanel()];
  const main = h('div', { class: 'field-main viewer-main' }, ViewTitle(TITLES[vs.view]), ...body);
  const total = rd.points ? rd.points.count : null;
  const statusText = total != null ? total + (total === 1 ? ' signed-off case on the map' : ' signed-off cases on the map')
    : (rd.error && !rd.loading ? 'Figures not loaded -- use Try again on the map' : 'Loading');
  return h('div', { class: 'ds-app-root viewer-app' },
    ConnectionBanner(),
    AppShell({
      topbar: Topbar({ brand, leaf: 'Read-only viewer', items: [], themeToggle: false }),
      crumb: Crumb({ trail: [brand], leaf: 'Read-only viewer', right: [h('div', { key: 'appbar', class: 'ds-appbar' }, AccountMenu())] }),
      side: nav(),
      status: Status({
        left: [h('span', { key: 'c' }, statusText)],
        right: [h('span', { key: 'n' }, state.connLost ? 'Not connected -- showing the last data received' : 'Connected -- read-only, no personal details')],
        ariaLabel: 'Status bar',
      }),
      main: [main], bannerLabel: 'Top bar', mainLabelledby: VIEW_TITLE_ID,
    }),
    LogoutEverywhereConfirmDialog(),
    ToastTray());
}
