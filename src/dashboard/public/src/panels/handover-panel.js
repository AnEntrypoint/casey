import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel, Section } from '/design/src/components/content/panel.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { Btn, Chip } from '/design/src/components/shell/atoms.js';
import { state, schedule, setActiveId } from '../state.js';
import { assigneeName, loadRoster } from '../api-roles.js';
import { createPanelLoader } from './panel-load.js';
import { fetchHandover, postStartShift } from '../api.js';
import { fmtTime, eventKindLabel, actorLabel, NO_TIME_TEXT } from '../format.js';
import { queueName } from '../map-model.js';
import { toast } from '../toasts.js';
import { word } from '../words.js';

const SECTION_EMPTY_KEY = {
    queue: 'ui.handover_panel_empty_queue',
    handoffs: 'ui.handover_panel_empty_handoffs',
    drafts: 'ui.handover_panel_empty_drafts',
    touched: 'ui.handover_panel_empty_touched',
};

const h = webjsx.createElement;

let starting = false;

const loader = createPanelLoader({
    what: () => word('ui.handover_panel_what'),
    label: () => word('ui.handover_panel_loading'),
    fetch: fetchHandover,
    apply: (j) => { state._handover = j; },
});

async function startShift() {
    starting = true; schedule();
    try {
        await postStartShift();
        toast(word('ui.handover_panel_shift_started'), 'ok');
        loader.reload();
    } catch (e) { toast(word('ui.handover_panel_start_failed'), 'warn'); }
    starting = false; schedule();
}

function hoSection(title, emptyKey, rows, render) {
    if (!rows || !rows.length) {
        const empty = emptyKey && SECTION_EMPTY_KEY[emptyKey]
            ? word(SECTION_EMPTY_KEY[emptyKey])
            : word('ui.handover_panel_nothing_under', { title: title.toLowerCase() });
        return Section({ title, children: [Alert({ kind: 'info', children: empty })] });
    }
    return Section({ title: `${title} (${rows.length})`, children: rows.map(render) });
}

function refLink(ref, id) {
    if (!id) return h('span', { class: 'ds-ho-ref' }, ref || '');
    return h('span', {
        class: 'ds-ho-ref', tabindex: '0', role: 'button', 'aria-label': word('ui.handover_panel_open_ref', { ref: ref || '' }),
        onclick: () => setActiveId(id),
        onkeydown: (ev) => { if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); setActiveId(id); } },
    }, ref || '');
}

const holder = (a) => assigneeName(a);

function handoverBody(j) {
    loadRoster(schedule);
    return h('div', {},
        h('div', { class: 'ds-ho-since' }, word('ui.handover_panel_since', { when: j.since ? fmtTime(j.since) : word('ui.handover_panel_last_day') }) + (j.since_by ? ' (' + j.since_by + ')' : '')),
        hoSection(queueName(), 'queue', j.attention, (r, i) => h('div', { key: i, class: 'ds-ho-row' },
            refLink(r.ref, r.id), ' ', h('span', { class: 'ds-muted' }, r.subject || word('ui.handover_panel_no_subject')), ' ', h('span', { class: 'ds-ho-why' }, r.reason || ''),
            holder(r.assignee) ? h('span', { class: 'ds-ho-assignee' }, Chip({ tone: 'accent', size: 'sm', children: holder(r.assignee) })) : null)),
        hoSection(word('ui.handover_panel_handoffs_title'), 'handoffs', j.handoffs, (r, i) => h('div', { key: i, class: 'ds-ho-row' },
            refLink(r.ref, r.id), ' ', h('span', { class: 'ds-muted' }, r.subject || ''), ' ', h('span', { class: 'ds-ho-why' }, r.reason || ''))),
        hoSection(word('ui.handover_panel_drafts_title'), 'drafts', j.drafts, (r, i) => h('div', { key: i, class: 'ds-ho-row' },
            refLink(r.ref, r.id), ' ', h('span', { class: 'ds-muted' }, r.subject || ''), ' ', h('span', { class: 'ds-ho-why' }, (r.text || '').slice(0, 120)))),
        hoSection(word('ui.handover_panel_touched_title'), 'touched', j.touched, (r, i) => h('div', { key: i, class: 'ds-ho-row' },
            refLink(r.ref, r.id), ' ', h('span', { class: 'ds-muted' }, r.subject || ''),
            ' ', h('span', { class: 'ds-ho-why' }, (r.last_kind ? eventKindLabel(r.last_kind) : '') + (r.last_actor ? word('ui.handover_panel_by', { actor: actorLabel(r.last_actor) }) : '')),
            ' ', h('span', { class: 'ds-act-when' }, fmtTime(r.at) || NO_TIME_TEXT))));
}

export function HandoverPanel() {
    loader.ensureLoaded();
    const actions = h('div', { class: 'ds-ho-actions' },
        Btn({ variant: 'primary', children: starting ? word('ui.handover_panel_starting') : word('ui.handover_panel_start_shift'), disabled: starting, onClick: startShift }),
        ' ',
        h('a', { href: '/api/handover?format=html', class: 'ds-link', target: '_blank', rel: 'noopener' }, word('ui.handover_panel_printable')));
    const body = loader.slot(() => (state._handover
        ? handoverBody(state._handover)
        : Alert({ kind: 'warn', children: word('ui.handover_panel_load_failed') })));
    return Panel({ children: [actions, body] });
}
