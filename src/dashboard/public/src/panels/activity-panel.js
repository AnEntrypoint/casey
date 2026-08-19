// Activity panel -- event log with kind/actor filters. Content-swap panel
// (state.activePanel === 'activity'). Icon/tone-coded row list, same visual
// vocabulary as case-detail's Timeline (icons-map.js eventIcon/eventTone).

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Select } from '/design/src/components/content/fields.js';
import { Spinner, Alert } from '/design/src/components/content/feedback.js';
import { Btn, Chip } from '/design/src/components/shell/atoms.js';
import { Icon } from '/design/src/components/shell.js';
import { state, schedule, closePanel, setActiveId } from '../state.js';
import { fetchActivity } from '../api.js';
import { fmtTime, rel } from '../format.js';
import { eventIcon, eventTone } from '../icons-map.js';

const h = webjsx.createElement;

const ACT_KIND_LABEL = { inbound: 'Inbound', outbound: 'Reply', transition: 'Stage change', note: 'Note', observation: 'Note', action: 'Action', autonomy_change: 'Autonomy' };
const ACT_ACTOR_LABEL = { agent: 'casey', operator: 'Operator', contact: 'Contact', system: 'System' };

let loading = false, error = null;
let filters = { kind: '', actor: '' };

function ActivityRow(e, i) {
    return h('div', {
        key: e.id != null ? e.id : i,
        class: 'ds-activity-row ds-activity-tone--' + eventTone(e.kind),
        tabindex: e.case_id ? '0' : null,
        role: e.case_id ? 'button' : null,
        'aria-label': e.case_id ? 'open case for this event' : null,
        onclick: e.case_id ? () => setActiveId(e.case_id) : null,
        onkeydown: e.case_id ? (ev) => { if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); setActiveId(e.case_id); } } : null,
    },
        h('span', { class: 'ds-activity-icon' }, Icon(eventIcon(e.kind), { size: 14 })),
        h('div', { class: 'ds-activity-body' },
            h('div', { class: 'ds-activity-top' },
                Chip({ tone: eventTone(e.kind), size: 'sm', children: ACT_KIND_LABEL[e.kind] || e.kind }),
                h('span', { class: 'ds-activity-who' }, ACT_ACTOR_LABEL[e.actor] || e.actor || ''),
                h('span', { class: 'ds-activity-when', title: fmtTime(e.created_at) }, rel(e.created_at))),
            (e.text || '').trim() ? h('div', { class: 'ds-activity-text' }, (e.text || '').slice(0, 200)) : null));
}

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
            ? h('div', { class: 'ds-activity-list' }, ...ev.map((e, i) => ActivityRow(e, i)))
            : Alert({ kind: 'info', children: 'Nothing matches these filters.' });
    }
    return Panel({ title: 'Activity', children: [back, filterRow, body] });
}
