import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { state } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchStats } from '../api.js';
import { word } from '../words.js';

const h = webjsx.createElement;

const MODE_KEY = { channel: 'ui.stats_panel_mode_channel', manual: 'ui.stats_panel_mode_manual', public_form: 'ui.stats_panel_mode_public_form', unknown: 'ui.stats_panel_mode_unknown' };
const modeLabel = (m) => (MODE_KEY[m] ? word(MODE_KEY[m]) : m);

const loader = createPanelLoader({
    what: () => word('ui.stats_panel_what'),
    label: () => word('ui.stats_panel_loading'),
    fetch: fetchStats,
    apply: (j) => { state._stats = j; },
});

function statRow(mode, s) {
    const fieldsPct = s.total_fields ? Math.round(((s.avg_filled ?? 0) / s.total_fields) * 100) : 0;
    const vcPct = s.vc_total ? Math.round((s.vc_complete / s.count) * 100) : 0;
    const vcAlarm = s.count > 0 && s.vc_complete === 0;
    const essentialPct = s.vc_total ? Math.round(((s.avg_vc_filled ?? 0) / s.vc_total) * 100) : 0;
    return [
        modeLabel(mode),
        String(s.count),
        `${s.avg_filled ?? '-'}/${s.total_fields} (${fieldsPct}%)`,
        (vcAlarm ? '0' : String(s.vc_complete)) + `/${s.count} (${vcPct}%)`,
        `${s.avg_vc_filled ?? '-'}/${s.vc_total} (${essentialPct}%)`,
    ];
}

export function StatsPanel() {
    loader.ensureLoaded();
    const body = loader.slot(() => {
        const j = state._stats;
        const modes = j ? Object.keys(j.by_mode || {}) : [];
        if (!modes.length) return Alert({ kind: 'info', children: word('ui.stats_panel_none') });
        return Table({
            headers: [word('ui.stats_panel_h_source'), word('ui.stats_panel_h_count'), word('ui.stats_panel_h_fields'), word('ui.stats_panel_h_visit_ready'), word('ui.stats_panel_h_essential')],
            rows: modes.map((m) => statRow(m, j.by_mode[m])),
        });
    });
    return Panel({ title: word('ui.stats_panel_title'), children: [body] });
}
