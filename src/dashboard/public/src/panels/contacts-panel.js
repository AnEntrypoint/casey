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
import { BulkTeamAdd } from './bulk-team-add.js';
import { PersonsDialog, openPersonsDialog } from '../components/persons-dialog.js';

const h = webjsx.createElement;

const busyIds = new Set();

const view = { segment: null, q: '', addOpen: false };

async function query() {
    const q = view.q.trim();
    let j = await fetchContacts({ segment: view.segment || 'team', q });
    if (!view.segment && j && j.counts && j.counts.team === 0) { view.segment = 'all'; j = await fetchContacts({ segment: 'all', q }); }
    return j;
}

const loader = createPanelLoader({
    what: 'the people',
    label: 'loading people',
    fetch: query,
    apply: (j) => { state._contacts = j; },
});

let seq = 0, timer = null;
function refetch(delay) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
        const mine = ++seq;
        try { const j = await query(); if (mine === seq) { state._contacts = j; schedule(); } } catch {  }
    }, delay || 0);
}

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
        toast(failedN > 0
            ? `Partly erased: ${countOf(scrubbedN)} scrubbed, ${failedN} not. Identifying details are still stored on those -- run Erase again to finish.`
            : `Erased. ${countOf(scrubbedN)} scrubbed.`, failedN > 0 ? 'err' : 'ok');
        loader.reload();
    } catch (e) {
        toast(await failMsg(e, 'Nothing was erased -- this contact\'s details are all still stored. Try again.'), 'err');
    }
    busyIds.delete(c.id); schedule();
}

function who(c) {
    if (c.named) return c.display_name;
    if (c.has_number) return c.external_id_formatted;
    const arrived = c.created_at ? fmtTime(c.created_at) : 'date unknown';
    const via = c.channel === 'web' ? 'Public form' : (c.channel ? 'Via ' + channelLabel(c.channel) : 'Channel not recorded');
    return h('div', { class: 'ds-contact-anon' },
        h('span', {}, 'No name or number given'),
        h('span', { class: 'ds-contact-anon-sub' }, via + ', ' + arrived));
}


function withPeople(c, cell) {
    if (!c.people) return cell;
    const nm = c.named ? c.display_name : (c.has_number ? c.external_id_formatted : 'this phone');
    return h('div', { class: 'ds-contact-anon' },
        cell,
        h('span', { class: 'ds-contact-anon-sub ds-persons-line' },
            c.people > 1 ? c.people + ' people share this phone' : '1 person known on this phone',
            Btn({ size: 'sm', variant: 'link', children: 'See who', 'aria-label': 'See who uses the phone of ' + nm, onClick: () => openPersonsDialog({ id: c.id, label: nm }, () => refetch(0)) })));
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
                    const chip = tier === TIER_ORDER[0]
                        ? h('span', { class: 'ds-role-plain' }, tierLabel(tier))
                        : Chip({ tone: tier === TIER_ORDER[TIER_ORDER.length - 1] ? 'blue' : 'accent', children: tierLabel(tier) });
                    const opts = tierOptions(isAdmin);
                    const all = [{ value: TIER_ORDER[0], label: tierLabel(TIER_ORDER[0]) }].concat(opts);
                    if (!all.some((o) => o.value === tier)) all.push({ value: tier, label: tierLabel(tier) });
                    return [
                        withPeople(c, who(c)),
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
        Panel({ title: 'People', children: [body] }),
        h('details', { class: 'ds-add-people', key: 'add-people', open: view.addOpen ? true : null, ontoggle: (e) => { view.addOpen = !!e.target.open; } },
            h('summary', { class: 'ds-add-people-sum' }, 'Add people'),
            h('div', { class: 'ds-add-people-body' },
                TeamRegistration({ isAdmin, onDone: () => loader.reload() }),
                BulkTeamAdd({ onDone: () => loader.reload() }),
                InviteCodes({ isAdmin }))),
        PersonsDialog({}));
}
