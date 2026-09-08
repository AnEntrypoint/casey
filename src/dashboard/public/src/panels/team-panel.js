// Team panel -- workload panel (open/stale-claims/replies-today/first-reply
// speed per rostered operator, worst-first). Content-swap panel
// (state.activePanel === 'team'). Table-based.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { Chip } from '/design/src/components/shell/atoms.js';
import { state } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchOperatorWorkload } from '../api.js';
import { fmtDur } from '../format.js';

const h = webjsx.createElement;

const loader = createPanelLoader({
    what: 'the team view',
    label: 'loading team workload',
    fetch: fetchOperatorWorkload,
    apply: (j) => { state._team = j; },
});

export function TeamPanel() {
    loader.ensureLoaded();
    const body = loader.slot(() => {
        const ops = (state._team && state._team.operators) || [];
        if (!ops.length) return Alert({ kind: 'info', children: 'No operators on the roster yet. Workload shows up here once accounts are added.' });
        const sorted = [...ops].sort((a, b) => (b.stale_claims || 0) - (a.stale_claims || 0) || (b.oldest_waiting_ms || 0) - (a.oldest_waiting_ms || 0));
        return Table({
            headers: ['Operator', 'Open', 'Stale', 'Replies today', 'Usual first reply', 'Oldest waiting'],
            rows: sorted.map((o) => [
                o.name || o.id,
                String(o.open_assigned || 0),
                o.stale_claims > 0 ? Chip({ tone: 'warn', size: 'sm', children: String(o.stale_claims) }) : '0',
                String(o.replies_24h || 0),
                fmtDur(o.first_reply_ms_median),
                fmtDur(o.oldest_waiting_ms),
            ]),
        });
    });
    return Panel({ children: [h('div', { class: 'ds-team-panel' }, body)] });
}
