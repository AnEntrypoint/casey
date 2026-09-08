// Team panel -- workload panel (open/stale-claims/replies-today/first-reply
// speed per rostered operator, worst-first). Content-swap panel
// (state.activePanel === 'team').
//
// Six figures per operator, and "replies today" is one of them, so the form
// depends on how much room there is to show all six at once. See WIDE_ENOUGH.

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

const h = webjsx.createElement;

// Measured, not guessed. This panel's body box is the viewport less the
// shell's own chrome: 154px of stacked padding with no sidebar (below the
// shell's 901px breakpoint) and 490px with one. The six-column table's
// intrinsic width is 651px, so it only has room from 1201px up (711px of
// body). Narrower than that the table clips instead of shrinking, and
// .ds-table-wrap's overflow scroll leaves nothing on screen saying the
// clipped columns exist -- on a 375px phone the body box is 221px and
// "replies today" was off the edge entirely. Below the threshold each
// operator renders as a card carrying all six figures.
const WIDE_ENOUGH = matchMedia('(min-width: 1201px)');
WIDE_ENOUGH.addEventListener('change', schedule);

const loader = createPanelLoader({
    what: 'the team view',
    label: 'loading team workload',
    fetch: fetchOperatorWorkload,
    apply: (j) => { state._team = j; },
});

const HEADERS = ['Operator', 'Open', 'Stale', 'Replies today', 'Usual first reply', 'Oldest waiting'];

// One operator, as the same six values the table's six columns carry.
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
    return h('div', { key }, Panel({
        title: vals[0], headingLevel: 3,
        children: HEADERS.slice(1).map((label, i) => DetailRow({ key: label, label, value: vals[i + 1] })),
    }));
}

export function TeamPanel() {
    loader.ensureLoaded();
    const body = loader.slot(() => {
        const ops = (state._team && state._team.operators) || [];
        if (!ops.length) return Alert({ kind: 'info', children: 'No operators on the roster yet. Workload shows up here once accounts are added.' });
        const sorted = [...ops].sort((a, b) => (b.stale_claims || 0) - (a.stale_claims || 0) || (b.oldest_waiting_ms || 0) - (a.oldest_waiting_ms || 0));
        if (!WIDE_ENOUGH.matches) {
            return h('div', {}, ...sorted.map((o, i) => operatorCard(o, o.id || i)));
        }
        return Table({ headers: HEADERS, rows: sorted.map(operatorValues) });
    });
    return Panel({ children: [h('div', { class: 'ds-team-panel' }, body)] });
}
