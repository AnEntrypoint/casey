// Activity panel -- event log with kind/actor filters. Content-swap panel
// (state.activePanel === 'activity'). Table-based, paginated load-older.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Select } from '/design/src/components/content/fields.js';
import { Table } from '/design/src/components/content/table.js';
import { Spinner, Alert } from '/design/src/components/content/feedback.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { state, schedule, closePanel, setActiveId } from '../state.js';
import { fetchActivity } from '../api.js';
import { fmtTime } from '../format.js';

const h = webjsx.createElement;

const ACT_KIND_LABEL = { inbound: 'Inbound', outbound: 'Reply', transition: 'Stage change', note: 'Note', observation: 'Note', action: 'Action', autonomy_change: 'Autonomy' };
const ACT_ACTOR_LABEL = { agent: 'casey', operator: 'Operator', contact: 'Contact', system: 'System' };

let loading = false, error = null;
let filters = { kind: '', actor: '' };

function load() {
    loading = true; schedule();
    fetchActivity({ kind: filters.kind, actor: filters.actor, limit: 100 }).then((j) => {
        state._activity = j;
        loading = false; error = null; schedule();
    }).catch((e) => { loading = false; error = e.message || 'activity error'; schedule(); });
}

let started = false;
function ensureLoaded() { if (!started) { started = true; load(); } }

export function ActivityPanel() {
    ensureLoaded();
    const back = Btn({ variant: 'ghost', children: 'Back to cases', onClick: closePanel });
    const filterRow = h('div', { class: 'ds-activity-filters' },
        Select({
            key: 'k', placeholder: 'all kinds', value: filters.kind,
            options: Object.entries(ACT_KIND_LABEL).map(([id, label]) => ({ id, label })),
            onChange: (v) => { filters.kind = v; load(); },
        }),
        Select({
            key: 'a', placeholder: 'all actors', value: filters.actor,
            options: Object.entries(ACT_ACTOR_LABEL).map(([id, label]) => ({ id, label })),
            onChange: (v) => { filters.actor = v; load(); },
        }));
    let body;
    if (loading) body = Spinner({ label: 'loading activity' });
    else if (error) body = Alert({ kind: 'error', children: 'Activity error: ' + error });
    else {
        const ev = (state._activity && state._activity.events) || [];
        body = ev.length
            ? Table({
                headers: ['When', 'Kind', 'Who', 'Text'],
                rows: ev.map((e) => [fmtTime(e.created_at), ACT_KIND_LABEL[e.kind] || e.kind, ACT_ACTOR_LABEL[e.actor] || e.actor || '', (e.text || '').slice(0, 160)]),
                onRowClick: (i) => { if (ev[i].case_id) setActiveId(ev[i].case_id); },
            })
            : Alert({ kind: 'info', children: 'Nothing matches.' });
    }
    return Panel({ title: 'Activity', children: [back, filterRow, body] });
}
