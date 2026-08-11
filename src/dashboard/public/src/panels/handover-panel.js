// Handover panel -- shift digest + start-shift + printable link. Content-swap
// panel (state.activePanel === 'handover'). Panel/Receipt-based.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel, Section } from '/design/src/components/content/panel.js';
import { Spinner, Alert } from '/design/src/components/content/feedback.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { state, schedule, closePanel, setActiveId } from '../state.js';
import { fetchHandover, postStartShift } from '../api.js';
import { fmtTime } from '../format.js';
import { toast } from '../toasts.js';

const h = webjsx.createElement;

let loaded = false, loading = false, error = null, starting = false;

function ensureLoaded() {
    if (loaded || loading) return;
    loading = true;
    fetchHandover().then((j) => {
        state._handover = j;
        loaded = true; loading = false; error = null; schedule();
    }).catch((e) => { loaded = true; loading = false; error = e.message || 'handover error'; schedule(); });
}

async function startShift() {
    starting = true; schedule();
    try {
        await postStartShift();
        toast('Shift started -- "changed this shift" counts from now', 'ok');
        loaded = false; ensureLoaded();
    } catch (e) { toast('Could not start the shift', 'warn'); }
    starting = false; schedule();
}

function hoSection(title, rows, render) {
    if (!rows || !rows.length) return Section({ title, children: [Alert({ kind: 'info', children: 'None.' })] });
    return Section({ title: `${title} (${rows.length})`, children: rows.map(render) });
}

function refLink(ref, id) {
    return h('span', { class: 'ds-ho-ref', onclick: () => { if (id) setActiveId(id); } }, ref || '');
}

function handoverBody(j) {
    return h('div', {},
        h('div', { class: 'ds-ho-since' }, `Since ${j.since ? fmtTime(j.since) : 'the last day'}${j.since_by ? ' (' + j.since_by + ')' : ''}`),
        hoSection('Needs you now', j.attention, (r, i) => h('div', { key: i, class: 'ds-ho-row' },
            refLink(r.ref, r.id), ' ', h('span', { class: 'ds-muted' }, r.subject || '(no subject)'), ' ', h('span', { class: 'ds-ho-why' }, r.reason || ''),
            r.assignee ? h('span', { class: 'ds-owner-chip' }, r.assignee) : null)),
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
    ensureLoaded();
    const back = Btn({ variant: 'ghost', children: 'Back to cases', onClick: closePanel });
    const actions = h('div', { class: 'ds-ho-actions' },
        Btn({ variant: 'primary', children: starting ? 'Starting...' : 'Start shift', disabled: starting, onClick: startShift }),
        ' ',
        h('a', { href: '/api/handover?format=html', class: 'ds-link', target: '_blank', rel: 'noopener' }, 'Printable'));
    let body;
    if (loading && !loaded) body = Spinner({ label: 'loading handover digest' });
    else if (error) body = Alert({ kind: 'error', children: 'Handover error: ' + error });
    else body = state._handover ? handoverBody(state._handover) : Alert({ kind: 'warn', children: 'Could not load the handover digest.' });
    return Panel({ title: 'Shift handover', right: actions, children: [back, body] });
}
