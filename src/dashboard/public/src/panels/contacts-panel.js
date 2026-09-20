// Contacts/Reporters panel -- reporter/field_worker tier promote/demote +
// admin-only PII erasure. Content-swap panel (state.activePanel ===
// 'contacts'). Table-based; each row carries a Promote/Demote button and, for
// an admin, an Erase control.
//
// THE ERASE CONTROL IS DELIBERATELY NOT A FILLED DANGER BUTTON. It used to be:
// the kit's highest-emphasis style, in red, repeated on all 20 rows, one
// row-height from Promote, which is a routine everyday triage action. That made
// the most destructive and rarest action on the screen also the loudest and the
// most repeated, and put it a mis-click away from the most common one. It is
// low-emphasis text now, and the guard that matters -- an explicit confirm
// naming what is scrubbed, with a reason field for the audit trail -- is
// unchanged. Do not raise its emphasis back: nothing is safer for being
// shouted, and an operator scanning this table is looking for people, not for
// the erase column.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { Btn, Chip } from '/design/src/components/shell/atoms.js';
import { state, schedule } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchContacts, postContactTier, postContactErase } from '../api.js';
import { fmtTime, channelLabel } from '../format.js';
import { countOf, entityLabelPlural } from '../vocabulary.js';
import { toast, failMsg } from '../toasts.js';
import { confirmDialog } from '../components/dialog-shell.js';

const h = webjsx.createElement;

const busyIds = new Set();

const loader = createPanelLoader({
    what: 'the reporters',
    label: 'loading reporters',
    fetch: fetchContacts,
    apply: (j) => { state._contacts = j; },
});

async function toggleTier(c) {
    const to = c.tier === 'field_worker' ? 'reporter' : 'field_worker';
    busyIds.add(c.id); schedule();
    try {
        await postContactTier(c.id, to);
        toast(to === 'field_worker' ? 'Promoted to field worker' : 'Demoted to reporter', 'ok');
        // The tier is a column in the table below, so the row on screen now
        // disagrees with the server.
        loader.reload();
    } catch (e) {
        toast(await failMsg(e, 'The access level was not changed, so it is still ' + (c.tier === 'field_worker' ? 'field worker' : 'reporter') + '. Try again.'), 'err');
    }
    busyIds.delete(c.id); schedule();
}

async function erase(c) {
    const reason = await confirmDialog({
        title: "Erase this contact's data?",
        // One noun for one thing: this said "their cases" and "the case reports"
        // in consecutive clauses. And "PII" on the confirm button is the one
        // piece of jargon in a dialog written for secretarial staff -- the
        // button that opens this says "Erase personal details", so the button
        // that commits it says the same words.
        message: 'Irreversibly scrubs their identifying details (name, id, location check-ins) and any owner, present-person, photo and audio fields on their ' + entityLabelPlural() + '. What was reported and the audit trail stay -- this removes only what could identify a specific person. This cannot be undone.',
        inputLabel: 'Reason (optional, for the audit trail)',
        confirmLabel: 'Erase personal details', danger: true,
    });
    if (reason === null) return;
    busyIds.add(c.id); schedule();
    try {
        const j = await postContactErase(c.id, reason || '');
        const scrubbedN = j.casesScrubbed ? j.casesScrubbed.length : 0;
        const failedN = j.casesFailed ? j.casesFailed.length : 0;
        // The failure half used to read "N FAILED (retry needed)" -- shouted,
        // and vague about what is still on disk. A half-finished erasure is a
        // privacy fact, so it says plainly that identifying details remain and
        // that pressing the same button again is what finishes the job.
        toast(failedN > 0
            ? `Partly erased: ${countOf(scrubbedN)} scrubbed, ${failedN} not. Identifying details are still stored on those -- run Erase again to finish.`
            : `Erased. ${countOf(scrubbedN)} scrubbed.`, failedN > 0 ? 'err' : 'ok');
        // The name/number cell for this row is exactly what was just scrubbed,
        // so leaving the old value on screen would show identifying text the
        // server no longer holds.
        loader.reload();
    } catch (e) {
        toast(await failMsg(e, 'Nothing was erased -- this contact\'s details are all still stored. Try again.'), 'err');
    }
    busyIds.delete(c.id); schedule();
}

// The "Who" cell. Three genuinely different facts, and rendering all three as
// one string is what put `web-1787845705110` in the column as if it were a
// person's name on 12 of 20 live rows.
//
// The server derives `named` and `has_number` from the stored columns
// (routes/contacts.js's publicContact) precisely so this function does not have
// to guess from the rendered value.
function who(c) {
    if (c.named) return c.display_name;
    // No name, but a number an operator can ring: the number IS the identity
    // here, and it is the actionable one -- this is the person reporting.
    if (c.has_number) return c.external_id_formatted;
    // Neither. Saying so, and saying how and when they arrived, is more use
    // than a routing key: these rows are distinguishable by time and by nothing
    // else, and pretending otherwise invites an operator to read a machine
    // token as an identifier they could look up.
    //
    // The second line names the CHANNEL rather than asserting "public form" for
    // every such row -- only channel 'web' is the form (routes/auth.js's
    // postReport opens those), and an unnamed contact on any other channel
    // would have been mislabelled by a fixed string.
    const arrived = c.created_at ? fmtTime(c.created_at) : 'date unknown';
    const via = c.channel === 'web' ? 'Public form' : (c.channel ? 'Via ' + channelLabel(c.channel) : 'Channel not recorded');
    return h('div', { class: 'ds-contact-anon' },
        h('span', {}, 'No name or number given'),
        h('span', { class: 'ds-contact-anon-sub' }, via + ', ' + arrived));
}

export function ContactsPanel() {
    loader.ensureLoaded();
    const isAdmin = state.currentUser && state.currentUser.role === 'admin';
    const body = loader.slot(() => {
        const contacts = (state._contacts && state._contacts.contacts) || [];
        if (!contacts.length) return Alert({ kind: 'info', children: 'No one has reported yet.' });
        return Table({
            headers: ['Who', 'Channel', 'Tier', 'Last check-in', ''],
            rows: contacts.map((c) => {
                const isField = c.tier === 'field_worker';
                const erased = c.external_id_formatted === '[erased]';
                return [
                    who(c),
                    channelLabel(c.channel),
                    // Only the exception gets chip chrome. Nearly every row is
                    // a plain reporter, and a chip repeated down the whole
                    // column stops marking anything; plain text keeps the
                    // value present without competing with the one row that
                    // differs.
                    isField ? Chip({ tone: 'accent', children: 'field worker' }) : 'reporter',
                    c.last_location_at ? fmtTime(c.last_location_at) : 'never',
                    h('div', { class: 'ds-contact-actions' },
                        Btn({ size: 'sm', disabled: busyIds.has(c.id), children: isField ? 'Demote' : 'Promote', onClick: () => toggleTier(c) }),
                        (isAdmin && !erased) ? Btn({ size: 'sm', variant: 'link', class: 'ds-contact-erase', disabled: busyIds.has(c.id), children: 'Erase personal details', onClick: () => erase(c) }) : null),
                ];
            }),
        });
    });
    return Panel({ children: [body] });
}
