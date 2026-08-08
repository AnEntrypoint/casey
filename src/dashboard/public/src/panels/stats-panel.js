// Stats panel -- fill-rate by intake source. Rendered inside dialog-shell's
// Dialog as a modal (state.activeModal === 'stats'), per architecture spec
// section 4. Fetches on open only.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Spinner } from '/design/src/components/content/feedback.js';
import { Table } from '/design/src/components/content/table.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { state, schedule } from '../state.js';
import { fetchStats } from '../api.js';

const h = webjsx.createElement;

const MODE_LABEL = { channel: 'AI (channel)', manual: 'Operator entry', public_form: 'Public form', unknown: 'Untagged' };

let loaded = false;
let loading = false;
let error = null;

function ensureLoaded() {
    if (loaded || loading) return;
    loading = true;
    fetchStats().then((j) => {
        state._stats = j;
        loaded = true; loading = false; error = null; schedule();
    }).catch((e) => {
        loaded = true; loading = false; error = e.message || 'stats error'; schedule();
    });
}

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
    ensureLoaded();
    let body;
    if (loading && !loaded) body = Spinner({ label: 'loading stats' });
    else if (error) body = Alert({ kind: 'error', children: 'Stats error: ' + error });
    else {
        const j = state._stats;
        const modes = j ? Object.keys(j.by_mode || {}) : [];
        if (!modes.length) body = Alert({ kind: 'info', children: 'No data yet.' });
        else body = Table({
            headers: ['Source', 'Count', 'Fields', 'Visit-ready', 'Essential'],
            rows: modes.map((m) => statRow(m, j.by_mode[m])),
        });
    }
    return h('div', { class: 'ds-stats-panel' }, Panel({ title: 'Intake stats', children: [body] }));
}
