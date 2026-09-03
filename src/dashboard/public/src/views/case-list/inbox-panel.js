// Needs-you-now ranked list (server-ranked via /api/attention, NOT a client
// recompute -- the SPA never re-derives urgency). Heat coloring, wait-time,
// owner chips, SLA at-risk badges. Focus-mode full view when state.inboxMode.

import * as ds from '/design/dist/247420.js';
import { state, setActiveId } from '../../state.js';
import { rel, waitFmt, isMine } from '../../format.js';
import { pushHash } from '../../route.js';
const { Chip, Badge, Heading } = ds.components;
const h = ds.h;

function heatClass(score) {
  return score >= 8 ? 'heat-3' : score >= 4 ? 'heat-2' : score > 0 ? 'heat-1' : '';
}

function InboxRow(e) {
  const breaches = e.breaches || [];
  const breachDetail = breaches.length ? breaches.map((b) => b.detail || b.breach).join('; ') : '';
  const ho = breaches.find((b) => b.breach === 'unanswered_handoff' || b.breach === 'unanswered_handoff_escalated');
  const waiting = ho && ho.since_ms ? waitFmt(ho.since_ms) : null;
  const owner = e.assignee && e.assignee !== 'agent' ? e.assignee : '';
  const mine = owner && state.currentUser && owner === state.currentUser.username;
  const otherClaim = owner && !mine;
  const active = e.id === state.activeId;

  return h('div', {
    key: e.id, class: 'tcase ' + heatClass(e.score) + (otherClaim ? ' claimed-other' : '') + (active ? ' active' : ''),
    'data-id': e.id, role: 'listitem', tabindex: '0',
    onclick: () => { setActiveId(e.id); pushHash({ caseId: e.id }); },
    onkeydown: (ev) => { if (ev.key === 'Enter') { setActiveId(e.id); pushHash({ caseId: e.id }); } },
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
  const ranked = state.mineOnly ? state.attention.filter(isMine) : state.attention;
  const inbox = state.inboxMode ? ranked : ranked.slice(0, 12);

  if (!inbox.length) {
    return h('div', { class: 'triage', role: 'list', 'aria-label': 'Needs you now' },
      Heading({ level: 2, children: 'Needs you now' }),
      h('div', { class: 'calm' }, 'All caught up. Nothing needs a person right now. A new one will show up here the moment someone needs you.')
    );
  }

  return h('div', { class: 'triage', role: 'list', 'aria-label': 'Needs you now' },
    h('div', { key: 'head', class: 'triage-head' },
      Heading({ level: 2, children: 'Needs you now' }),
      Badge({ tone: 'blue', children: String(ranked.length) })
    ),
    ...inbox.map(InboxRow)
  );
}
