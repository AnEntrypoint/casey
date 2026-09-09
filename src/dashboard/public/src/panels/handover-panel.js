// Handover panel -- shift digest + start-shift + printable link. Content-swap
// panel (state.activePanel === 'handover'). Panel/Receipt-based.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel, Section } from '/design/src/components/content/panel.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { Btn, Chip } from '/design/src/components/shell/atoms.js';
import { state, schedule, setActiveId } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchHandover, postStartShift } from '../api.js';
import { fmtTime } from '../format.js';
import { QUEUE_NAME } from '../map-model.js';
import { toast } from '../toasts.js';

const SECTION_EMPTY_TEXT = {
    [QUEUE_NAME]: 'Nothing needs a person right now.',
    'Open handoffs': 'No open handoffs.',
    'Unsent drafts': 'No unsent drafts.',
    'Changed this shift': 'Nothing has changed yet this shift.',
};

const h = webjsx.createElement;

let starting = false;

const loader = createPanelLoader({
    what: 'the handover',
    label: 'loading handover digest',
    fetch: fetchHandover,
    apply: (j) => { state._handover = j; },
});

async function startShift() {
    starting = true; schedule();
    try {
        await postStartShift();
        toast('Shift started -- "changed this shift" counts from now', 'ok');
        // Every "since" figure on this page is measured from the shift start
        // that call just moved, so the digest on screen is now wrong.
        loader.reload();
    } catch (e) { toast('Could not start the shift', 'warn'); }
    starting = false; schedule();
}

function hoSection(title, rows, render) {
    // The fallback is a sentence for the same reason each named one is: a bare
    // "None." leaves the reader to work out none of WHAT, under a heading they
    // may have skimmed past.
    if (!rows || !rows.length) return Section({ title, children: [Alert({ kind: 'info', children: SECTION_EMPTY_TEXT[title] || `Nothing under ${title.toLowerCase()} right now.` })] });
    return Section({ title: `${title} (${rows.length})`, children: rows.map(render) });
}

function refLink(ref, id) {
    if (!id) return h('span', { class: 'ds-ho-ref' }, ref || '');
    return h('span', {
        class: 'ds-ho-ref', tabindex: '0', role: 'button', 'aria-label': 'open case ' + (ref || ''),
        onclick: () => setActiveId(id),
        onkeydown: (ev) => { if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); setActiveId(id); } },
    }, ref || '');
}

function handoverBody(j) {
    return h('div', {},
        h('div', { class: 'ds-ho-since' }, `Since ${j.since ? fmtTime(j.since) : 'the last day'}${j.since_by ? ' (' + j.since_by + ')' : ''}`),
        hoSection(QUEUE_NAME, j.attention, (r, i) => h('div', { key: i, class: 'ds-ho-row' },
            refLink(r.ref, r.id), ' ', h('span', { class: 'ds-muted' }, r.subject || '(no subject)'), ' ', h('span', { class: 'ds-ho-why' }, r.reason || ''),
            r.assignee ? h('span', { class: 'ds-ho-assignee' }, Chip({ tone: 'accent', size: 'sm', children: r.assignee })) : null)),
        hoSection('Open handoffs', j.handoffs, (r, i) => h('div', { key: i, class: 'ds-ho-row' },
            refLink(r.ref, r.id), ' ', h('span', { class: 'ds-muted' }, r.subject || ''), ' ', h('span', { class: 'ds-ho-why' }, r.reason || ''))),
        hoSection('Unsent drafts', j.drafts, (r, i) => h('div', { key: i, class: 'ds-ho-row' },
            refLink(r.ref, r.id), ' ', h('span', { class: 'ds-muted' }, r.subject || ''), ' ', h('span', { class: 'ds-ho-why' }, (r.text || '').slice(0, 120)))),
        hoSection('Changed this shift', j.touched, (r, i) => h('div', { key: i, class: 'ds-ho-row' },
            refLink(r.ref, r.id), ' ', h('span', { class: 'ds-muted' }, r.subject || ''),
            ' ', h('span', { class: 'ds-ho-why' }, (r.last_kind || '') + (r.last_actor ? ' by ' + r.last_actor : '')),
            ' ', h('span', { class: 'ds-act-when' }, r.at ? fmtTime(r.at) : ''))));
}

export function HandoverPanel() {
    loader.ensureLoaded();
    const actions = h('div', { class: 'ds-ho-actions' },
        Btn({ variant: 'primary', children: starting ? 'Starting...' : 'Start shift', disabled: starting, onClick: startShift }),
        ' ',
        h('a', { href: '/api/handover?format=html', class: 'ds-link', target: '_blank', rel: 'noopener' }, 'Printable'));
    const body = loader.slot(() => (state._handover
        ? handoverBody(state._handover)
        : Alert({ kind: 'warn', children: 'Could not load the handover digest.' })));
    return Panel({ children: [actions, body] });
}
