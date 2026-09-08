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

import * as webjsx from 'webjsx';
import { Chip, Badge, Heading } from 'ds/components/shell.js';
import { state, setActiveId, setInboxMode, schedule } from '../../state.js';
import { rel, waitFmt, isMine } from '../../format.js';
import { urgencyBand, URGENCY_BAND_LABEL, QUEUE_NAME } from '../../map-model.js';
import { pushHash } from '../../route.js';
const h = webjsx.createElement;

// How many rows are shown before the list says so. The number itself is not
// the point -- the point is that the list NEVER truncates without naming the
// true total next to the control that reveals the rest. A silently capped
// triage queue in a disease-surveillance deployment means report 9 is
// invisible and nothing on screen says it exists.
const INBOX_PAGE = 8;
let inboxShown = INBOX_PAGE;

// One short fact per breach, with the elapsed time stripped out of every one
// of them. The server's own detail strings each carry the interval ("no
// activity for 13 days", "in \"waiting\" for 13 days (max 7 days)", "on-site
// facts still missing after 13 days", "in waiting for 13 days but
// visit-critical facts still missing"), so a case tripping four guardrails
// stated the same 13 days four times in four wordings. The interval is one
// fact: it is said once, up front, and each breach then adds only what it
// alone knows.
const BREACH_FACT = {
  stale: 'no activity',
  stuck: 'stuck in this stage',
  abandoned_intake: 'on-site facts still missing',
  incomplete_critical: 'visit-critical facts still missing',
  unanswered_handoff: 'nobody has answered the request for a person',
  unanswered_handoff_escalated: 'still no reply after escalating',
  unsent_draft: 'a drafted reply is waiting for approval',
  never_closed: 'resolved but never closed',
  premature_complete: 'marked done with the visit facts still blank',
  timestamp_corrupt: 'this case\'s own timestamps look wrong',
};

function breachSummary(breaches) {
  if (!breaches.length) return '';
  const facts = [];
  for (const b of breaches) {
    const f = BREACH_FACT[b.breach] || b.breach;
    if (!facts.includes(f)) facts.push(f);
  }
  const longest = Math.max(0, ...breaches.map((b) => Number(b.since_ms) || 0));
  const span = longest > 0 ? waitFmt(longest) + ': ' : '';
  return span + facts.join('; ');
}

function InboxRow(e) {
  const breaches = e.breaches || [];
  const breachDetail = breachSummary(breaches);
  const ho = breaches.find((b) => b.breach === 'unanswered_handoff' || b.breach === 'unanswered_handoff_escalated');
  const waiting = ho && ho.since_ms ? waitFmt(ho.since_ms) : null;
  const owner = e.assignee && e.assignee !== 'agent' ? e.assignee : '';
  const mine = owner && state.currentUser && owner === state.currentUser.username;
  const otherClaim = owner && !mine;
  const active = e.id === state.activeId;
  // Every row here scored above zero to be in this list at all, so a row that
  // somehow arrives without a usable score still belongs in the queue -- it
  // lands in the lowest band rather than losing its stripe entirely.
  const band = urgencyBand(Number(e.score)) || 1;
  const open = () => { setActiveId(e.id); pushHash({ caseId: e.id }); };

  return h('div', {
    key: e.id, class: 'tcase heat-' + band + (otherClaim ? ' claimed-other' : '') + (active ? ' active' : ''),
    'data-id': e.id, role: 'listitem', tabindex: '0',
    // Says the band in words, not only in a colour stripe -- a stripe is the
    // one channel a screen reader and a colourblind operator both miss.
    'aria-label': e.ref + ': ' + (URGENCY_BAND_LABEL[band] || 'can wait'),
    onclick: open,
    onkeydown: (ev) => { if (ev.key === 'Enter') open(); },
  },
    // The report leads. The ranking reason is drawn from a fixed ladder, so on
    // a quiet morning most rows share one sentence ("A new message came in.")
    // and leading with it makes the queue unreadable -- the subject is the
    // only line that tells one report from another.
    h('div', { key: 'why', class: 'tcase-why' },
      h('span', { key: 's' }, e.subject || '(no subject)'),
      waiting ? Badge({ key: 'w', tone: 'warn', children: 'waiting ' + waiting }) : null,
      owner ? Chip({ key: 'o', tone: mine ? 'accent' : '', size: 'sm', children: mine ? 'you' : owner }) : null
    ),
    h('div', { key: 'r', class: 'tcase-reason' }, e.reason || 'This one is worth a look.'),
    breachDetail ? h('div', { key: 'b', class: 'tcase-breach-detail' }, breachDetail) : null,
    h('div', { key: 'meta', class: 'tcase-meta' },
      e.ref + ' - ' + e.channel + ' - ' + rel(e.updated_at)
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
    return h('div', { class: 'triage', role: 'list', 'aria-label': QUEUE_NAME },
      Heading({ level: 2, children: QUEUE_NAME }),
      h('div', { class: 'calm' }, state.mineOnly
        ? 'Nothing you have claimed needs you right now. Turn off "yours" below to see everyone else\'s.'
        : 'All caught up. Nothing needs a person right now. A new one will show up here the moment someone needs you.')
    );
  }

  return h('div', { class: 'triage', role: 'list', 'aria-label': QUEUE_NAME },
    h('div', { key: 'head', class: 'triage-head' },
      Heading({ level: 2, children: QUEUE_NAME }),
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
