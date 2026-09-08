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
//
// On a phone the two panes do NOT share the screen. Measuring the canonical
// operational console at 390x844 (USGS's earthquake map) showed it collapses
// to one pane at a time behind a list/map toggle rather than stacking, and the
// reason is plain once you try the alternative: splitting a 844px-tall phone
// gives you half a map -- too small to read a rural pin field -- AND a cramped
// list, instead of a usable one of either. The toggle below is that mode
// switch; above the breakpoint it is hidden by CSS and both panes show.

import * as webjsx from 'webjsx';
import { Btn } from 'ds/components/shell.js';
import { state, setMobilePane } from '../state.js';
import { MapPanel, MapRail } from '../panels/map-panel.js';
import { CaseDetailView } from './case-detail-view.js';
import { openCase, closeCase } from './case-list-detail-layout.js';

const h = webjsx.createElement;

function paneToggle() {
  const btn = (pane, label) => h('button', {
    key: pane, type: 'button',
    class: 'ds-seg-btn' + (state.mobilePane === pane ? ' is-on' : ''),
    'aria-pressed': state.mobilePane === pane ? 'true' : 'false',
    onclick: () => setMobilePane(pane),
  }, label);
  return h('div', { class: 'ds-pane-toggle ds-seg', role: 'group', 'aria-label': 'Map or list' },
    btn('map', 'Map'), btn('list', 'List'));
}

export function MapCommandCenter() {
  const hasActive = state.activeId != null;
  // .grow: see the identical comment in case-list-detail-layout.js -- an
  // .app-main direct child needs it to actually fill the region instead of
  // shrinking to its own content's minimum width.
  //
  // The mobile pane class is applied unconditionally; the CSS that acts on it
  // is inside the phone container query, so it is inert on a desktop. Doing it
  // the other way (branching in JS on a measured width) would need a resize
  // listener and would fight the container query it is trying to agree with.
  return h('div', {
    class: 'app-two-pane app-two-pane-map grow'
      + (hasActive ? ' has-active' : '')
      + ' m-' + (state.mobilePane === 'list' ? 'list' : 'map'),
  },
    paneToggle(),
    h('div', { class: 'case-list-pane', key: 'map' },
      MapPanel()
    ),
    h('div', { class: 'case-detail-pane', key: 'rail' },
      hasActive
        // A worded back control, not a bare glyph: this is the only way back to
        // the list on a phone, where the rail covers the map entirely.
        // showBack:false -- this rail row IS the way out. Without it the pane
        // rendered a second back control immediately under this one, reading a
        // bare " cases" while it actually returned here.
        ? h('div', { class: 'ds-rail-stack' },
            h('div', { class: 'ds-rail-back' },
              Btn({ variant: 'ghost', children: 'Back to the list', onClick: () => closeCase() })),
            CaseDetailView({ onClose: closeCase, onOpenCase: openCase, key: 'detail-view', showBack: false }))
        : MapRail()
    )
  );
}
