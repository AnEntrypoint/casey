import * as webjsx from 'webjsx';
import { Btn } from 'ds/components/shell.js';
import { FilterPills } from 'ds/components/content/feedback.js';
import { state, setMobilePane } from '../state.js';
import { MapPanel, MapRail } from '../panels/map-panel.js';
import { CaseDetailView } from './case-detail-view.js';
import { openCase, closeCase } from './case-list-detail-layout.js';
import { ViewTitle } from './view-title.js';
import { panelTitle } from './nav-config.js';

const h = webjsx.createElement;

function paneToggle() {
  return h('div', { class: 'ds-pane-toggle' }, FilterPills({
    label: 'Map or list', selected: state.mobilePane,
    options: [{ id: 'map', label: 'Map' }, { id: 'list', label: 'List' }],
    onSelect: setMobilePane,
  }));
}

export function MapCommandCenter() {
  const hasActive = state.activeId != null;
  return h('div', {
    class: 'app-two-pane app-two-pane-map grow'
      + (hasActive ? ' has-active' : '')
      + ' m-' + (state.mobilePane === 'list' ? 'list' : 'map'),
  },
    ViewTitle(panelTitle('home_map') || 'Map'),
    paneToggle(),
    h('div', { class: 'case-list-pane', key: 'map' },
      MapPanel()
    ),
    h('div', { class: 'case-detail-pane', key: 'rail' },
      hasActive
        ? h('div', { class: 'ds-rail-stack' },
            h('div', { class: 'ds-rail-back' },
              Btn({ variant: 'ghost', children: 'Back to the list', onClick: () => closeCase() })),
            CaseDetailView({ onClose: closeCase, onOpenCase: openCase, key: 'detail-view', showBack: false }))
        : MapRail()
    )
  );
}
