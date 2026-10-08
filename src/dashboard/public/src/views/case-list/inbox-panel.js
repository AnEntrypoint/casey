import * as webjsx from 'webjsx';
import { Chip, Badge, Heading } from 'ds/components/shell.js';
import { state, setActiveId, setInboxMode, schedule } from '../../state.js';
import { rel, waitFmt, isMine, channelLabel } from '../../format.js';
import { urgencyBand, URGENCY_BAND_LABEL, queueName } from '../../map-model.js';
import { pushHash } from '../../route.js';
import { QueueMore } from '../../components/filter-chip.js';
import { word } from '../../words.js';
const h = webjsx.createElement;

const INBOX_PAGE = 8;
let inboxShown = INBOX_PAGE;

const BREACH_KEY = {
  stale: 'ui.inbox_panel_breach_stale',
  stuck: 'ui.inbox_panel_breach_stuck',
  abandoned_intake: 'ui.inbox_panel_breach_abandoned_intake',
  incomplete_critical: 'ui.inbox_panel_breach_incomplete_critical',
  unanswered_handoff: 'ui.inbox_panel_breach_unanswered_handoff',
  unanswered_handoff_escalated: 'ui.inbox_panel_breach_unanswered_handoff_escalated',
  unsent_draft: 'ui.inbox_panel_breach_unsent_draft',
  never_closed: 'ui.inbox_panel_breach_never_closed',
  premature_complete: 'ui.inbox_panel_breach_premature_complete',
  timestamp_corrupt: 'ui.inbox_panel_breach_timestamp_corrupt',
};
function breachFact(breach) { return BREACH_KEY[breach] ? word(BREACH_KEY[breach]) : breach; }

function breachSummary(breaches) {
  if (!breaches.length) return '';
  const facts = [];
  for (const b of breaches) {
    const f = breachFact(b.breach);
    if (!facts.includes(f)) facts.push(f);
  }
  const longest = Math.max(0, ...breaches.map((b) => Number(b.since_ms) || 0));
  const span = longest > 0 ? word('ui.inbox_panel_span', { wait: waitFmt(longest) }) : '';
  return span + facts.join(word('ui.inbox_panel_sep_semicolon'));
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

  const name = [word('ui.inbox_panel_ref_band', { ref: e.ref, band: URGENCY_BAND_LABEL[band] || word('ui.inbox_panel_can_wait') }), e.subject || word('ui.inbox_panel_no_subject'), e.reason || word('ui.inbox_panel_worth_look'), breachDetail, waiting ? word('ui.inbox_panel_waiting', { wait: waiting }) : '', owner ? (mine ? word('ui.inbox_panel_claimed_you') : word('ui.inbox_panel_claimed_by', { owner })) : ''].filter(Boolean).join(word('ui.inbox_panel_sep_sentence'));
  return h('div', {
    key: e.id, class: 'tcase heat-' + band + (otherClaim ? ' claimed-other' : '') + (active ? ' active' : ''),
    'data-id': e.id, role: 'button', tabindex: '0',
    'aria-label': name,
    onclick: open,
    onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } },
  },
    h('div', { key: 'why', class: 'tcase-why' },
      h('span', { key: 's' }, e.subject || word('ui.inbox_panel_no_subject')),
      waiting ? Badge({ key: 'w', tone: 'warn', children: word('ui.inbox_panel_waiting', { wait: waiting }) }) : null,
      owner ? Chip({ key: 'o', tone: mine ? 'accent' : '', size: 'sm', children: mine ? word('ui.inbox_panel_you') : owner }) : null
    ),
    h('div', { key: 'r', class: 'tcase-reason' }, e.reason || word('ui.inbox_panel_worth_look')),
    breachDetail ? h('div', { key: 'b', class: 'tcase-breach-detail' }, breachDetail) : null,
    h('div', { key: 'meta', class: 'tcase-meta' },
      word('ui.inbox_panel_meta', { ref: e.ref, channel: channelLabel(e.channel), when: rel(e.updated_at) })
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
        ? word('ui.inbox_panel_calm_mine')
        : word('ui.inbox_panel_calm_all'))
    );
  }

  return h('div', { class: 'triage', 'aria-label': queueName() },
    h('div', { key: 'head', class: 'triage-head' },
      Heading({ level: 2, children: queueName() }),
      Badge({ tone: 'blue', children: String(ranked.length) })
    ),
    h('div', { key: 'rows', class: 'triage-rows' }, ...shown.map(InboxRow)),
    ranked.length > shown.length
      ? QueueMore({ key: 'more', onClick: () => { inboxShown = ranked.length; schedule(); }, children: word('ui.inbox_panel_show_all', { n: ranked.length }) })
      : (!state.inboxMode && shown.length > INBOX_PAGE
        ? QueueMore({ key: 'less', onClick: () => { inboxShown = INBOX_PAGE; schedule(); }, children: word('ui.inbox_panel_show_fewer') })
        : null),
    state.inboxMode
      ? QueueMore({ key: 'unfocus', onClick: () => { setInboxMode(false); }, children: word('ui.inbox_panel_load_all') })
      : null
  );
}
