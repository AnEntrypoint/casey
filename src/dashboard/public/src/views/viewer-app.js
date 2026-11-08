import * as webjsx from '/design/vendor/webjsx/index.js';
import { AppShell, Topbar, Side, Crumb, Status, Icon } from '/design/src/components/shell.js';
import { state, schedule } from '../state.js';
import { AccountMenu, LogoutEverywhereConfirmDialog } from '../components/account-menu.js';
import { ConnectionBanner } from '../components/connection-banner.js';
import { ToastTray } from '../components/toast-tray.js';
import { brandName } from '../vocabulary.js';
import { word } from '../words.js';
import { ViewTitle, VIEW_TITLE_ID } from './view-title.js';
import { ResolvedMapPanel } from '../panels/resolved-map-panel.js';
import { DiseaseReportsPanel } from '../panels/disease-reports-panel.js';
import { rd } from '../panels/reports-data.js';
const h = webjsx.createElement;

const vs = { view: 'home' };
const TITLE_KEY = { home: 'ui.viewer_app_diseases_found', map: 'ui.viewer_app_resolved_map', reports: 'ui.viewer_app_disease_reports' };

function nav() {
  const go = (v) => (e) => { if (e && e.preventDefault) e.preventDefault(); vs.view = v; schedule(); };
  return Side({
    sections: [{
      group: word('ui.viewer_app_group_reports'),
      items: [
        { key: 'home', glyph: Icon('activity', { size: 15 }), label: word('ui.viewer_app_overview'), onClick: go('home'), active: vs.view === 'home' },
        { key: 'map', glyph: Icon('globe', { size: 15 }), label: word('ui.viewer_app_resolved_map'), onClick: go('map'), active: vs.view === 'map' },
        { key: 'reports', glyph: Icon('page', { size: 15 }), label: word('ui.viewer_app_disease_reports'), onClick: go('reports'), active: vs.view === 'reports' },
      ],
    }],
  });
}

export function ViewerApp() {
  const brand = brandName();
  const body = vs.view === 'map' ? [ResolvedMapPanel()]
    : vs.view === 'reports' ? [DiseaseReportsPanel()]
      : [ResolvedMapPanel(), DiseaseReportsPanel()];
  const main = h('div', { class: 'field-main viewer-main' }, ViewTitle(word(TITLE_KEY[vs.view])), ...body);
  const total = rd.points ? rd.points.count : null;
  const statusText = total != null ? word(total === 1 ? 'ui.viewer_app_signed_one' : 'ui.viewer_app_signed_many', { n: total })
    : (rd.error && !rd.loading ? word('ui.viewer_app_figures_not_loaded') : word('ui.viewer_app_loading'));
  return h('div', { class: 'ds-app-root viewer-app' },
    ConnectionBanner(),
    AppShell({
      topbar: Topbar({ brand, leaf: word('ui.viewer_app_read_only'), items: [], themeToggle: false }),
      crumb: Crumb({ trail: [brand], leaf: word('ui.viewer_app_read_only'), right: [h('div', { key: 'appbar', class: 'ds-appbar' }, AccountMenu())] }),
      side: nav(),
      status: Status({
        left: [h('span', { key: 'c' }, statusText)],
        right: [h('span', { key: 'n' }, state.connLost ? word('ui.viewer_app_not_connected') : word('ui.viewer_app_connected'))],
        ariaLabel: word('ui.viewer_app_status_aria'),
      }),
      main: [main], bannerLabel: word('ui.viewer_app_top_bar'), mainLabelledby: VIEW_TITLE_ID,
    }),
    LogoutEverywhereConfirmDialog(),
    ToastTray());
}
