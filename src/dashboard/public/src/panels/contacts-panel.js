// People panel -- register team members (team-registration.js), invite them by
// WhatsApp code (invite-codes.js), and manage every contact's role from one
// table, plus admin-only PII erasure. Content-swap panel (state.activePanel ===
// 'contacts'). Each row carries a role selector that can move the person to any
// role directly, and for an admin an Erase control. The table is filtered to
// team members by default: the public reporters are the vast majority and
// would otherwise bury the handful of people who hold a role.
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
import { Alert, FilterPills } from '/design/src/components/content/feedback.js';
import { Btn, Chip } from '/design/src/components/shell/atoms.js';
import { TextField, Select } from '/design/src/components/content/fields.js';
import { state, schedule } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchContacts, postContactTier, postContactErase } from '../api.js';
import { fmtTime, channelLabel } from '../format.js';
import { countOf, entityLabelPlural, tierLabel, tierValue, TIER_ORDER } from '../vocabulary.js';
import { glossaryLookup } from '../glossary.js';
import { toast, failMsg } from '../toasts.js';
import { confirmDialog } from '../components/dialog-shell.js';
import { TeamRegistration, tierOptions } from './team-registration.js';
import { InviteCodes } from './invite-codes.js';

const h = webjsx.createElement;

const busyIds = new Set();

// Segment: null = automatic (team members if there are any, else everyone). The segment and
// the search are asked of the server, over every contact: a deployment holds far more public
// reporters than the panel could ever draw, and the team is the part the operator came for.
const view = { segment: null, q: '' };

async function query() {
    const q = view.q.trim();
    let j = await fetchContacts({ segment: view.segment || 'team', q });
    if (!view.segment && j && j.counts && j.counts.team === 0) { view.segment = 'all'; j = await fetchContacts({ segment: 'all', q }); }
    return j;
}

const loader = createPanelLoader({
    what: 'the reporters',
    label: 'loading reporters',
    fetch: query,
    apply: (j) => { state._contacts = j; },
});

// A refresh that keeps the panel (and the search box's focus) on screen, unlike loader.reload().
let seq = 0, timer = null;
function refetch(delay) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
        const mine = ++seq;
        try { const j = await query(); if (mine === seq) { state._contacts = j; schedule(); } } catch { /* the last list stays */ }
    }, delay || 0);
}

// The caller names the target role, so the confirmation and the failure message
// can name the real role by its real label.
async function setTier(c, to, selectEl) {
    if (!to || to === tierValue(c.tier)) return;
    const who_ = c.named ? c.display_name : (c.has_number ? c.external_id_formatted : 'this person');
    const ok = await confirmDialog({
        title: 'Change ' + who_ + ' to ' + tierLabel(to) + '?',
        message: glossaryLookup(to) + ' They were ' + tierLabel(c.tier) + ' before.',
        confirmLabel: 'Change role',
    });
    if (ok === null) { if (selectEl) selectEl.value = tierValue(c.tier); return; }
    busyIds.add(c.id); schedule();
    try {
        await postContactTier(c.id, to);
        toast('Role is now ' + tierLabel(to), 'ok');
        loader.reload();
    } catch (e) {
        if (selectEl) selectEl.value = tierValue(c.tier);
        toast(await failMsg(e, 'The role was not changed, so it is still ' + tierLabel(c.tier) + '. Try again.'), 'err');
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
    const isAdmin = !!(state.currentUser && state.currentUser.role === 'admin');
    const body = loader.slot(() => {
        const contacts = (state._contacts && state._contacts.contacts) || [];
        const counts = (state._contacts && state._contacts.counts) || { team: 0, public: 0, all: contacts.length };
        if (!counts.all) return Alert({ kind: 'info', children: 'No one has reported yet.' });
        const segment = view.segment || (counts.team ? 'team' : 'all');
        const shown = contacts;
        return h('div', { class: 'ds-people' },
            h('div', { class: 'ds-people-filter' },
                FilterPills({
                    label: 'Show', selected: segment,
                    options: [
                        { id: 'team', label: 'Team members (' + counts.team + ')' },
                        { id: 'public', label: 'Public reporters (' + counts.public + ')' },
                        { id: 'all', label: 'Everyone (' + counts.all + ')' },
                    ],
                    onSelect: (key) => { view.segment = key; refetch(0); },
                }),
                TextField({ key: 'people-q', name: 'people-q', 'aria-label': 'Search by name or number', placeholder: 'Search by name or number', value: view.q, onInput: (v) => { view.q = v; refetch(300); } })),
            shown.length ? Table({
                headers: ['Who', 'Channel', 'Role', 'Last check-in', ''],
                rows: shown.map((c) => {
                    const tier = tierValue(c.tier);
                    const erased = c.external_id_formatted === '[erased]';
                    // Only a role ABOVE the default gets chip chrome; nearly every
                    // row is a public reporter and a chip down the whole column
                    // stops marking anything. The top role reads strongest.
                    const chip = tier === TIER_ORDER[0]
                        ? h('span', { class: 'ds-role-plain' }, tierLabel(tier))
                        : Chip({ tone: tier === TIER_ORDER[TIER_ORDER.length - 1] ? 'blue' : 'accent', children: tierLabel(tier) });
                    // The top role is offered to an admin only (the server refuses
                    // anyone else); a person already holding it still shows it.
                    const opts = tierOptions(isAdmin);
                    const all = [{ value: TIER_ORDER[0], label: tierLabel(TIER_ORDER[0]) }].concat(opts);
                    if (!all.some((o) => o.value === tier)) all.push({ value: tier, label: tierLabel(tier) });
                    return [
                        who(c),
                        channelLabel(c.channel),
                        chip,
                        c.last_location_at ? fmtTime(c.last_location_at) : 'never',
                        h('div', { class: 'ds-contact-actions' },
                            Select({ key: 'role-' + c.id, name: 'role-' + c.id, size: 'sm', value: tier, options: all, 'aria-label': 'Role for ' + (c.named ? c.display_name : (c.has_number ? c.external_id_formatted : 'this person')), onChange: (v, e) => setTier(c, v, e && e.target) }),
                            (isAdmin && !erased) ? Btn({ size: 'sm', variant: 'link', class: 'ds-contact-erase', disabled: busyIds.has(c.id), children: 'Erase personal details', onClick: () => erase(c) }) : null),
                    ];
                }),
            }) : Alert({ kind: 'info', children: 'No one matches that.' }),
            (state._contacts && state._contacts.capped) ? h('p', { class: 'casey-hint' }, 'Showing the first ' + shown.length + ' of ' + state._contacts.matched + '. Search by name or number to find the rest.') : null);
    });
    return h('div', { class: 'ds-people-page' },
        TeamRegistration({ isAdmin, onDone: () => loader.reload() }),
        InviteCodes({ isAdmin }),
        Panel({ title: 'People', children: [body] }));
}
