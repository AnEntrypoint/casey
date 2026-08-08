// timeline.js -- event timeline with visual distinction per event kind
// (ux-case-detail-timeline-visual-distinction: each kind gets a distinct
// Icon + tone via icons-map.js), client-side search filter, and load-older
// pagination.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Icon, IconButton } from '/design/src/components/shell.js';
import { SearchInput } from '/design/src/components/content.js';
import { state, schedule, appendTimelineEvents, setTimelineSearch } from '../../state.js';
import { fetchCaseEvents } from '../../api.js';
import { rel, fmtTime } from '../../format.js';
import { eventIcon, eventTone } from '../../icons-map.js';
const h = webjsx.createElement;

function TimelineRow({ e, key } = {}) {
    return h('div', { key, class: 'casey-ev casey-ev--' + e.kind + ' casey-ev-tone--' + eventTone(e.kind) },
        h('span', { class: 'casey-ev-icon' }, Icon(eventIcon(e.kind), { size: 13 })),
        h('span', { class: 'casey-ev-k' }, e.kind, '/', e.actor),
        h('span', { class: 'casey-ev-text' }, e.text || ''),
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
        h('div', { class: 'casey-timeline', id: 'timeline' }, ...filtered.map((e, i) => TimelineRow({ key: e.id || i, e }))),
        hasMore ? h('button', { type: 'button', class: 'casey-load-older', onclick: loadMore }, 'Load older events') : null
    );
}
