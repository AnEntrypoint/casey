// MapCommandCenter -- the map-first home view (BLUF: the single most
// operationally important thing -- where is this happening -- is what an
// operator sees the instant the dashboard loads, not a nav item three
// levels deep). Same two-pane shell as CaseListDetailLayout (map instead
// of the case list on the left; the shared openCase/closeCase keep
// state.activeId, the URL hash, and the case-detail pane all in sync
// regardless of which pane opened the case), so clicking a map marker
// shows that case immediately -- no round trip through "Back to cases"
// first. See nav-config.js for the Map/Cases home-view switch and
// state.js's setHomeView/homeView for the persisted per-viewer default.

import * as webjsx from 'webjsx';
import { state } from '../state.js';
import { MapPanel } from '../panels/map-panel.js';
import { CaseDetailView } from './case-detail-view.js';
import { openCase, closeCase } from './case-list-detail-layout.js';

const h = webjsx.createElement;

export function MapCommandCenter() {
  const hasActive = state.activeId != null;
  // .grow: see the identical comment in case-list-detail-layout.js -- an
  // .app-main direct child needs it to actually fill the region instead of
  // shrinking to its own content's minimum width.
  return h('div', { class: 'app-two-pane app-two-pane-map grow' + (hasActive ? ' has-active' : '') },
    h('div', { class: 'case-list-pane', key: 'map' },
      MapPanel({ embedded: true })
    ),
    h('div', { class: 'case-detail-pane', key: 'detail' },
      CaseDetailView({ onClose: closeCase, onOpenCase: openCase, key: 'detail-view' })
    )
  );
}
