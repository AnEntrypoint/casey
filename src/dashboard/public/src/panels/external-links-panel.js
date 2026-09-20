// Cross-system links panel -- proposed correlations against another system
// (see EXTERNAL-SYNC.md), with Confirm/Reject as the human override every
// proposal requires before any data ever moves. Content-swap panel
// (state.activePanel === 'external_links').

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel, Section } from '/design/src/components/content/panel.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { Btn, Chip } from '/design/src/components/shell/atoms.js';
import { createPanelLoader } from './panel-load.js';
import { fetchExternalLinks, postExternalLinkConfirm, postExternalLinkReject } from '../api.js';
import { toast } from '../toasts.js';

const h = webjsx.createElement;

let busyId = null;
let state_links = [];

const loader = createPanelLoader({
    what: 'the cross-system links',
    label: 'loading proposed links',
    fetch: () => fetchExternalLinks('proposed'),
    apply: (j) => { state_links = j.links || []; },
});

async function confirmLink(id) {
    busyId = id;
    try {
        await postExternalLinkConfirm(id);
        toast('Link confirmed', 'ok');
        loader.reload();
    } catch (e) { toast('Could not confirm the link', 'warn'); }
    busyId = null;
}

async function rejectLink(id) {
    busyId = id;
    try {
        await postExternalLinkReject(id);
        toast('Link rejected', 'ok');
        loader.reload();
    } catch (e) { toast('Could not reject the link', 'warn'); }
    busyId = null;
}

function confidenceTone(c) {
    if (c >= 0.7) return 'ok';
    if (c >= 0.45) return 'accent';
    return 'dim';
}

function localRefLabel(l) {
    if (l.local_ref) return (l.local_entity === 'case' ? 'Case ' : l.local_entity === 'contact' ? 'Contact ' : '') + l.local_ref;
    return l.local_entity ? `(${l.local_entity} no longer found)` : '(local record unknown)';
}

function linkRow(l) {
    const rowBusy = busyId === l.id;
    return h('div', { key: l.id, class: 'ds-el-row' },
        h('div', { class: 'ds-el-main' },
            // WHICH local case/contact this proposal would merge into, always
            // shown before the two buttons that act on it -- Confirm is the
            // only path that ever merges external data into a local record,
            // so an operator must see the local side, not just the external
            // system's own label, before pressing it.
            h('span', { class: 'ds-el-local' }, localRefLabel(l)),
            ' -> ',
            h('span', { class: 'ds-el-ref' }, l.external_ref || l.external_entity),
            ' ',
            Chip({ tone: confidenceTone(l.confidence), size: 'sm', children: Math.round(l.confidence * 100) + '%' }),
            ' ',
            h('span', { class: 'ds-muted' }, l.match_basis || '')),
        h('div', { class: 'ds-el-actions' },
            Btn({ variant: 'primary', size: 'sm', disabled: rowBusy, children: 'Confirm', onClick: () => confirmLink(l.id) }),
            ' ',
            Btn({ variant: 'ghost', size: 'sm', disabled: rowBusy, children: 'Reject', onClick: () => rejectLink(l.id) })));
}

function linksBody() {
    if (!state_links.length) return Alert({ kind: 'info', children: 'No proposed cross-system links right now.' });
    return Section({ title: `Proposed links (${state_links.length})`, children: state_links.map(linkRow) });
}

export function ExternalLinksPanel() {
    loader.ensureLoaded();
    const body = loader.slot(linksBody);
    return Panel({ children: [body] });
}
