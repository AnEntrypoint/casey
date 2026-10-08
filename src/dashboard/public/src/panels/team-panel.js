import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { DetailRow } from '/design/src/components/content/row.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { Chip } from '/design/src/components/shell/atoms.js';
import { state, schedule } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchOperatorWorkload } from '../api.js';
import { fmtDur } from '../format.js';
import { word } from '../words.js';

const h = webjsx.createElement;

const WIDE_ENOUGH = matchMedia('(min-width: 1201px)');
WIDE_ENOUGH.addEventListener('change', schedule);

const loader = createPanelLoader({
    what: () => word('ui.team_panel_what'),
    label: () => word('ui.team_panel_loading'),
    fetch: fetchOperatorWorkload,
    apply: (j) => { state._team = j; },
});

const headers = () => [
    word('ui.team_panel_h_operator'),
    word('ui.team_panel_h_open'),
    word('ui.team_panel_h_stale'),
    word('ui.team_panel_h_replies_today'),
    word('ui.team_panel_h_usual_first_reply'),
    word('ui.team_panel_h_oldest_waiting'),
];

function operatorValues(o) {
    return [
        o.name || o.id,
        String(o.open_assigned || 0),
        o.stale_claims > 0 ? Chip({ tone: 'warn', size: 'sm', children: String(o.stale_claims) }) : '0',
        String(o.replies_24h || 0),
        fmtDur(o.first_reply_ms_median),
        fmtDur(o.oldest_waiting_ms),
    ];
}

function operatorCard(o, key) {
    const vals = operatorValues(o);
    const labels = headers();
    return h('div', { key }, Panel({
        title: vals[0], headingLevel: 2,
        children: labels.slice(1).map((label, i) => DetailRow({ key: label, label, value: vals[i + 1] })),
    }));
}

export function TeamPanel() {
    loader.ensureLoaded();
    const body = loader.slot(() => {
        const ops = (state._team && state._team.operators) || [];
        if (!ops.length) return Alert({ kind: 'info', children: word('ui.team_panel_none') });
        const sorted = [...ops].sort((a, b) => (b.stale_claims || 0) - (a.stale_claims || 0) || (b.oldest_waiting_ms || 0) - (a.oldest_waiting_ms || 0));
        if (!WIDE_ENOUGH.matches) {
            return h('div', {}, ...sorted.map((o, i) => operatorCard(o, o.id || i)));
        }
        return Table({ headers: headers(), rows: sorted.map(operatorValues) });
    });
    return Panel({ children: [body] });
}
