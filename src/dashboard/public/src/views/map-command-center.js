// MapCommandCenter -- the map-first home view (BLUF: the single most
// operationally important thing -- where is this happening -- is what an
// operator sees the instant the dashboard loads, not a nav item three
// levels deep).
//
// TWO children, not three: the map pane, and ONE rail. The rail shows the
// worst-first queue when nothing is open and the case detail when something
// is, with an explicit "Back to the list" between them. That is the whole
// structural idea, and it replaces an earlier arrangement where the queue
// floated over the map while the detail pane sat beside it saying "no report
// open yet" -- which wasted a whole column to say nothing AND covered the map
// it was telling you to tap. A third docked column is not an option either:
// at 1366px it leaves the map under 400px, so the map stops being the point.
//
// openCase/closeCase (case-list-detail-layout.js) already own state.activeId
// and the URL hash, so clicking a map marker, clicking a queue row, and
// deep-linking all converge on the same state with nothing new added here.

import * as webjsx from 'webjsx';
import { Btn } from 'ds/components/shell.js';
import { state } from '../state.js';
import { MapPanel, MapRail } from '../panels/map-panel.js';
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
    h('div', { class: 'case-detail-pane', key: 'rail' },
      hasActive
        // A worded back control, not a bare glyph: this is the only way back to
        // the list on a phone, where the rail covers the map entirely.
        ? h('div', { class: 'ds-rail-stack' },
            h('div', { class: 'ds-rail-back' },
              Btn({ variant: 'ghost', children: 'Back to the list', onClick: () => closeCase() })),
            CaseDetailView({ onClose: closeCase, onOpenCase: openCase, key: 'detail-view' }))
        : MapRail()
    )
  );
}
