import * as webjsx from '/design/vendor/webjsx/index.js';
import { Table } from '/design/src/components/content.js';
import { Btn } from '/design/src/components/shell.js';
import { state, setSiteHistory } from '../../state.js';
import { fetchSiteHistory } from '../../api.js';
import { rel, stageLabel, channelLabel } from '../../format.js';
import { brandName, entityLabelPlural } from '../../vocabulary.js';
const h = webjsx.createElement;

export function loadSiteHistory(caseId) {
    fetchSiteHistory(caseId).then(j => setSiteHistory((j && j.visits) || [])).catch(() => setSiteHistory([]));
}

export function SiteHistoryPanel({ onOpenCase, key } = {}) {
    const visits = state.siteHistory;
    if (!visits || !visits.length) return null;
    const brand = brandName();
    const rows = visits.map(v => [
        Btn({ variant: 'link', size: 'sm', onClick: () => onOpenCase && onOpenCase(v.id), children: v.ref }),
        channelLabel(v.channel) + ' - ' + (v.status ? stageLabel(v.status) : '') + ' - reported ' + rel(v.reported_at),
        (v.reasons || []).join(', ')
    ]);
    return h('div', { key, class: 'casey-site-history' },
        h('h3', {}, 'Visit history for this site'),
        h('p', { class: 'casey-hint' }, 'Other ' + entityLabelPlural() + ' ' + brand + ' thinks are the same place, most recent first -- any reporter may have visited, not only whoever opened this one.'),
        Table({ headers: ['Reference', 'When', 'Why it matched'], rows })
    );
}
