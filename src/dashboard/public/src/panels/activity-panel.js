// Activity panel -- event log with kind/actor filters. Content-swap panel
// (state.activePanel === 'activity'). Icon/tone-coded row list, same visual
// vocabulary as case-detail's Timeline (icons-map.js eventIcon/eventTone).

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Select } from '/design/src/components/content/fields.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { Chip } from '/design/src/components/shell/atoms.js';
import { Icon } from '/design/src/components/shell.js';
import { state, setActiveId } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchActivity } from '../api.js';
import { fmtTime, rel, eventKindLabel, eventKindOptions, actorLabel } from '../format.js';
import { eventIcon, eventTone } from '../icons-map.js';
import { entityLabel } from '../vocabulary.js';

const h = webjsx.createElement;

// kindLabel and the actor vocabulary used to live here, which meant
// handover-panel.js -- rendering the same two enums in its "Changed this shift"
// rows -- could not reach them and printed the raw keys. They are in format.js
// now, beside stageLabel and healthLabel, and this panel reads them from there.
const kindLabel = eventKindLabel;
function actorLabels() {
    return { agent: actorLabel('agent'), operator: 'Operator', contact: 'Contact', system: 'System' };
}

let filters = { kind: '', actor: '' };

// Both filters are SERVER-side narrowings, so changing either is a refetch --
// this fetch reads `filters` at call time rather than closing over one value.
const loader = createPanelLoader({
    what: 'the activity feed',
    label: 'loading activity',
    fetch: () => fetchActivity({ kind: filters.kind, actor: filters.actor, limit: 100 }),
    apply: (j) => { state._activity = j; },
});

function ActivityRow(e, i) {
    return h('div', {
        key: e.id != null ? e.id : i,
        class: 'ds-activity-row ds-activity-tone--' + eventTone(e.kind),
        tabindex: e.case_id ? '0' : null,
        role: e.case_id ? 'button' : null,
        'aria-label': e.case_id ? ('Open the ' + entityLabel() + ' this happened on') : null,
        onclick: e.case_id ? () => setActiveId(e.case_id) : null,
        onkeydown: e.case_id ? (ev) => { if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); setActiveId(e.case_id); } } : null,
    },
        h('span', { class: 'ds-activity-icon' }, Icon(eventIcon(e.kind), { size: 14 })),
        h('div', { class: 'ds-activity-body' },
            h('div', { class: 'ds-activity-top' },
                Chip({ tone: eventTone(e.kind), size: 'sm', children: kindLabel(e.kind) }),
                h('span', { class: 'ds-activity-who' }, actorLabel(e.actor)),
                h('span', { class: 'ds-activity-when', title: fmtTime(e.created_at) }, rel(e.created_at))),
            (e.text || '').trim() ? h('div', { class: 'ds-activity-text' }, (e.text || '').slice(0, 200)) : null));
}

export function ActivityPanel() {
    loader.ensureLoaded();
    const filterRow = h('div', { class: 'ds-activity-filters' },
        Select({
            key: 'k', placeholder: 'all kinds', value: filters.kind,
            options: eventKindOptions(),
            onChange: (v) => { filters.kind = v; loader.reload(); },
        }),
        Select({
            key: 'a', placeholder: 'all actors', value: filters.actor,
            options: Object.entries(actorLabels()).map(([id, label]) => ({ id, label })),
            onChange: (v) => { filters.actor = v; loader.reload(); },
        }));
    const body = loader.slot(() => {
        const ev = (state._activity && state._activity.events) || [];
        return ev.length
            ? h('div', { class: 'ds-activity-list' }, ...ev.map((e, i) => ActivityRow(e, i)))
            : Alert({ kind: 'info', children: 'Nothing matches these filters.' });
    });
    return Panel({ children: [filterRow, body] });
}
