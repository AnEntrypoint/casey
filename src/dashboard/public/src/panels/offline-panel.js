// Offline panel -- missed-while-down queue. Content-swap panel
// (state.activePanel === 'offline'). Table-based.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { Spinner, Alert } from '/design/src/components/content/feedback.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { state, schedule, closePanel, setActiveId, setOfflineQueueCount } from '../state.js';
import { fetchUnreplied } from '../api.js';
import { fmtTime } from '../format.js';

const h = webjsx.createElement;

let loaded = false, loading = false, error = null;

function ensureLoaded() {
    if (loaded || loading) return;
    loading = true;
    fetchUnreplied().then((j) => {
        state._offline = j;
        setOfflineQueueCount(j && j.total || 0);
        loaded = true; loading = false; error = null; schedule();
    }).catch((e) => { loaded = true; loading = false; error = e.message || 'offline queue error'; schedule(); });
}

export function OfflinePanel() {
    ensureLoaded();
    const back = Btn({ variant: 'ghost', children: 'Back to cases', onClick: closePanel });
    let body;
    if (loading && !loaded) body = Spinner({ label: 'loading offline queue' });
    else if (error) body = Alert({ kind: 'error', children: 'Offline-queue error: ' + error });
    else {
        const j = state._offline;
        const rows = (j && j.items) || [];
        if (!rows.length) body = Alert({ kind: 'success', children: 'Nothing waiting -- casey is answering normally.' });
        else {
            const capped = j.total > rows.length;
            body = h('div', {},
                capped ? Alert({ kind: 'info', children: `Showing the newest ${rows.length} of ${j.total} -- use Search or claim these first to bring the rest into view.` }) : null,
                Table({
                    headers: ['Ref', 'Subject', 'Channel', 'Owner', 'Last event'],
                    rows: rows.map((r) => [r.ref || '', r.subject || '(no subject)', r.channel || '', (r.assignee && r.assignee !== 'agent') ? r.assignee : '', fmtTime(r.last_event_at)]),
                    onRowClick: (i) => { if (rows[i].id) setActiveId(rows[i].id); },
                }));
        }
    }
    return Panel({ title: 'Missed while offline', children: [back, body] });
}
