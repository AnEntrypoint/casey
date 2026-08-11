// Team panel -- workload panel (open/stale-claims/replies-today/first-reply
// speed per rostered operator, worst-first). Content-swap panel
// (state.activePanel === 'team'). Table-based.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { Spinner, Alert } from '/design/src/components/content/feedback.js';
import { Btn, Chip } from '/design/src/components/shell/atoms.js';
import { state, schedule, closePanel } from '../state.js';
import { fetchOperatorWorkload } from '../api.js';
import { fmtDur } from '../format.js';

const h = webjsx.createElement;

let loaded = false, loading = false, error = null;

function ensureLoaded() {
    if (loaded || loading) return;
    loading = true;
    fetchOperatorWorkload().then((j) => {
        state._team = j;
        loaded = true; loading = false; error = null; schedule();
    }).catch((e) => { loaded = true; loading = false; error = e.message || 'team view error'; schedule(); });
}

export function TeamPanel() {
    ensureLoaded();
    const back = Btn({ variant: 'ghost', children: 'Back to cases', onClick: closePanel });
    let body;
    if (loading && !loaded) body = Spinner({ label: 'loading team workload' });
    else if (error) body = Alert({ kind: 'error', children: 'Team-view error: ' + error });
    else {
        const ops = (state._team && state._team.operators) || [];
        if (!ops.length) body = Alert({ kind: 'info', children: 'No operators configured yet.' });
        else {
            const sorted = [...ops].sort((a, b) => (b.stale_claims || 0) - (a.stale_claims || 0) || (b.oldest_waiting_ms || 0) - (a.oldest_waiting_ms || 0));
            body = Table({
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
        }
    }
    return Panel({ title: 'Team workload', children: [back, body] });
}
