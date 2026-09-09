// site-history.js -- visit-history-for-same-place panel: every OTHER case
// (open or closed) casey thinks describes the same real place. Isolated and
// best-effort like duplicate-suggestions.js -- a failure here must never
// break the case view.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Table } from '/design/src/components/content.js';
import { state, setSiteHistory } from '../../state.js';
import { fetchSiteHistory } from '../../api.js';
import { rel, stageLabel } from '../../format.js';
const h = webjsx.createElement;

export function loadSiteHistory(caseId) {
    fetchSiteHistory(caseId).then(j => setSiteHistory((j && j.visits) || [])).catch(() => setSiteHistory([]));
}

export function SiteHistoryPanel({ onOpenCase, key } = {}) {
    const visits = state.siteHistory;
    if (!visits || !visits.length) return null;
    const brand = state.config?.dashboard_ui?.brand || 'casey';
    // The middle column was `channel + ' - ' + status`, and status is the raw
    // thatcher key: this table printed "discord - triaging - reported 14d ago"
    // beside a case-detail view whose own rail says "Looking into it" for the
    // same stage. stageLabel() is the one stage vocabulary an operator reads,
    // and it belongs here too.
    const rows = visits.map(v => [
        h('button', { type: 'button', class: 'casey-linklike', onclick: () => onOpenCase && onOpenCase(v.id) }, v.ref),
        (v.channel || '') + ' - ' + (v.status ? stageLabel(v.status) : '') + ' - reported ' + rel(v.reported_at),
        (v.reasons || []).join(', ')
    ]);
    return h('div', { key, class: 'casey-site-history' },
        h('h3', {}, 'Visit history for this site'),
        // The literal 'casey' is the software, not the deployment somebody is
        // logged into -- every other operator-facing surface reads
        // dashboard_ui.brand, and this line was rendering "casey thinks" on a
        // screen branded Herd Health.
        h('p', { class: 'casey-hint' }, 'Other reports ' + brand + ' thinks are the same place, most recent first -- any reporter may have visited, not only whoever opened this case.'),
        Table({ headers: ['ref', 'when', 'why'], rows })
    );
}
