// Secretary panel -- the phone-follow-up queue for staff dedicated to calling
// reporters back on loose ends (2026-08 Herd Health kickoff dev notes, STEP 3:
// "we want to set up a secretarial view for people who are dedicated to
// contact people over the phone to follow up"). Backs onto the same
// rankAttention/classifyCaseHealth breach list the operator inbox uses
// (GET /api/secretary/queue), grouped server-side by normalized
// report.location so a caller sees "N dropped in Bizana, M in Lusikisiki"
// instead of a flat list. Pull-based only -- casey never pushes a WhatsApp
// notification for this (WhatsApp's per-message fee structure), so this view
// IS the follow-up mechanism: a secretary opens it, sees who to phone, and
// calls. Content-swap panel (state.activePanel === 'secretary'). Row click
// opens the case (via setActiveId, same convention as offline/clusters
// panels) where the real phone number is available as a tel: link.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel, Section } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { state, setActiveId } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchSecretaryQueue } from '../api.js';
import { fmtDur, fmtTime } from '../format.js';

const h = webjsx.createElement;

let filter = 'all';

// The assignee filter is a SERVER-side narrowing, so changing it is a refetch
// rather than a filter over what is already loaded -- which is why this fetch
// reads `filter` at call time instead of closing over one value.
const loader = createPanelLoader({
    what: 'the follow-up list',
    label: 'loading follow-up queue',
    fetch: () => fetchSecretaryQueue({ assignee: filter === 'all' ? undefined : filter }),
    apply: (j) => { state._secretary = j; },
});

function setFilter(f) {
    if (f === filter) return;
    filter = f;
    loader.reload();
}

function filterBar() {
    const opt = (val, label) => Btn({
        size: 'sm', variant: filter === val ? 'primary' : 'ghost', children: label, onClick: () => setFilter(val),
    });
    return h('div', { class: 'ds-secretary-filters' }, opt('all', 'All'), ' ', opt('me', 'Mine'), ' ', opt('unassigned', 'Unassigned'));
}

function placeSection(group) {
    const rows = group.cases.map((c) => [
        c.ref || '', c.subject || '(no subject)', c.channel || '',
        c.assignee || h('span', { class: 'ds-muted' }, 'unassigned'),
        fmtDur(c.wait_ms), c.reason || '', c.updated_at ? fmtTime(c.updated_at) : '',
    ]);
    return Section({ title: `${group.place} (${group.count})`, children: [
        Table({
            headers: ['Ref', 'Subject', 'Channel', 'Assignee', 'Waiting', 'Why', 'Last update'],
            rows,
            onRowClick: (i) => { const c = group.cases[i]; if (c && c.id) setActiveId(c.id); },
        }),
    ]});
}

export function SecretaryPanel() {
    loader.ensureLoaded();
    const body = loader.slot(() => {
        const j = state._secretary;
        const places = (j && j.places) || [];
        if (!places.length) return Alert({ kind: 'success', children: 'Nothing waiting on a call right now.' });
        return h('div', {}, ...places.map(placeSection));
    });
    return Panel({ children: [filterBar(), body] });
}
