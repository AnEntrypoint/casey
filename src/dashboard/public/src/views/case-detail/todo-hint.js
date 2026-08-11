// todo-hint.js -- single-line priority-ladder "what to do now" hint, ported
// byte-for-byte in logic from the legacy app.js todoHint() (which itself
// mirrors src/attn.js caseHints()' priority ladder). Rendered as a Lede.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Lede } from '/design/src/components/shell.js';
import { ageHoursOf } from '../../format.js';
const h = webjsx.createElement;

function tagList(c) { return String(c.tags || '').split(',').map(t => t.trim()).filter(Boolean); }

export function todoHintText(c) {
    const tags = tagList(c);
    if (tags.includes('opted-out')) return 'This person asked to stop. Do not message them. Leave this one alone.';
    if (c.status === 'closed') return 'This one is finished. Nothing to do.';
    if (tags.includes('needs-human')) return 'This person asked for a real person. Reply to them below.';
    if (tags.includes('draft-pending')) return 'casey drafted a reply -- review it before it sends. Approve or discard it below.';
    if (tags.includes('health:unanswered_handoff_escalated')) return 'A person was asked for a long time ago and still no one has replied. Step in below.';
    if (tags.includes('health:unanswered_handoff')) return 'A person was asked for and no one has replied. Reply below to take this one on.';
    if (tags.includes('health:incomplete_critical')) return 'The visit-critical facts are still missing and the case is active. Try to reach the farmer now -- once they leave the site some facts cannot be recovered.';
    if (tags.includes('health:abandoned_intake')) return 'On-site facts are still missing and the farmer may be gone. Check if they are still reachable and ask for the most important detail (location or how to find the place).';
    if (c.status === 'waiting' && ageHoursOf(c) >= 24) return 'No answer for over a day. A check-in may help -- reply below.';
    if (tags.includes('health:stuck')) return 'This case has been in the same stage for a while. Check if it needs a push or can be closed.';
    if (tags.includes('health:stale')) return 'No activity for a while. Check if anything needs following up.';
    if (c.autonomy === 'observe') return 'This one is waiting for you. Read it and reply, or set Who answers to auto so casey can answer.';
    if (c.autonomy === 'assisted') return 'casey can draft, but you send. Open it and check the draft.';
    if (c.status === 'resolved') return 'This one is marked done. Close it if you are finished.';
    if (c.status === 'waiting') return 'Waiting on the person to reply. Nothing to do until they answer.';
    if (c.status === 'new' || c.status === 'triaging') return 'A new message came in. casey is sorting it out.';
    return 'casey is handling this one on its own. Step in only if you need to.';
}

export function TodoHint({ case: c, key } = {}) {
    return h('div', { key, class: 'casey-todo-hint' }, Lede({ children: todoHintText(c) }));
}
