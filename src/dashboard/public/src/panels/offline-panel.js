// Offline panel -- missed-while-down queue. Content-swap panel
// (state.activePanel === 'offline'). Table-based.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { state, setActiveId, setOfflineQueueCount } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchUnreplied } from '../api.js';
import { fmtTime } from '../format.js';

const h = webjsx.createElement;

// The count in the nav badge is a second consumer of this same response, so it
// is published from the success path rather than derived again anywhere else.
const loader = createPanelLoader({
    what: 'the offline queue',
    label: 'loading offline queue',
    fetch: fetchUnreplied,
    apply: (j) => {
        state._offline = j;
        setOfflineQueueCount((j && j.total) || 0);
    },
});

export function OfflinePanel() {
    loader.ensureLoaded();
    const body = loader.slot(() => {
        const j = state._offline;
        const rows = (j && j.items) || [];
        if (!rows.length) return Alert({ kind: 'success', children: 'Nothing waiting -- casey is answering normally.' });
        const capped = j.total > rows.length;
        return h('div', {},
            capped ? Alert({ kind: 'info', children: `Showing the newest ${rows.length} of ${j.total} -- use Search or claim these first to bring the rest into view.` }) : null,
            Table({
                headers: ['Ref', 'Subject', 'Channel', 'Owner', 'Last event'],
                rows: rows.map((r) => [r.ref || '', r.subject || '(no subject)', r.channel || '', (r.assignee && r.assignee !== 'agent') ? r.assignee : '', fmtTime(r.last_event_at)]),
                onRowClick: (i) => { if (rows[i].id) setActiveId(rows[i].id); },
            }));
    });
    return Panel({ children: [body] });
}
