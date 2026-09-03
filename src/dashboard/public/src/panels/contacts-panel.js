// Contacts/Reporters panel -- reporter/field_worker tier promote/demote +
// admin-only PII erasure. Content-swap panel (state.activePanel ===
// 'contacts'). Table-based, per-row MenuButton -> postContactTier.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { Spinner, Alert } from '/design/src/components/content/feedback.js';
import { Btn, Chip } from '/design/src/components/shell/atoms.js';
import { state, schedule, closePanel } from '../state.js';
import { fetchContacts, postContactTier, postContactErase } from '../api.js';
import { fmtTime } from '../format.js';
import { toast } from '../toasts.js';
import { confirmDialog } from '../components/dialog-shell.js';

const h = webjsx.createElement;

let loaded = false, loading = false, error = null;
const busyIds = new Set();

function ensureLoaded() {
    if (loaded || loading) return;
    loading = true;
    fetchContacts().then((j) => {
        state._contacts = j;
        loaded = true; loading = false; error = null; schedule();
    }).catch((e) => { loaded = true; loading = false; error = e.message || 'reporters error'; schedule(); });
}

async function toggleTier(c) {
    const to = c.tier === 'field_worker' ? 'reporter' : 'field_worker';
    busyIds.add(c.id); schedule();
    try {
        await postContactTier(c.id, to);
        toast(to === 'field_worker' ? 'Promoted to field worker' : 'Demoted to reporter', 'ok');
        loaded = false; ensureLoaded();
    } catch (e) {
        toast('Could not change tier: ' + (e.message || ''), 'err');
    }
    busyIds.delete(c.id); schedule();
}

async function erase(c) {
    const reason = await confirmDialog({
        title: "Erase this contact's data?",
        message: "Irreversibly scrubs their identifying info (name, id, location check-ins) and any owner/present-person/photo/audio fields on their cases. The case reports themselves and the audit trail stay -- this only removes what could identify a specific person. This cannot be undone.",
        inputLabel: 'Reason (optional, for the audit trail)',
        confirmLabel: 'Erase PII', danger: true,
    });
    if (reason === null) return;
    busyIds.add(c.id); schedule();
    try {
        const j = await postContactErase(c.id, reason || '');
        const scrubbedN = j.casesScrubbed ? j.casesScrubbed.length : 0;
        const failedN = j.casesFailed ? j.casesFailed.length : 0;
        toast(failedN > 0 ? `Erased -- ${scrubbedN} case(s) scrubbed, ${failedN} FAILED (retry needed)` : `Erased -- ${scrubbedN} case(s) scrubbed`, failedN > 0 ? 'err' : 'ok');
        loaded = false; ensureLoaded();
    } catch (e) {
        toast('Could not erase contact: ' + (e.message || ''), 'err');
    }
    busyIds.delete(c.id); schedule();
}

export function ContactsPanel() {
    ensureLoaded();
    const back = Btn({ variant: 'ghost', children: 'Back to cases', onClick: closePanel });
    const isAdmin = state.currentUser && state.currentUser.role === 'admin';
    let body;
    if (loading && !loaded) body = Spinner({ label: 'loading reporters' });
    else if (error) body = Alert({ kind: 'error', children: 'Reporters error: ' + error });
    else {
        const contacts = (state._contacts && state._contacts.contacts) || [];
        if (!contacts.length) body = Alert({ kind: 'info', children: 'No one has reported yet.' });
        else body = Table({
            headers: ['Who', 'Channel', 'Tier', 'Last check-in', ''],
            rows: contacts.map((c) => {
                const isField = c.tier === 'field_worker';
                const erased = c.external_id_formatted === '[erased]';
                return [
                    c.display_name || c.external_id_formatted,
                    c.channel || '',
                    isField ? Chip({ tone: 'accent', children: 'field worker' }) : Chip({ children: 'reporter' }),
                    c.last_location_at ? fmtTime(c.last_location_at) : 'never',
                    h('div', { class: 'ds-contact-actions' },
                        Btn({ size: 'sm', disabled: busyIds.has(c.id), children: isField ? 'Demote' : 'Promote', onClick: () => toggleTier(c) }),
                        (isAdmin && !erased) ? Btn({ size: 'sm', variant: 'danger', disabled: busyIds.has(c.id), children: 'Erase PII', onClick: () => erase(c) }) : null),
                ];
            }),
        });
    }
    return Panel({ title: 'Reporters', children: [back, body] });
}
