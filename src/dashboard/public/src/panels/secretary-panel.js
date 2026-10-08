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
import { fmtDur, fmtTime, channelLabel, NO_TIME_TEXT } from '../format.js';
import { word } from '../words.js';

const h = webjsx.createElement;

const WIDE_ENOUGH = matchMedia('(min-width: 1201px)');
WIDE_ENOUGH.addEventListener('change', schedule);

let filter = 'all';
let query = '';

const loader = createPanelLoader({
    what: () => word('ui.secretary_panel_what'),
    label: () => word('ui.secretary_panel_loading'),
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
    return h('div', { class: 'ds-btn-row' }, opt('all', word('ui.secretary_panel_all')), ' ', opt('me', word('ui.secretary_panel_mine')), ' ', opt('unassigned', word('ui.secretary_panel_unassigned')));
}

const headers = () => [
    word('ui.secretary_panel_h_ref'),
    word('ui.secretary_panel_h_subject'),
    word('ui.secretary_panel_h_channel'),
    word('ui.secretary_panel_h_assignee'),
    word('ui.secretary_panel_h_waiting'),
    word('ui.secretary_panel_h_why'),
    word('ui.secretary_panel_h_last_update'),
];

function caseValues(c) {
    return [
        c.ref || '',
        c.subject || word('ui.secretary_panel_no_subject'),
        channelLabel(c.channel),
        assigneeName(c.assignee) || h('span', { class: 'ds-muted' }, word('ui.secretary_panel_unassigned_cell')),
        fmtDur(c.wait_ms),
        c.reason || '',
        fmtTime(c.updated_at) || NO_TIME_TEXT,
    ];
}

function caseCard(c, key) {
    const vals = caseValues(c);
    const open = () => { if (c.id) setActiveId(c.id); };
    const labels = headers();
    return h('div', { key }, Panel({
        title: vals[0] || word('ui.secretary_panel_no_reference'), headingLevel: 3,
        right: Btn({ size: 'sm', variant: 'ghost', children: word('ui.secretary_panel_open'), onClick: open }),
        children: labels.slice(1).map((label, i) => DetailRow({ key: label, label, value: vals[i + 1] })),
    }));
}

function placeSection(group) {
    const title = `${group.place} (${group.cases.length})`;
    if (!WIDE_ENOUGH.matches) {
        return Section({ title, children: group.cases.map((c, i) => caseCard(c, c.id || i)) });
    }
    return Section({ title, children: [
        Table({
            headers: headers(),
            rows: group.cases.map(caseValues),
            onRowClick: (i) => { const c = group.cases[i]; if (c && c.id) setActiveId(c.id); },
        }),
    ]});
}

function searchBar(resultCount) {
    return h('div', { class: 'ds-secretary-search' }, SearchInput({
        value: query,
        placeholder: word('ui.secretary_panel_search_placeholder'),
        label: word('ui.secretary_panel_search_label'),
        resultCount: word(resultCount === 1 ? 'ui.secretary_panel_result_one' : 'ui.secretary_panel_result_many', { count: resultCount }),
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
        if (!allPlaces.length) return Alert({ kind: 'info', children: word('ui.secretary_panel_none') });
        const places = allPlaces
            .map((group) => ({ ...group, cases: group.cases.filter((c) => matchesQuery(c, group.place)) }))
            .filter((group) => group.cases.length);
        total = places.reduce((n, g) => n + g.cases.length, 0);
        if (!places.length) return Alert({ kind: 'info', children: word('ui.secretary_panel_no_match', { query }) });
        return h('div', {}, ...places.map(placeSection));
    });
    return Panel({ children: [filterBar(), searchBar(total), body] });
}
