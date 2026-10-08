import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { Alert, FilterPills } from '/design/src/components/content/feedback.js';
import { Btn, Chip } from '/design/src/components/shell/atoms.js';
import { TextField, Select } from '/design/src/components/content/fields.js';
import { state, schedule } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchContacts, postContactTier, postContactErase } from '../api.js';
import { fmtTime, channelLabel, NO_TIME_TEXT } from '../format.js';
import { countOf, tierLabel, tierValue, TIER_ORDER } from '../vocabulary.js';
import { glossaryLookup } from '../glossary.js';
import { toast, failMsg } from '../toasts.js';
import { confirmDialog } from '../components/dialog-shell.js';
import { TeamRegistration, tierOptions } from './team-registration.js';
import { InviteCodes } from './invite-codes.js';
import { BulkTeamAdd } from './bulk-team-add.js';
import { PersonsDialog, openPersonsDialog } from '../components/persons-dialog.js';
import { word } from '../words.js';

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
    what: () => word('ui.contacts_panel_what'),
    label: () => word('ui.contacts_panel_loading'),
    fetch: query,
    apply: (j) => { state._contacts = j; },
});

let seq = 0, timer = null;
function refetch(delay) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
        const mine = ++seq;
        try { const j = await query(); if (mine === seq) { state._contacts = j; schedule(); } }
        catch (e) { if (mine === seq) { toast(await failMsg(e, word('ui.contacts_panel_not_updated')), 'err'); } }
    }, delay || 0);
}

async function setTier(c, to, selectEl) {
    if (!to || to === tierValue(c.tier)) return;
    const who_ = c.named ? c.display_name : (c.has_number ? c.external_id_formatted : word('ui.contacts_panel_this_person'));
    const ok = await confirmDialog({
        title: word('ui.contacts_panel_change_title', { who: who_, tier: tierLabel(to) }),
        message: glossaryLookup(to) + word('ui.contacts_panel_were_before', { tier: tierLabel(c.tier) }),
        confirmLabel: word('ui.contacts_panel_change_role'),
    });
    if (ok === null) { if (selectEl) selectEl.value = tierValue(c.tier); return; }
    busyIds.add(c.id); schedule();
    try {
        await postContactTier(c.id, to);
        toast(word('ui.contacts_panel_role_now', { tier: tierLabel(to) }), 'ok');
        loader.reload();
    } catch (e) {
        if (selectEl) selectEl.value = tierValue(c.tier);
        toast(await failMsg(e, word('ui.contacts_panel_role_not_changed', { tier: tierLabel(c.tier) })), 'err');
    }
    busyIds.delete(c.id); schedule();
}

async function erase(c) {
    const reason = await confirmDialog({
        title: word('ui.contacts_panel_erase_title'),
        message: word('ui.contacts_panel_erase_message'),
        inputLabel: word('ui.contacts_panel_reason_label'),
        confirmLabel: word('ui.contacts_panel_erase_confirm'), danger: true,
    });
    if (reason === null) return;
    busyIds.add(c.id); schedule();
    try {
        const j = await postContactErase(c.id, reason || '');
        const scrubbedN = j.casesScrubbed ? j.casesScrubbed.length : 0;
        const failedN = j.casesFailed ? j.casesFailed.length : 0;
        toast(failedN > 0
            ? word('ui.contacts_panel_partly_erased', { scrubbed: countOf(scrubbedN), failed: failedN })
            : word('ui.contacts_panel_erased', { scrubbed: countOf(scrubbedN) }), failedN > 0 ? 'err' : 'ok');
        loader.reload();
    } catch (e) {
        toast(await failMsg(e, word('ui.contacts_panel_erase_failed')), 'err');
    }
    busyIds.delete(c.id); schedule();
}

function who(c) {
    if (c.named) return c.display_name;
    if (c.has_number) return c.external_id_formatted;
    const arrived = c.created_at ? fmtTime(c.created_at) : NO_TIME_TEXT;
    const via = c.channel === 'web' ? word('ui.contacts_panel_public_form') : (c.channel ? word('ui.contacts_panel_via', { channel: channelLabel(c.channel) }) : word('ui.contacts_panel_channel_unrecorded'));
    return h('div', { class: 'ds-contact-anon' },
        h('span', {}, word('ui.contacts_panel_no_name_or_number')),
        h('span', { class: 'ds-contact-anon-sub' }, via + ', ' + arrived));
}


function withPeople(c, cell) {
    if (!c.people) return cell;
    const nm = c.named ? c.display_name : (c.has_number ? c.external_id_formatted : word('ui.contacts_panel_this_phone'));
    return h('div', { class: 'ds-contact-anon' },
        cell,
        h('span', { class: 'ds-contact-anon-sub ds-persons-line' },
            c.people > 1 ? word('ui.contacts_panel_share_phone', { count: c.people }) : word('ui.contacts_panel_known_phone'),
            Btn({ size: 'sm', variant: 'link', children: word('ui.contacts_panel_see_who'), 'aria-label': word('ui.contacts_panel_see_who_aria', { name: nm }), onClick: () => openPersonsDialog({ id: c.id, label: nm }, () => refetch(0)) })));
}

export function ContactsPanel() {
    loader.ensureLoaded();
    const isAdmin = !!(state.currentUser && state.currentUser.role === 'admin');
    const body = loader.slot(() => {
        const contacts = (state._contacts && state._contacts.contacts) || [];
        const counts = (state._contacts && state._contacts.counts) || { team: 0, public: 0, all: contacts.length };
        if (!counts.all) return Alert({ kind: 'info', children: word('ui.contacts_panel_none') });
        const segment = view.segment || (counts.team ? 'team' : 'all');
        const shown = contacts;
        return h('div', { class: 'ds-people' },
            h('div', { class: 'ds-people-filter' },
                FilterPills({
                    label: word('ui.contacts_panel_show'), selected: segment,
                    options: [
                        { id: 'team', label: word('ui.contacts_panel_seg_team', { count: counts.team }) },
                        { id: 'public', label: word('ui.contacts_panel_seg_public', { count: counts.public }) },
                        { id: 'all', label: word('ui.contacts_panel_seg_all', { count: counts.all }) },
                    ],
                    onSelect: (key) => { view.segment = key; refetch(0); },
                }),
                TextField({ key: 'people-q', name: 'people-q', 'aria-label': word('ui.contacts_panel_search'), placeholder: word('ui.contacts_panel_search'), value: view.q, onInput: (v) => { view.q = v; refetch(300); } })),
            shown.length ? Table({
                headers: [word('ui.contacts_panel_h_who'), word('ui.contacts_panel_h_channel'), word('ui.contacts_panel_h_role'), word('ui.contacts_panel_h_last_checkin'), word('ui.contacts_panel_h_actions')],
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
                        c.last_location_at ? fmtTime(c.last_location_at) : NO_TIME_TEXT,
                        h('div', { class: 'ds-contact-actions' },
                            Select({ key: 'role-' + c.id, name: 'role-' + c.id, size: 'sm', value: tier, options: all, 'aria-label': word('ui.contacts_panel_role_for', { name: c.named ? c.display_name : (c.has_number ? c.external_id_formatted : word('ui.contacts_panel_this_person')) }), onChange: (v, e) => setTier(c, v, e && e.target) }),
                            (isAdmin && !erased) ? Btn({ size: 'sm', variant: 'link', class: 'ds-contact-erase', disabled: busyIds.has(c.id), children: word('ui.contacts_panel_erase_confirm'), onClick: () => erase(c) }) : null),
                    ];
                }),
            }) : Alert({ kind: 'info', children: word('ui.contacts_panel_no_match') }),
            (state._contacts && state._contacts.capped) ? h('p', { class: 'casey-hint' }, word('ui.contacts_panel_showing_first', { shown: shown.length, matched: state._contacts.matched })) : null);
    });
    return h('div', { class: 'ds-people-page' },
        Panel({ title: word('ui.contacts_panel_title'), children: [body] }),
        h('details', { class: 'ds-add-people', key: 'add-people', open: view.addOpen ? true : null, ontoggle: (e) => { view.addOpen = !!e.target.open; } },
            h('summary', { class: 'ds-add-people-sum' }, word('ui.contacts_panel_add_people')),
            h('div', { class: 'ds-add-people-body' },
                TeamRegistration({ isAdmin, onDone: () => loader.reload() }),
                BulkTeamAdd({ onDone: () => loader.reload() }),
                InviteCodes({ isAdmin }))),
        PersonsDialog({}));
}
