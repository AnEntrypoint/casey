import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { TextField, Select } from '/design/src/components/content/fields.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { schedule } from '../state.js';
import { postContactRegister } from '../api.js';
import { tierLabel, TIER_ORDER, botNumber } from '../vocabulary.js';
import { glossaryLookup } from '../glossary.js';
import { toast, failMsg } from '../toasts.js';
import { word } from '../words.js';

const h = webjsx.createElement;

const form = { phone: '', name: '', tier: TIER_ORDER[1], busy: false, error: null };

export function assignableTiers(isAdmin) {
    return isAdmin ? TIER_ORDER.slice(1) : TIER_ORDER.slice(1, 2);
}

export function tierOptions(isAdmin) {
    return assignableTiers(isAdmin).map((t) => ({ value: t, label: tierLabel(t) }));
}

async function submit(isAdmin, onDone) {
    if (form.busy) return;
    if (!form.phone.trim()) { form.error = word('ui.team_registration_phone_required'); schedule(); return; }
    form.busy = true; form.error = null; schedule();
    try {
        const j = await postContactRegister(form.phone, form.name, form.tier);
        const c = j && j.contact;
        toast(word('ui.team_registration_registered', {
            name: (c && c.display_name && c.named ? c.display_name : word('ui.team_registration_that_number')),
            tier: tierLabel(form.tier),
        }), 'ok');
        form.phone = ''; form.name = '';
        if (onDone) onDone();
    } catch (e) {
        form.error = await failMsg(e, word('ui.team_registration_failed'));
    }
    form.busy = false; schedule();
}

export function TeamRegistration({ isAdmin, onDone }) {
    if (!assignableTiers(isAdmin).includes(form.tier)) form.tier = TIER_ORDER[1];
    return Panel({
        title: word('ui.team_registration_title'),
        children: h('form', {
            class: 'ds-team-form', novalidate: true,
            onsubmit: (e) => { e.preventDefault(); submit(isAdmin, onDone); },
        },
            h('p', { class: 'ds-team-lede' }, word('ui.team_registration_lede') + (botNumber() ? word('ui.team_registration_reach', { number: botNumber() }) : '')),
            h('div', { class: 'ds-team-row' },
                TextField({ key: 'tf-phone', name: 'team-phone', label: word('ui.team_registration_phone_label'), type: 'tel', value: form.phone, placeholder: word('ui.team_registration_phone_placeholder'), onInput: (v) => { form.phone = v; form.error = null; } }),
                TextField({ key: 'tf-name', name: 'team-name', label: word('ui.team_registration_name_label'), value: form.name, placeholder: word('ui.team_registration_name_placeholder'), maxLength: 80, onInput: (v) => { form.name = v; } }),
                Select({ key: 'sel-role', name: 'team-role', label: word('ui.team_registration_role_label'), value: form.tier, options: tierOptions(isAdmin), onChange: (v) => { form.tier = v; schedule(); } })),
            h('p', { class: 'ds-team-explain', 'data-role-explain': form.tier }, h('strong', {}, tierLabel(form.tier) + ': '), glossaryLookup(form.tier)),
            form.error ? h('p', { class: 'ds-team-error', role: 'alert' }, form.error) : null,
            h('div', { class: 'ds-contact-actions' },
                Btn({ disabled: form.busy, children: form.busy ? word('ui.team_registration_registering') : word('ui.team_registration_register'), onClick: () => submit(isAdmin, onDone) }))),
    });
}
