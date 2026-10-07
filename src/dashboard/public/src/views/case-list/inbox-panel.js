import * as webjsx from 'webjsx';
import { Chip, Badge, Heading } from 'ds/components/shell.js';
import { state, setActiveId, setInboxMode, schedule } from '../../state.js';
import { rel, waitFmt, isMine, channelLabel } from '../../format.js';
import { urgencyBand, URGENCY_BAND_LABEL, queueName } from '../../map-model.js';
import { pushHash } from '../../route.js';
import { QueueMore } from '../../components/filter-chip.js';
const h = webjsx.createElement;

const INBOX_PAGE = 8;
let inboxShown = INBOX_PAGE;

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
  const band = urgencyBand(Number(e.score)) || 1;
  const open = () => { setActiveId(e.id); pushHash({ caseId: e.id }); };

  const name = [e.ref + ': ' + (URGENCY_BAND_LABEL[band] || 'can wait'), e.subject || '(no subject)', e.reason || 'This one is worth a look.', breachDetail, waiting ? 'waiting ' + waiting : '', owner ? (mine ? 'claimed by you' : 'claimed by ' + owner) : ''].filter(Boolean).join('. ');
  return h('div', {
    key: e.id, class: 'tcase heat-' + band + (otherClaim ? ' claimed-other' : '') + (active ? ' active' : ''),
    'data-id': e.id, role: 'button', tabindex: '0',
    'aria-label': name,
    onclick: open,
    onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } },
  },
    h('div', { key: 'why', class: 'tcase-why' },
      h('span', { key: 's' }, e.subject || '(no subject)'),
      waiting ? Badge({ key: 'w', tone: 'warn', children: 'waiting ' + waiting }) : null,
      owner ? Chip({ key: 'o', tone: mine ? 'accent' : '', size: 'sm', children: mine ? 'you' : owner }) : null
    ),
    h('div', { key: 'r', class: 'tcase-reason' }, e.reason || 'This one is worth a look.'),
    breachDetail ? h('div', { key: 'b', class: 'tcase-breach-detail' }, breachDetail) : null,
    h('div', { key: 'meta', class: 'tcase-meta' },
      e.ref + ' - ' + channelLabel(e.channel) + ' - ' + rel(e.updated_at)
    )
  );
}

export function InboxPanel() {
  const ranked = state.mineOnly ? (state.attention || []).filter(isMine) : (state.attention || []);
  const cap = state.inboxMode ? ranked.length : inboxShown;
  const shown = ranked.slice(0, cap);

  if (!shown.length) {
    return h('div', { class: 'triage', 'aria-label': queueName() },
      Heading({ level: 2, children: queueName() }),
      h('div', { class: 'calm' }, state.mineOnly
        ? 'Nothing you have claimed needs you right now. Turn off "yours" below to see everyone else\'s.'
        : 'All caught up. Nothing needs a person right now. A new one will show up here the moment someone needs you.')
    );
  }

  return h('div', { class: 'triage', 'aria-label': queueName() },
    h('div', { key: 'head', class: 'triage-head' },
      Heading({ level: 2, children: queueName() }),
      Badge({ tone: 'blue', children: String(ranked.length) })
    ),
    h('div', { key: 'rows', class: 'triage-rows' }, ...shown.map(InboxRow)),
    ranked.length > shown.length
      ? QueueMore({ key: 'more', onClick: () => { inboxShown = ranked.length; schedule(); }, children: 'Show all ' + ranked.length + ' that need a person' })
      : (!state.inboxMode && shown.length > INBOX_PAGE
        ? QueueMore({ key: 'less', onClick: () => { inboxShown = INBOX_PAGE; schedule(); }, children: 'Show fewer' })
        : null),
    state.inboxMode
      ? QueueMore({ key: 'unfocus', onClick: () => { setInboxMode(false); }, children: 'Also load every other report' })
      : null
  );
}
