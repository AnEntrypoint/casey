import * as webjsx from '/design/vendor/webjsx/index.js';
import { Table } from '/design/src/components/content.js';
import { Btn } from '/design/src/components/shell.js';
import { state, setSiteHistory } from '../../state.js';
import { fetchSiteHistory } from '../../api.js';
import { rel, stageLabel, channelLabel } from '../../format.js';
import { brandName, entityLabelPlural } from '../../vocabulary.js';
import { word } from '../../words.js';
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
        word('ui.site_history_row', { channel: channelLabel(v.channel), stage: v.status ? stageLabel(v.status) : '', when: rel(v.reported_at) }),
        (v.reasons || []).join(', ')
    ]);
    return h('div', { key, class: 'casey-site-history' },
        h('h3', {}, word('ui.site_history_heading')),
        h('p', { class: 'casey-hint' }, word('ui.site_history_lead', { entity_plural: entityLabelPlural(), brand })),
        Table({ headers: [word('ui.site_history_col_ref'), word('ui.site_history_col_when'), word('ui.site_history_col_why')], rows })
    );
}
