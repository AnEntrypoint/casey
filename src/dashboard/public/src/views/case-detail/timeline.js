// timeline.js -- event timeline with visual distinction per event kind
// (ux-case-detail-timeline-visual-distinction: each kind gets a distinct
// Icon + tone via icons-map.js), client-side search filter, and load-older
// pagination.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Icon, IconButton } from '/design/src/components/shell.js';
import { SearchInput } from '/design/src/components/content.js';
import { state, schedule, appendTimelineEvents, setTimelineSearch } from '../../state.js';
import { fetchCaseEvents, postFlagReply } from '../../api.js';
import { rel, fmtTime } from '../../format.js';
import { eventIcon, eventTone } from '../../icons-map.js';
import { confirmDialog } from '../../components/dialog-shell.js';
const h = webjsx.createElement;

// "Flag this reply" is pillar 8's live-feedback loop for prompt tuning: an
// operator marks a specific outbound reply as bad/off-target, right where
// they're already reading it, so a prompt writer has real flagged examples
// to review (GET /api/flagged-replies) instead of no signal at all. Only
// outbound (casey's own sent replies) can be flagged -- flagging an inbound
// contact message or an internal action/observation makes no sense here.
async function flagReply(caseId, e) {
    const reason = (await confirmDialog({ title: 'Flag this reply', inputLabel: 'What was wrong with this reply? (optional)' })) || '';
    try {
        await postFlagReply(caseId, e.id, reason);
        e._flagged = true;
        schedule();
    } catch { /* best-effort -- a failed flag just leaves the button clickable to retry */ }
}

function TimelineRow({ e, caseId, key } = {}) {
    const flagged = e._flagged || e.data?.flagged_reply;
    return h('div', { key, class: 'casey-ev casey-ev--' + e.kind + ' casey-ev-tone--' + eventTone(e.kind) },
        h('span', { class: 'casey-ev-icon' }, Icon(eventIcon(e.kind), { size: 13 })),
        h('span', { class: 'casey-ev-k' }, e.kind, '/', e.actor),
        h('span', { class: 'casey-ev-text' }, e.text || ''),
        e.kind === 'outbound' && !flagged
            ? IconButton({ icon: Icon('warn', { size: 12 }), title: 'Flag this reply as bad/off-target', onClick: () => flagReply(caseId, e) })
            : (e.kind === 'outbound' && flagged ? h('span', { class: 'casey-ev-flagged', title: 'Flagged for review' }, Icon('warn', { size: 12 })) : null),
        h('span', { class: 'casey-ev-when', title: fmtTime(e.created_at) }, rel(e.created_at))
    );
}

export function Timeline({ caseId, events, eventsTotal, key } = {}) {
    const q = (state.timelineSearch || '').toLowerCase().trim();
    const filtered = q
        ? events.filter(e => (e.kind + ' ' + e.actor + ' ' + (e.text || '')).toLowerCase().includes(q))
        : events;
    const hasMore = eventsTotal != null && events.length < eventsTotal;

    const loadMore = async () => {
        const off = events.length;
        try {
            const older = await fetchCaseEvents(caseId, { offset: String(off) });
            appendTimelineEvents(older.events || []);
        } catch { /* best-effort; a stalled pagination leaves the button in place to retry */ }
    };

    return h('div', { key, class: 'casey-timeline-wrap' },
        h('h3', { class: 'casey-timeline-head' }, 'Timeline', eventsTotal != null ? ' (' + events.length + '/' + eventsTotal + ')' : ''),
        SearchInput({ value: state.timelineSearch || '', placeholder: 'Search timeline...', onInput: setTimelineSearch, resultCount: q ? filtered.length + ' matching' : null }),
        h('div', { class: 'casey-timeline', id: 'timeline' }, ...filtered.map((e, i) => TimelineRow({ key: e.id || i, e, caseId }))),
        hasMore ? h('button', { type: 'button', class: 'casey-load-older', onclick: loadMore }, 'Load older events') : null
    );
}
