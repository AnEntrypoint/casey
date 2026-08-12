// Secretary follow-up panel -- worst-first breach queue grouped by normalized
// location, backed by GET /api/secretary/queue (src/dashboard/routes/
// operations.js). Pull-based only, matching casey's no-push-notify discipline.
// Content-swap panel (state.activePanel === 'secretary'). Click-through opens
// the real case for the phone number; the queue's own rows stay PII-free.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { Spinner, Alert } from '/design/src/components/content/feedback.js';
import { Btn, Chip } from '/design/src/components/shell/atoms.js';
import { state, schedule, closePanel } from '../state.js';
import { fetchSecretaryQueue } from '../api.js';
import { fmtDur, fmtTime } from '../format.js';
import { openCaseRoute } from '../route.js';

const h = webjsx.createElement;

let loaded = false, loading = false, error = null, filter = 'all';

function ensureLoaded() {
    if (loaded || loading) return;
    loading = true;
    fetchSecretaryQueue(filter === 'all' ? undefined : filter).then((j) => {
        state._secretaryQueue = j;
        loaded = true; loading = false; error = null; schedule();
    }).catch((e) => { loaded = true; loading = false; error = e.message || 'secretary queue error'; schedule(); });
}

function setFilter(f) {
    if (f === filter) return;
    filter = f; loaded = false; loading = false;
    ensureLoaded(); schedule();
}

function placeTable(group) {
    return Table({
        headers: ['Case', 'Channel', 'Status', 'Assignee', 'Waiting', 'Updated', ''],
        rows: group.cases.map((c) => [
            c.subject || c.ref,
            c.channel || '',
            Chip({ children: c.status || '' }),
            c.assignee || Chip({ tone: 'warn', children: 'unassigned' }),
            fmtDur(c.wait_ms),
            fmtTime(c.updated_at),
            Btn({ size: 'sm', children: 'Open', onClick: () => openCaseRoute(c.id) }),
        ]),
    });
}

export function SecretaryPanel() {
    ensureLoaded();
    const back = Btn({ variant: 'ghost', children: 'Back to cases', onClick: closePanel });
    const seg = h('div', { class: 'ds-secretary-filter' },
        Btn({ size: 'sm', variant: filter === 'all' ? 'default' : 'ghost', children: 'All', onClick: () => setFilter('all') }),
        Btn({ size: 'sm', variant: filter === 'me' ? 'default' : 'ghost', children: 'Mine', onClick: () => setFilter('me') }),
        Btn({ size: 'sm', variant: filter === 'unassigned' ? 'default' : 'ghost', children: 'Unassigned', onClick: () => setFilter('unassigned') }));
    let body;
    if (loading && !loaded) body = Spinner({ label: 'loading follow-up queue' });
    else if (error) body = Alert({ kind: 'error', children: 'Follow-up queue error: ' + error });
    else {
        const places = (state._secretaryQueue && state._secretaryQueue.places) || [];
        if (!places.length) body = Alert({ kind: 'info', children: 'Nothing waiting on follow-up right now.' });
        else body = h('div', { class: 'ds-secretary-places' },
            ...places.map((g) => h('div', { class: 'ds-secretary-group' },
                h('h3', {}, `${g.place} (${g.count})`),
                placeTable(g))));
    }
    return Panel({ title: 'Follow-up calls', children: [back, seg, body] });
}
