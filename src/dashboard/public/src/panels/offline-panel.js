import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { state, setActiveId, setOfflineQueueCount } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchUnreplied } from '../api.js';
import { fmtTime, channelLabel } from '../format.js';
import { word } from '../words.js';

const h = webjsx.createElement;

const loader = createPanelLoader({
    what: () => word('ui.offline_panel_what'),
    label: () => word('ui.offline_panel_loading'),
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
        if (!rows.length) return Alert({ kind: 'info', children: word('ui.offline_panel_none') });
        const capped = j.total > rows.length;
        return h('div', {},
            capped ? Alert({ kind: 'info', children: word('ui.offline_panel_capped', { shown: rows.length, total: j.total }) }) : null,
            Table({
                headers: [word('ui.offline_panel_h_ref'), word('ui.offline_panel_h_subject'), word('ui.offline_panel_h_channel'), word('ui.offline_panel_h_owner'), word('ui.offline_panel_h_last_event')],
                rows: rows.map((r) => [r.ref || '', r.subject || word('ui.offline_panel_no_subject'), channelLabel(r.channel), (r.assignee && r.assignee !== 'agent') ? r.assignee : '', fmtTime(r.last_event_at)]),
                onRowClick: (i) => { if (rows[i].id) setActiveId(rows[i].id); },
            }));
    });
    return Panel({ children: [body] });
}
