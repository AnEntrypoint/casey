// Stats panel -- fill-rate by intake source. Rendered inside dialog-shell's
// Dialog as a modal (state.activeModal === 'stats'), per architecture spec
// section 4. Fetches on open only.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { state } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchStats } from '../api.js';

const h = webjsx.createElement;

const MODE_LABEL = { channel: 'AI (channel)', manual: 'Operator entry', public_form: 'Public form', unknown: 'Untagged' };

const loader = createPanelLoader({
    what: 'the summary numbers',
    label: 'loading stats',
    fetch: fetchStats,
    apply: (j) => { state._stats = j; },
});

// All three completion metrics use the same "N/total (P%)" shape so
// adjacent columns read as one consistent notation instead of three
// (average / bare fraction / fraction-with-percent).
function statRow(mode, s) {
    const fieldsPct = s.total_fields ? Math.round(((s.avg_filled ?? 0) / s.total_fields) * 100) : 0;
    const vcPct = s.vc_total ? Math.round((s.vc_complete / s.count) * 100) : 0;
    const vcAlarm = s.count > 0 && s.vc_complete === 0;
    const essentialPct = s.vc_total ? Math.round(((s.avg_vc_filled ?? 0) / s.vc_total) * 100) : 0;
    return [
        MODE_LABEL[mode] || mode,
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
        if (!modes.length) return Alert({ kind: 'info', children: 'No intake data yet. Fill-rate breakdown shows up here once reports start coming in.' });
        return Table({
            headers: ['Source', 'Count', 'Fields', 'Visit-ready', 'Essential'],
            rows: modes.map((m) => statRow(m, j.by_mode[m])),
        });
    });
    return h('div', { class: 'ds-stats-panel' }, Panel({ title: 'Intake stats', children: [body] }));
}
