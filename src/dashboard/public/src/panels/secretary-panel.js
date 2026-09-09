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
//
// THE SEVEN FIELDS ARE THE POINT, so the form the queue takes depends on how
// much room there is to show all seven at once. See WIDE_ENOUGH below.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel, Section } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { DetailRow } from '/design/src/components/content/row.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { state, setActiveId, schedule } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchSecretaryQueue } from '../api.js';
import { fmtDur, fmtTime } from '../format.js';

const h = webjsx.createElement;

// Measured, not guessed. This panel's body box is the viewport less the
// shell's own chrome: 154px of stacked padding with no sidebar (below the
// shell's 901px breakpoint) and 490px with one. The seven-column table's
// intrinsic width is 569px, so it only has room from 1201px up (711px of
// body). Narrower than that the table does not shrink to fit -- it clips,
// and .ds-table-wrap's overflow scroll leaves nothing on screen saying the
// last four columns exist. A field worker on a 375px phone gets a body box
// of 221px, where a seven-column table is not a readable form at all, so
// below the threshold every case renders as a card carrying all seven
// fields with no scrolling in either axis.
const WIDE_ENOUGH = matchMedia('(min-width: 1201px)');
WIDE_ENOUGH.addEventListener('change', schedule);

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

const HEADERS = ['Ref', 'Subject', 'Channel', 'Assignee', 'Waiting', 'Why', 'Last update'];

// One case, as the same seven values the table's seven columns carry. Every
// value is present in both forms; neither form drops one.
function caseValues(c) {
    return [
        c.ref || '',
        c.subject || '(no subject)',
        c.channel || '',
        c.assignee || h('span', { class: 'ds-muted' }, 'unassigned'),
        fmtDur(c.wait_ms),
        c.reason || '',
        c.updated_at ? fmtTime(c.updated_at) : '',
    ];
}

function caseCard(c, key) {
    const vals = caseValues(c);
    const open = () => { if (c.id) setActiveId(c.id); };
    return h('div', { key }, Panel({
        // headingLevel 4: this card sits under the place Section's own
        // heading, which is itself under the panel's.
        title: vals[0] || '(no reference)', headingLevel: 4,
        right: Btn({ size: 'sm', variant: 'ghost', children: 'Open', onClick: open }),
        children: HEADERS.slice(1).map((label, i) => DetailRow({ key: label, label, value: vals[i + 1] })),
    }));
}

function placeSection(group) {
    const title = `${group.place} (${group.count})`;
    if (!WIDE_ENOUGH.matches) {
        return Section({ title, children: group.cases.map((c, i) => caseCard(c, c.id || i)) });
    }
    return Section({ title, children: [
        Table({
            headers: HEADERS,
            rows: group.cases.map(caseValues),
            onRowClick: (i) => { const c = group.cases[i]; if (c && c.id) setActiveId(c.id); },
        }),
    ]});
}

export function SecretaryPanel() {
    loader.ensureLoaded();
    const body = loader.slot(() => {
        const j = state._secretary;
        const places = (j && j.places) || [];
        // Neutral, not green: an empty call queue is a fact about the queue,
        // not a standing "everything is fine" about the deployment.
        if (!places.length) return Alert({ kind: 'info', children: 'Nothing waiting on a call right now.' });
        return h('div', {}, ...places.map(placeSection));
    });
    return Panel({ children: [filterBar(), body] });
}
