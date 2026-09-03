// site-history.js -- visit-history-for-same-place panel: every OTHER case
// (open or closed) casey thinks describes the same real place. Isolated and
// best-effort like duplicate-suggestions.js -- a failure here must never
// break the case view.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Table } from '/design/src/components/content.js';
import { state, schedule, setSiteHistory } from '../../state.js';
import { fetchSiteHistory } from '../../api.js';
import { rel } from '../../format.js';
const h = webjsx.createElement;

export function loadSiteHistory(caseId) {
    fetchSiteHistory(caseId).then(j => setSiteHistory((j && j.visits) || [])).catch(() => setSiteHistory([]));
}

export function SiteHistoryPanel({ onOpenCase, key } = {}) {
    const visits = state.siteHistory;
    if (!visits || !visits.length) return null;
    const rows = visits.map(v => [
        h('button', { type: 'button', class: 'casey-linklike', onclick: () => onOpenCase && onOpenCase(v.id) }, v.ref),
        (v.channel || '') + ' - ' + (v.status || '') + ' - reported ' + rel(v.reported_at),
        (v.reasons || []).join(', ')
    ]);
    return h('div', { key, class: 'casey-site-history' },
        h('h3', {}, 'Visit history for this site'),
        h('p', { class: 'casey-hint' }, 'Other reports casey thinks are the same place, most recent first -- any reporter may have visited, not only whoever opened this case.'),
        Table({ headers: ['ref', 'when', 'why'], rows })
    );
}
