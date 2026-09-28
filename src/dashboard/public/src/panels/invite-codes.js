// "Invite by WhatsApp code" -- mechanism 2 of 2. The operator mints a one-time
// code; the person sends it to the bot from their own phone and is given the
// role. The plain code exists ONLY in the create response (the server keeps a
// one-way hash), so `fresh` below is the only place it can ever be shown; a
// page reload loses it and the invite has to be revoked and made again.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { TextField, Select } from '/design/src/components/content/fields.js';
import { Btn, Chip } from '/design/src/components/shell/atoms.js';
import { schedule } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchRoleInvites, postRoleInvite, deleteRoleInvite } from '../api.js';
import { fmtTime } from '../format.js';
import { tierLabel, brandName, botNumber } from '../vocabulary.js';
import { toast, failMsg } from '../toasts.js';
import { confirmDialog } from '../components/dialog-shell.js';
import { tierOptions, assignableTiers } from './team-registration.js';

const h = webjsx.createElement;

const TTLS = [{ value: '24', label: '1 day' }, { value: '72', label: '3 days' }, { value: '168', label: '7 days' }];
const USES = [{ value: '1', label: 'One person only' }, { value: '5', label: 'Up to 5 people' }, { value: '25', label: 'Up to 25 people' }];
const STATUS = {
    active: { text: 'Waiting to be used', tone: 'green' },
    used: { text: 'Used', tone: '' },
    expired: { text: 'Expired', tone: '' },
    revoked: { text: 'Cancelled', tone: 'red' },
};

const form = { tier: null, label: '', ttl: '72', uses: '1', busy: false, error: null };
let fresh = null;
const busyIds = new Set();

const loader = createPanelLoader({
    what: 'the invite codes',
    label: 'loading invite codes',
    fetch: fetchRoleInvites,
    apply: (j) => { loaderData.invites = (j && j.invites) || []; },
});
const loaderData = { invites: [] };

async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); toast(what + ' copied.', 'ok'); }
    catch { toast('This browser would not let the page copy. Select the text and copy it by hand.', 'err'); }
}

async function create(isAdmin) {
    if (form.busy) return;
    if (!form.tier || !assignableTiers(isAdmin).includes(form.tier)) form.tier = assignableTiers(isAdmin)[0];
    form.busy = true; form.error = null; schedule();
    try {
        const j = await postRoleInvite({ tier: form.tier, label: form.label.trim(), ttl_hours: Number(form.ttl), max_uses: Number(form.uses) });
        fresh = j.invite;
        form.label = '';
        loader.reload();
    } catch (e) {
        form.error = await failMsg(e, 'The code was not created. Try again.');
    }
    form.busy = false; schedule();
}

async function revoke(inv) {
    const ok = await confirmDialog({
        title: 'Cancel this invite code?',
        message: 'The code stops working straight away. Anyone who has not used it yet will not be able to. People who already used it keep their role.',
        confirmLabel: 'Cancel the code', danger: true,
    });
    if (ok === null) return;
    busyIds.add(inv.id); schedule();
    try {
        await deleteRoleInvite(inv.id);
        if (fresh && fresh.id === inv.id) fresh = null;
        toast('The code was cancelled.', 'ok');
        loader.reload();
    } catch (e) {
        toast(await failMsg(e, 'The code was not cancelled, so it still works. Try again.'), 'err');
    }
    busyIds.delete(inv.id); schedule();
}

function sendText(inv) {
    return 'Hi' + (inv.label ? ' ' + inv.label : '') + ', to join ' + brandName() + ' as ' + tierLabel(inv.tier)
        + ', send this code as a WhatsApp message to the ' + brandName() + ' number' + (botNumber() ? ' (' + botNumber() + ')' : '') + ' from your own phone: ' + inv.code
        + '. It works until ' + fmtTime(inv.expires_at) + '.';
}

function freshBlock() {
    if (!fresh) return null;
    const inv = fresh;
    return h('div', { class: 'ds-invite-fresh', role: 'status' },
        h('p', { class: 'ds-invite-fresh-note' }, 'Copy this now. For safety the code is shown only this once.'),
        h('div', { class: 'ds-invite-code', 'data-invite-code': inv.code }, inv.code),
        h('p', { class: 'ds-invite-text' }, sendText(inv)),
        h('div', { class: 'ds-contact-actions' },
            Btn({ size: 'sm', children: 'Copy the code', onClick: () => copy(inv.code, 'The code') }),
            Btn({ size: 'sm', variant: 'ghost', children: 'Copy the message to send', onClick: () => copy(sendText(inv), 'The message') }),
            Btn({ size: 'sm', variant: 'ghost', children: 'I have copied it', onClick: () => { fresh = null; schedule(); } })));
}

export function InviteCodes({ isAdmin }) {
    loader.ensureLoaded();
    const tiers = assignableTiers(isAdmin);
    if (!form.tier || !tiers.includes(form.tier)) form.tier = tiers[0];
    const list = loader.slot(() => {
        const invites = loaderData.invites;
        if (!invites.length) return Alert({ kind: 'info', children: 'No invite codes yet.' });
        return Table({
            headers: ['Role', 'For', 'Status', 'Used', 'Made by', 'Works until', ''],
            rows: invites.map((v) => {
                const st = STATUS[v.status] || { text: v.status, tone: '' };
                return [
                    tierLabel(v.tier),
                    v.label || 'Anyone with the code',
                    Chip({ tone: st.tone, children: st.text }),
                    v.uses + ' of ' + v.max_uses,
                    v.created_by || '',
                    fmtTime(v.expires_at),
                    v.status === 'active'
                        ? Btn({ size: 'sm', variant: 'ghost', disabled: busyIds.has(v.id), children: 'Cancel code', onClick: () => revoke(v) })
                        : null,
                ];
            }),
        });
    });
    return Panel({
        title: 'Invite by WhatsApp code',
        children: h('div', { class: 'ds-invite' },
            h('p', { class: 'ds-team-lede' }, 'For someone who is not registered yet. Make a one-time code and give it to them. When they send it to ' + brandName() + ' on WhatsApp from their own phone, they get the role you choose.'),
            h('form', { class: 'ds-team-form', novalidate: true, onsubmit: (e) => { e.preventDefault(); create(isAdmin); } },
                h('div', { class: 'ds-team-row' },
                    Select({ key: 'inv-role', name: 'invite-role', label: 'Role', value: form.tier, options: tierOptions(isAdmin), onChange: (v) => { form.tier = v; schedule(); } }),
                    TextField({ key: 'inv-label', name: 'invite-label', label: 'Who is it for? (optional)', value: form.label, placeholder: 'e.g. Thandi', maxLength: 80, onInput: (v) => { form.label = v; } }),
                    Select({ key: 'inv-ttl', name: 'invite-ttl', label: 'Works for', value: form.ttl, options: TTLS, onChange: (v) => { form.ttl = v; } }),
                    Select({ key: 'inv-uses', name: 'invite-uses', label: 'Can be used by', value: form.uses, options: USES, onChange: (v) => { form.uses = v; } })),
                form.error ? h('p', { class: 'ds-team-error', role: 'alert' }, form.error) : null,
                h('div', { class: 'ds-contact-actions' },
                    Btn({ disabled: form.busy, children: form.busy ? 'Making the code...' : 'Make a code', onClick: () => create(isAdmin) }))),
            freshBlock(),
            list),
    });
}
