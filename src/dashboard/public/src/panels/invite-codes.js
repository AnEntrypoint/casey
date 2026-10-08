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
import { word } from '../words.js';

const h = webjsx.createElement;

const TTLS = [{ value: '24', key: 'ui.invite_codes_ttl_1' }, { value: '72', key: 'ui.invite_codes_ttl_3' }, { value: '168', key: 'ui.invite_codes_ttl_7' }];
const USES = [{ value: '1', key: 'ui.invite_codes_use_one' }, { value: '5', key: 'ui.invite_codes_use_5' }, { value: '25', key: 'ui.invite_codes_use_25' }];
const STATUS = {
    active: { key: 'ui.invite_codes_status_active', tone: 'green' },
    used: { key: 'ui.invite_codes_status_used', tone: '' },
    expired: { key: 'ui.invite_codes_status_expired', tone: '' },
    revoked: { key: 'ui.invite_codes_status_revoked', tone: 'red' },
};

const form = { tier: null, label: '', ttl: '72', uses: '1', count: '1', busy: false, error: null };
let fresh = null;
let freshText = '';
let announce = '';
let groupFilter = '';
let askCancelGroup = false;
const busyIds = new Set();

const loader = createPanelLoader({
    what: () => word('ui.invite_codes_what'),
    label: () => word('ui.invite_codes_loading'),
    fetch: fetchRoleInvites,
    apply: (j) => { loaderData.invites = (j && j.invites) || []; },
});
const loaderData = { invites: [] };

async function copy(text, what) {
    try {
        await navigator.clipboard.writeText(text);
        const msg = word('ui.invite_codes_copied', { what });
        toast(msg, 'ok'); announce = msg;
    }
    catch { freshText = text; toast(word('ui.invite_codes_copy_blocked'), 'err'); }
    schedule();
}

const countWord = (n) => word(n === 1 ? 'ui.invite_codes_one' : 'ui.invite_codes_many', { count: n });
const groupOf = (label) => String(label || '').replace(/\s+\d{2,3}$/, '').trim() || word('ui.invite_codes_no_group');

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
    if (Number.isNaN(n)) { form.error = word('ui.invite_codes_count_invalid'); schedule(); return; }
    form.busy = true; form.error = null; schedule();
    try {
        const j = await postRoleInvite({ tier: form.tier, label: form.label.trim(), ttl_hours: Number(form.ttl), max_uses: n > 1 ? 1 : Number(form.uses), count: n });
        fresh = (j && Array.isArray(j.invites)) ? j.invites : (j && j.invite ? [j.invite] : []);
        freshText = '';
        announce = word('ui.invite_codes_made', { codes: countWord(fresh.length) });
        form.label = '';
        loader.reload();
    } catch (e) {
        form.error = await failMsg(e, word('ui.invite_codes_not_made'));
    }
    form.busy = false; schedule();
}

async function revoke(inv) {
    const ok = await confirmDialog({
        title: word('ui.invite_codes_cancel_title'),
        message: word('ui.invite_codes_cancel_message'),
        confirmLabel: word('ui.invite_codes_cancel_confirm'), danger: true,
    });
    if (ok === null) return;
    busyIds.add(inv.id); schedule();
    try {
        await deleteRoleInvite(inv.id);
        if (fresh) fresh = fresh.filter((f) => f.id !== inv.id);
        toast(word('ui.invite_codes_cancelled'), 'ok'); announce = word('ui.invite_codes_cancelled');
        loader.reload();
    } catch (e) {
        toast(await failMsg(e, word('ui.invite_codes_cancel_failed')), 'err');
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
    announce = failed
        ? word('ui.invite_codes_group_partial', { done: countWord(done), failed: countWord(failed) })
        : word('ui.invite_codes_group_done', { done: countWord(done) });
    toast(announce, failed ? 'err' : 'ok');
    loader.reload(); schedule();
}

function sendText(inv, { bare = false } = {}) {
    const greet = !bare && inv.label ? word('ui.invite_codes_greet_named', { name: inv.label }) : word('ui.invite_codes_greet');
    const num = botNumber();
    const expiry = fmtTime(inv.expires_at) ? word('ui.invite_codes_expiry', { time: fmtTime(inv.expires_at) }) : '.';
    return word('ui.invite_codes_send_text', {
        greet,
        tier: tierLabel(inv.tier),
        number: num ? word('ui.invite_codes_bot_number', { number: num }) : '',
        code: inv.code,
        expiry,
    });
}

const csvCell = (v) => {
    let t = String(v == null ? '' : v);
    if (/^[=+\-@]/.test(t)) t = "'" + t;
    return '"' + t.replace(/"/g, '""') + '"';
};
const csvText = (codes) => [word('ui.invite_codes_csv_generated', { time: fmtTime(Date.now()) }), 'label,code,expires'].concat(codes.map((c) => [c.label, c.code, fmtTime(c.expires_at) || NO_TIME_TEXT].map(csvCell).join(','))).join('\r\n');

function downloadCsv(codes) {
    const text = csvText(codes);
    try {
        const a = document.createElement('a');
        if (!('download' in a) || !window.URL || !URL.createObjectURL || typeof Blob === 'undefined') throw new Error('no download');
        const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
        a.href = url; a.download = 'one-time-codes.csv';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        announce = word('ui.invite_codes_csv_saved');
    } catch {
        freshText = text;
        toast(word('ui.invite_codes_download_failed'), 'err');
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
        add('p', 'casey-slip-send', word('ui.invite_codes_slip_send', { target: num || word('ui.invite_codes_slip_number') }));
        add('p', 'casey-slip-meta', word('ui.invite_codes_slip_until', { time: fmtTime(c.expires_at) || NO_TIME_TEXT }) + (c.label ? ' - ' + c.label : ''));
        add('p', 'casey-slip-meta', word('ui.invite_codes_slip_printed', { time: fmtTime(Date.now()) }));
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
        Btn({ size: 'sm', variant: 'ghost', 'aria-label': c.label ? word('ui.invite_codes_copy_for', { label: c.label }) : word('ui.invite_codes_copy_number', { number: i + 1 }), children: word('ui.invite_codes_copy'), onClick: () => copy(c.code, word('ui.invite_codes_the_code')) }),
    ]);
    return h('div', { class: 'ds-invite-fresh' },
        h('p', { class: 'ds-invite-fresh-note' }, h('strong', {}, word('ui.invite_codes_shown_once')), word('ui.invite_codes_safety')),
        Table({ headers: [word('ui.invite_codes_h_number'), word('ui.invite_codes_h_code'), word('ui.invite_codes_h_label'), word('ui.invite_codes_h_expires'), ''], rows, compact: true }),
        h('div', { class: 'ds-contact-actions' },
            Btn({ size: 'sm', children: word('ui.invite_codes_copy_all'), 'aria-label': word('ui.invite_codes_copy_all_aria', { codes: countWord(codes.length) }), onClick: () => copy(codes.map((c) => c.code).join('\n'), word('ui.invite_codes_the_codes')) }),
            Btn({ size: 'sm', variant: 'ghost', children: word('ui.invite_codes_copy_all_messages'), 'aria-label': word('ui.invite_codes_copy_all_messages_aria', { codes: countWord(codes.length) }), onClick: () => copy(codes.map((c) => sendText(c, { bare: codes.length > 1 })).join('\n\n'), word('ui.invite_codes_the_messages')) }),
            Btn({ size: 'sm', variant: 'ghost', children: word('ui.invite_codes_download_csv'), onClick: () => downloadCsv(codes) }),
            Btn({ size: 'sm', variant: 'ghost', children: word('ui.invite_codes_print_slips'), onClick: () => printSlips(codes) }),
            Btn({ size: 'sm', variant: 'ghost', children: word('ui.invite_codes_saved_them'), onClick: () => { fresh = null; freshText = ''; announce = ''; schedule(); } })),
        freshText ? TextField({ key: 'fresh-text', name: 'invite-fresh-text', label: word('ui.invite_codes_copy_by_hand'), multiline: true, rows: Math.min(10, codes.length + 2), value: freshText, onInput: () => {} }) : null);
}

export function InviteCodes({ isAdmin }) {
    loader.ensureLoaded();
    const tiers = assignableTiers(isAdmin);
    if (!form.tier || !tiers.includes(form.tier)) form.tier = tiers[0];
    const batch = Number(form.count) > 1;
    const list = loader.slot(() => {
        const all = loaderData.invites;
        if (!all.length) return Alert({ kind: 'info', children: word('ui.invite_codes_none') });
        const groups = [...new Set(all.map((v) => groupOf(v.label)))].sort();
        if (groupFilter && !groups.includes(groupFilter)) groupFilter = '';
        const invites = groupFilter ? all.filter((v) => groupOf(v.label) === groupFilter) : all;
        const unused = groupFilter ? invites.filter((v) => v.status === 'active').length : 0;
        return h('div', { class: 'ds-invite-list' },
            h('div', { class: 'ds-team-row' },
                Select({ key: 'inv-group', name: 'invite-group', label: word('ui.invite_codes_group'), value: groupFilter, options: [{ value: '', label: word('ui.invite_codes_all_groups') }].concat(groups.map((g) => ({ value: g, label: g }))), onChange: (v) => { groupFilter = v; askCancelGroup = false; schedule(); } })),
            groupFilter && unused ? (askCancelGroup
                ? h('div', { class: 'ds-invite-confirm', role: 'group', 'aria-label': word('ui.invite_codes_confirm_group_aria') },
                    h('p', { class: 'ds-team-lede' }, word('ui.invite_codes_confirm_text', { codes: countWord(unused), group: groupFilter })),
                    h('div', { class: 'ds-contact-actions' },
                        Btn({ size: 'sm', variant: 'danger', children: word('ui.invite_codes_yes_cancel', { codes: countWord(unused) }), onClick: cancelGroup }),
                        Btn({ size: 'sm', variant: 'ghost', children: word('ui.invite_codes_no_keep'), onClick: () => { askCancelGroup = false; schedule(); } })))
                : Btn({ size: 'sm', variant: 'ghost', children: word('ui.invite_codes_cancel_group'), 'aria-label': word('ui.invite_codes_cancel_group_aria', { codes: countWord(unused), group: groupFilter }), onClick: () => { askCancelGroup = true; schedule(); } })) : null,
            Table({
                compact: true,
                headers: [word('ui.invite_codes_h_role'), word('ui.invite_codes_h_group_name'), word('ui.invite_codes_h_status'), word('ui.invite_codes_h_used'), word('ui.invite_codes_h_made_by'), word('ui.invite_codes_h_works_until'), ''],
                rows: invites.map((v) => {
                    const st = STATUS[v.status];
                    const stText = st ? word(st.key) : v.status;
                    const stTone = st ? st.tone : '';
                    return [
                        tierLabel(v.tier),
                        v.label || word('ui.invite_codes_anyone'),
                        Chip({ tone: stTone, children: stText }),
                        word('ui.invite_codes_uses', { uses: v.uses, max: v.max_uses }),
                        v.created_by || '',
                        fmtTime(v.expires_at) || NO_TIME_TEXT,
                        v.status === 'active'
                            ? Btn({ size: 'sm', variant: 'ghost', disabled: busyIds.has(v.id), children: word('ui.invite_codes_cancel_code'), 'aria-label': v.label ? word('ui.invite_codes_cancel_code_for', { label: v.label }) : word('ui.invite_codes_cancel_code'), onClick: () => revoke(v) })
                            : null,
                    ];
                }),
            }));
    });
    return Panel({
        title: word('ui.invite_codes_title'),
        children: h('div', { class: 'ds-invite' },
            h('p', { class: 'ds-team-lede' }, word('ui.invite_codes_lede')),
            h('form', { class: 'ds-team-form', novalidate: true, onsubmit: (e) => { e.preventDefault(); create(isAdmin); } },
                h('div', { class: 'ds-team-row' },
                    Select({ key: 'inv-role', name: 'invite-role', label: word('ui.invite_codes_role_label'), value: form.tier, options: tierOptions(isAdmin), onChange: (v) => { form.tier = v; schedule(); } }),
                    TextField({ key: 'inv-label', name: 'invite-label', label: word('ui.invite_codes_group_name'), value: form.label, placeholder: word('ui.invite_codes_group_placeholder'), maxLength: 80, onInput: (v) => { form.label = v; } }),
                    TextField({ key: 'inv-count', name: 'invite-count', label: word('ui.invite_codes_count_label'), type: 'number', min: 1, max: 100, value: form.count, hint: word('ui.invite_codes_one_per_person'), onInput: (v) => { form.count = v; form.error = null; }, onChange: () => schedule() }),
                    Select({ key: 'inv-ttl', name: 'invite-ttl', label: word('ui.invite_codes_works_for'), value: form.ttl, options: TTLS.map((t) => ({ value: t.value, label: word(t.key) })), onChange: (v) => { form.ttl = v; } }),
                    batch
                        ? h('label', { key: 'inv-uses-fixed', class: 'ds-field' },
                            h('span', { class: 'ds-field-label' }, word('ui.invite_codes_can_be_used')),
                            h('select', { class: 'ds-select', name: 'invite-uses', disabled: true }, h('option', { value: '1', selected: true }, word('ui.invite_codes_one_each'))))
                        : Select({ key: 'inv-uses', name: 'invite-uses', label: word('ui.invite_codes_can_be_used'), value: form.uses, options: USES.map((u) => ({ value: u.value, label: word(u.key) })), onChange: (v) => { form.uses = v; } })),
                form.error ? h('p', { class: 'ds-team-error', role: 'alert' }, form.error) : null,
                h('div', { class: 'ds-contact-actions' },
                    Btn({ disabled: form.busy, children: form.busy ? word('ui.invite_codes_making_many') : (batch ? word('ui.invite_codes_make_many') : word('ui.invite_codes_make_one')), onClick: () => create(isAdmin) }))),
            h('p', { class: 'ds-invite-status', role: 'status' }, announce),
            freshBlock(),
            list),
    });
}
