// The answer this view exists to give: which reports need a person, worst
// first. It is rendered FIRST, directly under the view's head, because it is
// the bottom line -- the search box, the stage pills and the full report list
// are supporting detail and controls, and they sit below it.
//
// Rows are server-ranked (/api/attention -> attn.js's score + plain-English
// reason); the SPA never re-derives urgency. The band a row is painted in
// comes from map-model.js's urgencyBand, the ONE shared ladder the map's pins
// read too.
//
// This module used to carry its own copy of that ladder (score >= 8 -> heat-3,
// >= 4 -> heat-2, > 0 -> heat-1). Those thresholds had drifted an order of
// magnitude below the real score scale -- attn.js's smallest single signal is
// stale=10 and needs-human alone is 100 -- so in practice every row here
// painted heat-3 (the loudest band) while the very same case on the map sat in
// band 1 or 2. Two derivations, two answers, one screen: exactly the failure
// map-model.js exists to prevent. There is no local copy any more.

import * as ds from '/design/dist/247420.js';
import { state, setActiveId, setInboxMode, schedule } from '../../state.js';
import { rel, waitFmt, isMine } from '../../format.js';
import { urgencyBand, URGENCY_BAND_LABEL } from '../../map-model.js';
import { pushHash } from '../../route.js';
const { Chip, Badge, Heading } = ds.components;
const h = ds.h;

// How many rows are shown before the list says so. The number itself is not
// the point -- the point is that the list NEVER truncates without naming the
// true total next to the control that reveals the rest. A silently capped
// triage queue in a disease-surveillance deployment means report 9 is
// invisible and nothing on screen says it exists.
const INBOX_PAGE = 8;
let inboxShown = INBOX_PAGE;

function InboxRow(e) {
  const breaches = e.breaches || [];
  const breachDetail = breaches.length ? breaches.map((b) => b.detail || b.breach).join('; ') : '';
  const ho = breaches.find((b) => b.breach === 'unanswered_handoff' || b.breach === 'unanswered_handoff_escalated');
  const waiting = ho && ho.since_ms ? waitFmt(ho.since_ms) : null;
  const owner = e.assignee && e.assignee !== 'agent' ? e.assignee : '';
  const mine = owner && state.currentUser && owner === state.currentUser.username;
  const otherClaim = owner && !mine;
  const active = e.id === state.activeId;
  const band = urgencyBand(Number(e.score));
  const open = () => { setActiveId(e.id); pushHash({ caseId: e.id }); };

  return h('div', {
    key: e.id, class: 'tcase heat-' + band + (otherClaim ? ' claimed-other' : '') + (active ? ' active' : ''),
    'data-id': e.id, role: 'listitem', tabindex: '0',
    // Says the band in words, not only in a colour stripe -- a stripe is the
    // one channel a screen reader and a colourblind operator both miss.
    'aria-label': e.ref + ': ' + (URGENCY_BAND_LABEL[band] || 'in the queue'),
    onclick: open,
    onkeydown: (ev) => { if (ev.key === 'Enter') open(); },
  },
    h('div', { key: 'why', class: 'tcase-why' },
      h('span', { key: 'r' }, e.reason || 'This one is worth a look.'),
      waiting ? Badge({ key: 'w', tone: 'warn', children: 'waiting ' + waiting }) : null,
      owner ? Chip({ key: 'o', tone: mine ? 'accent' : '', size: 'sm', children: mine ? 'you' : owner }) : null,
      breachDetail ? h('span', { key: 'b', class: 'tcase-breach-detail' }, breachDetail) : null
    ),
    h('div', { key: 'meta', class: 'tcase-meta' },
      e.ref + ' - ' + e.channel + ' - ' + (e.subject || '(no subject)') + ' - ' + rel(e.updated_at)
    )
  );
}

export function InboxPanel() {
  const ranked = state.mineOnly ? (state.attention || []).filter(isMine) : (state.attention || []);
  // Focus mode (the topbar's own toggle) already means "the queue is the whole
  // screen", so it shows the queue whole rather than re-capping it.
  const cap = state.inboxMode ? ranked.length : inboxShown;
  const shown = ranked.slice(0, cap);

  if (!shown.length) {
    return h('div', { class: 'triage', role: 'list', 'aria-label': 'Needs a person now' },
      Heading({ level: 2, children: 'Needs a person now' }),
      h('div', { class: 'calm' }, state.mineOnly
        ? 'Nothing you have claimed needs you right now. Turn off "yours" below to see everyone else\'s.'
        : 'All caught up. Nothing needs a person right now. A new one will show up here the moment someone needs you.')
    );
  }

  return h('div', { class: 'triage', role: 'list', 'aria-label': 'Needs a person now' },
    h('div', { key: 'head', class: 'triage-head' },
      Heading({ level: 2, children: 'Needs a person now' }),
      Badge({ tone: 'blue', children: String(ranked.length) })
    ),
    ...shown.map(InboxRow),
    // The true total sits on the control that reveals the rest, so the count
    // in the head above can never silently disagree with the rows below it.
    ranked.length > shown.length
      ? h('button', {
        key: 'more', type: 'button', class: 'ds-queue-more',
        onclick: () => { inboxShown = ranked.length; schedule(); },
      }, 'Show all ' + ranked.length + ' that need a person')
      : (!state.inboxMode && shown.length > INBOX_PAGE
        ? h('button', {
          key: 'less', type: 'button', class: 'ds-queue-more',
          onclick: () => { inboxShown = INBOX_PAGE; schedule(); },
        }, 'Show fewer')
        : null),
    // Focus mode is reachable from the topbar, but nothing on this screen said
    // what it does or that it is on. It stops the full report list loading at
    // all, which is why the list below it goes empty -- so the control that
    // causes that sits next to the thing it affects, worded plainly.
    state.inboxMode
      ? h('button', {
        key: 'unfocus', type: 'button', class: 'ds-queue-more',
        onclick: () => { setInboxMode(false); },
      }, 'Also load every other report')
      : null
  );
}
