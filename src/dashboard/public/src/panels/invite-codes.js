import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { TextField, Select } from '/design/src/components/content/fields.js';
import { Btn, Chip } from '/design/src/components/shell/atoms.js';
import { schedule } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchRoleInvites, postRoleInvite, deleteRoleInvite } from '../api.js';
import { fmtTime, NO_TIME_TEXT } from '../format.js';
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

const form = { tier: null, label: '', ttl: '72', uses: '1', count: '1', busy: false, error: null };
let fresh = null;
let freshText = '';
let announce = '';
let groupFilter = '';
let askCancelGroup = false;
const busyIds = new Set();

const loader = createPanelLoader({
    what: 'the invite codes',
    label: 'loading invite codes',
    fetch: fetchRoleInvites,
    apply: (j) => { loaderData.invites = (j && j.invites) || []; },
});
const loaderData = { invites: [] };

async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); toast(what + ' copied.', 'ok'); announce = what + ' copied.'; }
    catch { freshText = text; toast('This browser would not let the page copy. The text is shown below; select it and copy it by hand.', 'err'); }
    schedule();
}

const countWord = (n) => n + (n === 1 ? ' code' : ' codes');
const groupOf = (label) => String(label || '').replace(/\s+\d{2,3}$/, '').trim() || 'No group name';

function parseCount() {
    const t = String(form.count == null ? '' : form.count).trim();
    if (!/^\d+$/.test(t)) return NaN;
    const n = Number(t);
    return n >= 1 && n <= 100 ? n : NaN;
}

async function create(isAdmin) {
    if (form.busy) return;
    if (!form.tier || !assignableTiers(isAdmin).includes(form.tier)) form.tier = assignableTiers(isAdmin)[0];
    const n = parseCount();
    if (Number.isNaN(n)) { form.error = 'How many codes must be a whole number from 1 to 100.'; schedule(); return; }
    form.busy = true; form.error = null; schedule();
    try {
        const j = await postRoleInvite({ tier: form.tier, label: form.label.trim(), ttl_hours: Number(form.ttl), max_uses: n > 1 ? 1 : Number(form.uses), count: n });
        fresh = (j && Array.isArray(j.invites)) ? j.invites : (j && j.invite ? [j.invite] : []);
        freshText = '';
        announce = countWord(fresh.length) + ' made';
        form.label = '';
        loader.reload();
    } catch (e) {
        form.error = await failMsg(e, 'The codes were not made. Try again.');
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
        if (fresh) fresh = fresh.filter((f) => f.id !== inv.id);
        toast('The code was cancelled.', 'ok'); announce = 'The code was cancelled.';
        loader.reload();
    } catch (e) {
        toast(await failMsg(e, 'The code was not cancelled, so it still works. Try again.'), 'err');
    }
    busyIds.delete(inv.id); schedule();
}

async function cancelGroup() {
    const todo = loaderData.invites.filter((v) => v.status === 'active' && groupOf(v.label) === groupFilter);
    askCancelGroup = false; schedule();
    let done = 0, failed = 0;
    for (const v of todo) {
        busyIds.add(v.id); schedule();
        try { await deleteRoleInvite(v.id); done++; if (fresh) fresh = fresh.filter((f) => f.id !== v.id); } catch { failed++; }
        busyIds.delete(v.id);
    }
    announce = failed ? countWord(done) + ' cancelled; ' + countWord(failed) + ' could not be cancelled and still work.' : countWord(done) + ' cancelled.';
    toast(announce, failed ? 'err' : 'ok');
    loader.reload(); schedule();
}

function sendText(inv, { bare = false } = {}) {
    return 'Hi' + (!bare && inv.label ? ' ' + inv.label : '') + ', to join ' + brandName() + ' as ' + tierLabel(inv.tier)
        + ', send this code as a WhatsApp message to the ' + brandName() + ' number' + (botNumber() ? ' (' + botNumber() + ')' : '') + ' from your own phone: ' + inv.code
        + (fmtTime(inv.expires_at) ? '. It works until ' + fmtTime(inv.expires_at) + '.' : '.');
}

const csvCell = (v) => {
    let t = String(v == null ? '' : v);
    if (/^[=+\-@]/.test(t)) t = "'" + t;
    return '"' + t.replace(/"/g, '""') + '"';
};
const csvText = (codes) => ['# Generated ' + fmtTime(Date.now()), 'label,code,expires'].concat(codes.map((c) => [c.label, c.code, fmtTime(c.expires_at) || NO_TIME_TEXT].map(csvCell).join(','))).join('\r\n');

function downloadCsv(codes) {
    const text = csvText(codes);
    try {
        const a = document.createElement('a');
        if (!('download' in a) || !window.URL || !URL.createObjectURL || typeof Blob === 'undefined') throw new Error('no download');
        const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
        a.href = url; a.download = 'one-time-codes.csv';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        announce = 'The codes were saved as a spreadsheet file.';
    } catch {
        freshText = text;
        toast('This browser would not save a file. The codes are shown as text below; copy them by hand.', 'err');
    }
    schedule();
}

function printSlips(codes) {
    const host = document.createElement('div');
    host.id = 'casey-print-slips';
    const num = botNumber();
    for (const c of codes) {
        const slip = document.createElement('div'); slip.className = 'casey-slip';
        const add = (tag, cls, text) => { const el = document.createElement(tag); el.className = cls; el.textContent = text; slip.appendChild(el); };
        add('p', 'casey-slip-brand', brandName());
        add('p', 'casey-slip-code', c.code);
        add('p', 'casey-slip-send', 'Send this code on WhatsApp to ' + (num || 'the ' + brandName() + ' number'));
        add('p', 'casey-slip-meta', 'Works until ' + (fmtTime(c.expires_at) || NO_TIME_TEXT) + (c.label ? ' - ' + c.label : ''));
        add('p', 'casey-slip-meta', 'Printed ' + fmtTime(Date.now()));
        host.appendChild(slip);
    }
    document.body.appendChild(host);
    document.body.classList.add('casey-print-slips');
    const done = () => { host.remove(); document.body.classList.remove('casey-print-slips'); };
    window.addEventListener('afterprint', done, { once: true });
    try { window.print(); } catch { done(); }
}

function freshBlock() {
    if (!fresh || !fresh.length) return null;
    const codes = fresh;
    const rows = codes.map((c, i) => [
        String(i + 1),
        h('span', { class: 'ds-invite-code', 'data-invite-code': c.code }, c.code),
        c.label || '',
        fmtTime(c.expires_at) || NO_TIME_TEXT,
        Btn({ size: 'sm', variant: 'ghost', 'aria-label': 'Copy the code' + (c.label ? ' for ' + c.label : ' number ' + (i + 1)), children: 'Copy', onClick: () => copy(c.code, 'The code') }),
    ]);
    return h('div', { class: 'ds-invite-fresh' },
        h('p', { class: 'ds-invite-fresh-note' }, h('strong', {}, 'Shown once. Copy or print now.'), ' For safety the codes cannot be shown again after you leave this page.'),
        Table({ headers: ['Number', 'Code', 'Label', 'Expires', ''], rows, compact: true }),
        h('div', { class: 'ds-contact-actions' },
            Btn({ size: 'sm', children: 'Copy all codes', 'aria-label': 'Copy all ' + countWord(codes.length) + ', one per line', onClick: () => copy(codes.map((c) => c.code).join('\n'), 'The codes') }),
            Btn({ size: 'sm', variant: 'ghost', children: 'Copy all messages', 'aria-label': 'Copy all ' + countWord(codes.length) + ' as messages to send', onClick: () => copy(codes.map((c) => sendText(c, { bare: codes.length > 1 })).join('\n\n'), 'The messages') }),
            Btn({ size: 'sm', variant: 'ghost', children: 'Download CSV', onClick: () => downloadCsv(codes) }),
            Btn({ size: 'sm', variant: 'ghost', children: 'Print slips', onClick: () => printSlips(codes) }),
            Btn({ size: 'sm', variant: 'ghost', children: 'I have saved them', onClick: () => { fresh = null; freshText = ''; announce = ''; schedule(); } })),
        freshText ? TextField({ key: 'fresh-text', name: 'invite-fresh-text', label: 'Copy these by hand', multiline: true, rows: Math.min(10, codes.length + 2), value: freshText, onInput: () => {} }) : null);
}

export function InviteCodes({ isAdmin }) {
    loader.ensureLoaded();
    const tiers = assignableTiers(isAdmin);
    if (!form.tier || !tiers.includes(form.tier)) form.tier = tiers[0];
    const batch = Number(form.count) > 1;
    const list = loader.slot(() => {
        const all = loaderData.invites;
        if (!all.length) return Alert({ kind: 'info', children: 'No invite codes yet.' });
        const groups = [...new Set(all.map((v) => groupOf(v.label)))].sort();
        if (groupFilter && !groups.includes(groupFilter)) groupFilter = '';
        const invites = groupFilter ? all.filter((v) => groupOf(v.label) === groupFilter) : all;
        const unused = groupFilter ? invites.filter((v) => v.status === 'active').length : 0;
        return h('div', { class: 'ds-invite-list' },
            h('div', { class: 'ds-team-row' },
                Select({ key: 'inv-group', name: 'invite-group', label: 'Group', value: groupFilter, options: [{ value: '', label: 'All groups' }].concat(groups.map((g) => ({ value: g, label: g }))), onChange: (v) => { groupFilter = v; askCancelGroup = false; schedule(); } })),
            groupFilter && unused ? (askCancelGroup
                ? h('div', { class: 'ds-invite-confirm', role: 'group', 'aria-label': 'Confirm cancelling the unused codes' },
                    h('p', { class: 'ds-team-lede' }, 'Cancel ' + countWord(unused) + ' in "' + groupFilter + '" that nobody has used yet? They stop working straight away. People who already used one keep their role.'),
                    h('div', { class: 'ds-contact-actions' },
                        Btn({ size: 'sm', variant: 'danger', children: 'Yes, cancel ' + countWord(unused), onClick: cancelGroup }),
                        Btn({ size: 'sm', variant: 'ghost', children: 'No, keep them', onClick: () => { askCancelGroup = false; schedule(); } })))
                : Btn({ size: 'sm', variant: 'ghost', children: 'Cancel all unused in this group', 'aria-label': 'Cancel all ' + countWord(unused) + ' unused in the group ' + groupFilter, onClick: () => { askCancelGroup = true; schedule(); } })) : null,
            Table({
                compact: true,
                headers: ['Role', 'Group or name', 'Status', 'Used', 'Made by', 'Works until', ''],
                rows: invites.map((v) => {
                    const st = STATUS[v.status] || { text: v.status, tone: '' };
                    return [
                        tierLabel(v.tier),
                        v.label || 'Anyone with the code',
                        Chip({ tone: st.tone, children: st.text }),
                        v.uses + ' of ' + v.max_uses,
                        v.created_by || '',
                        fmtTime(v.expires_at) || NO_TIME_TEXT,
                        v.status === 'active'
                            ? Btn({ size: 'sm', variant: 'ghost', disabled: busyIds.has(v.id), children: 'Cancel code', 'aria-label': 'Cancel code' + (v.label ? ' for ' + v.label : ''), onClick: () => revoke(v) })
                            : null,
                    ];
                }),
            }));
    });
    return Panel({
        title: 'Invite by WhatsApp code',
        children: h('div', { class: 'ds-invite' },
            h('p', { class: 'ds-team-lede' }, 'For someone who is not registered yet. Make a one-time code and give it to them. When they send it to ' + brandName() + ' on WhatsApp from their own phone, they get the role you choose. To invite a whole group, ask for more than one code: each code works for one person.'),
            h('form', { class: 'ds-team-form', novalidate: true, onsubmit: (e) => { e.preventDefault(); create(isAdmin); } },
                h('div', { class: 'ds-team-row' },
                    Select({ key: 'inv-role', name: 'invite-role', label: 'Role they will get', value: form.tier, options: tierOptions(isAdmin), onChange: (v) => { form.tier = v; schedule(); } }),
                    TextField({ key: 'inv-label', name: 'invite-label', label: 'Group name (optional)', value: form.label, placeholder: 'e.g. North reserve', maxLength: 80, onInput: (v) => { form.label = v; } }),
                    TextField({ key: 'inv-count', name: 'invite-count', label: 'How many codes', type: 'number', min: 1, max: 100, value: form.count, hint: 'One code per person', onInput: (v) => { form.count = v; form.error = null; }, onChange: () => schedule() }),
                    Select({ key: 'inv-ttl', name: 'invite-ttl', label: 'Works for', value: form.ttl, options: TTLS, onChange: (v) => { form.ttl = v; } }),
                    batch
                        ? h('label', { key: 'inv-uses-fixed', class: 'ds-field' },
                            h('span', { class: 'ds-field-label' }, 'Can be used by'),
                            h('select', { class: 'ds-select', name: 'invite-uses', disabled: true }, h('option', { value: '1', selected: true }, 'One person each')))
                        : Select({ key: 'inv-uses', name: 'invite-uses', label: 'Can be used by', value: form.uses, options: USES, onChange: (v) => { form.uses = v; } })),
                form.error ? h('p', { class: 'ds-team-error', role: 'alert' }, form.error) : null,
                h('div', { class: 'ds-contact-actions' },
                    Btn({ disabled: form.busy, children: form.busy ? 'Making the codes...' : (batch ? 'Make the codes' : 'Make a code'), onClick: () => create(isAdmin) }))),
            h('p', { class: 'ds-invite-status', role: 'status' }, announce),
            freshBlock(),
            list),
    });
}
