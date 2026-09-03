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
import { Spinner, Alert } from '/design/src/components/content/feedback.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { state, schedule, closePanel, setActiveId } from '../state.js';
import { fetchSecretaryQueue } from '../api.js';
import { fmtDur, fmtTime } from '../format.js';

const h = webjsx.createElement;

let loaded = false, loading = false, error = null, filter = 'all';

function load() {
    loading = true; schedule();
    fetchSecretaryQueue({ assignee: filter === 'all' ? undefined : filter }).then((j) => {
        state._secretary = j;
        loaded = true; loading = false; error = null; schedule();
    }).catch((e) => { loaded = true; loading = false; error = e.message || 'secretary queue error'; schedule(); });
}

function ensureLoaded() {
    if (loaded || loading) return;
    load();
}

function setFilter(f) {
    if (f === filter) return;
    filter = f; loaded = false;
    load();
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
    ensureLoaded();
    const back = Btn({ variant: 'ghost', children: 'Back to cases', onClick: closePanel });
    let body;
    if (loading && !loaded) body = Spinner({ label: 'loading follow-up queue' });
    else if (error) body = Alert({ kind: 'error', children: 'Secretary queue error: ' + error });
    else {
        const j = state._secretary;
        const places = (j && j.places) || [];
        if (!places.length) {
            body = Alert({ kind: 'success', children: 'Nothing waiting on a call right now.' });
        } else {
            body = h('div', {}, ...places.map(placeSection));
        }
    }
    return Panel({ title: 'Follow-up calls', right: filterBar(), children: [back, body] });
}
