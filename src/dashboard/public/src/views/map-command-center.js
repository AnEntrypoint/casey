import * as webjsx from 'webjsx';
import { Btn } from 'ds/components/shell.js';
import { FilterPills } from 'ds/components/content/feedback.js';
import { state, setMobilePane } from '../state.js';
import { MapPanel, MapRail } from '../panels/map-panel.js';
import { CaseDetailView } from './case-detail-view.js';
import { openCase, closeCase } from './case-list-detail-layout.js';
import { ViewTitle } from './view-title.js';
import { panelTitle } from './nav-config.js';
import { word } from '../words.js';

const h = webjsx.createElement;

function paneToggle() {
  return h('div', { class: 'ds-pane-toggle' }, FilterPills({
    label: word('ui.map_mode_label'), selected: state.mobilePane,
    options: [{ id: 'map', label: word('ui.map_mode_map') }, { id: 'list', label: word('ui.map_mode_list') }],
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
    ViewTitle(panelTitle('home_map') || word('ui.map_title')),
    paneToggle(),
    h('div', { class: 'case-list-pane', key: 'map' },
      MapPanel()
    ),
    h('div', { class: 'case-detail-pane', key: 'rail' },
      hasActive
        ? h('div', { class: 'ds-rail-stack' },
            h('div', { class: 'ds-rail-back' },
              Btn({ variant: 'ghost', children: word('ui.map_back_to_list'), onClick: () => closeCase() })),
            CaseDetailView({ onClose: closeCase, onOpenCase: openCase, key: 'detail-view', showBack: false }))
        : MapRail()
    )
  );
}
