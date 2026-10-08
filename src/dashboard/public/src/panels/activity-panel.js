import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Select } from '/design/src/components/content/fields.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { LogRow } from '/design/src/components/content/row.js';
import { Icon } from '/design/src/components/shell.js';
import { state, setActiveId } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchActivity } from '../api.js';
import { fmtTime, rel, eventKindLabel, eventKindOptions, actorLabel } from '../format.js';
import { eventIcon, eventTone } from '../icons-map.js';
import { word } from '../words.js';

const h = webjsx.createElement;

const kindLabel = eventKindLabel;
function actorLabels() {
    return { agent: actorLabel('agent'), operator: word('ui.activity_panel_actor_operator'), contact: word('ui.activity_panel_actor_contact'), system: word('ui.activity_panel_actor_system') };
}

let filters = { kind: '', actor: '' };

const loader = createPanelLoader({
    what: () => word('ui.activity_panel_what'),
    label: () => word('ui.activity_panel_loading'),
    fetch: () => fetchActivity({ kind: filters.kind, actor: filters.actor, limit: 100 }),
    apply: (j) => { state._activity = j; },
});

function ActivityRow(e, i) {
    const row = LogRow({
        kind: e.kind, tone: eventTone(e.kind),
        leading: Icon(eventIcon(e.kind), { size: 14 }),
        label: kindLabel(e.kind),
        text: (e.text || '').trim().slice(0, 200) || actorLabel(e.actor),
        meta: h('span', { title: fmtTime(e.created_at) }, actorLabel(e.actor) + ' - ' + rel(e.created_at)),
    });
    if (!e.case_id) return h('div', { key: e.id != null ? e.id : i }, row);
    return h('div', {
        key: e.id != null ? e.id : i, class: 'ds-activity-link', tabindex: '0', role: 'button',
        'aria-label': word('ui.activity_panel_open_entity'),
        onclick: () => setActiveId(e.case_id),
        onkeydown: (ev) => { if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); setActiveId(e.case_id); } },
    }, row);
}

export function ActivityPanel() {
    loader.ensureLoaded();
    const filterRow = h('div', { class: 'ds-btn-row ds-activity-filters' },
        Select({
            key: 'k', placeholder: word('ui.activity_panel_all_kinds'), value: filters.kind,
            options: eventKindOptions(),
            onChange: (v) => { filters.kind = v; loader.reload(); },
        }),
        Select({
            key: 'a', placeholder: word('ui.activity_panel_all_actors'), value: filters.actor,
            options: Object.entries(actorLabels()).map(([id, label]) => ({ id, label })),
            onChange: (v) => { filters.actor = v; loader.reload(); },
        }));
    const body = loader.slot(() => {
        const ev = (state._activity && state._activity.events) || [];
        return ev.length
            ? h('div', {}, ...ev.map((e, i) => ActivityRow(e, i)))
            : Alert({ kind: 'info', children: word('ui.activity_panel_no_matches') });
    });
    return Panel({ children: [filterRow, body] });
}
