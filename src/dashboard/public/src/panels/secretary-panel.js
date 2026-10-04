import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel, Section } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { DetailRow } from '/design/src/components/content/row.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { SearchInput } from 'ds/components/content.js';
import { state, setActiveId, schedule } from '../state.js';
import { assigneeName, loadRoster } from '../api-roles.js';
import { createPanelLoader } from './panel-load.js';
import { fetchSecretaryQueue } from '../api.js';
import { fmtDur, fmtTime, channelLabel } from '../format.js';

const h = webjsx.createElement;

const WIDE_ENOUGH = matchMedia('(min-width: 1201px)');
WIDE_ENOUGH.addEventListener('change', schedule);

let filter = 'all';
let query = '';

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

function setQuery(v) {
    query = v;
    schedule();
}

function matchesQuery(c, place) {
    if (!query) return true;
    const hay = [c.ref, c.subject, c.reason, c.assignee, place].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(query.toLowerCase());
}

function filterBar() {
    const opt = (val, label) => Btn({
        size: 'sm', variant: filter === val ? 'primary' : 'ghost', children: label, onClick: () => setFilter(val),
    });
    return h('div', { class: 'ds-btn-row' }, opt('all', 'All'), ' ', opt('me', 'Mine'), ' ', opt('unassigned', 'Unassigned'));
}

const HEADERS = ['Ref', 'Subject', 'Channel', 'Assignee', 'Waiting', 'Why', 'Last update'];

function caseValues(c) {
    return [
        c.ref || '',
        c.subject || '(no subject)',
        channelLabel(c.channel),
        assigneeName(c.assignee) || h('span', { class: 'ds-muted' }, 'unassigned'),
        fmtDur(c.wait_ms),
        c.reason || '',
        c.updated_at ? fmtTime(c.updated_at) : '',
    ];
}

function caseCard(c, key) {
    const vals = caseValues(c);
    const open = () => { if (c.id) setActiveId(c.id); };
    return h('div', { key }, Panel({
        title: vals[0] || '(no reference)', headingLevel: 3,
        right: Btn({ size: 'sm', variant: 'ghost', children: 'Open', onClick: open }),
        children: HEADERS.slice(1).map((label, i) => DetailRow({ key: label, label, value: vals[i + 1] })),
    }));
}

function placeSection(group) {
    const title = `${group.place} (${group.cases.length})`;
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

function searchBar(resultCount) {
    return h('div', { class: 'ds-secretary-search' }, SearchInput({
        value: query,
        placeholder: 'Search a reference, farmer, place or reason',
        label: 'Search the follow-up queue',
        resultCount: resultCount + ' result' + (resultCount === 1 ? '' : 's'),
        onInput: setQuery,
    }));
}

export function SecretaryPanel() {
    loader.ensureLoaded();
    loadRoster(schedule);
    let total = 0;
    const body = loader.slot(() => {
        const j = state._secretary;
        const allPlaces = (j && j.places) || [];
        if (!allPlaces.length) return Alert({ kind: 'info', children: 'Nothing waiting on a call right now.' });
        const places = allPlaces
            .map((group) => ({ ...group, cases: group.cases.filter((c) => matchesQuery(c, group.place)) }))
            .filter((group) => group.cases.length);
        total = places.reduce((n, g) => n + g.cases.length, 0);
        if (!places.length) return Alert({ kind: 'info', children: 'No follow-up case matches "' + query + '".' });
        return h('div', {}, ...places.map(placeSection));
    });
    return Panel({ children: [filterBar(), searchBar(total), body] });
}
