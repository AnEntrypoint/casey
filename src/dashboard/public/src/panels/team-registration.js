// "Register a team member" -- mechanism 1 of 2 for giving a WhatsApp number a
// role: the operator types the number and picks the role. (Mechanism 2, the
// one-time code the person sends themselves, is panels/invite-codes.js.)
//
// Form state lives at module level because the panel re-renders on every
// schedule(); a value held in a render-local variable would be wiped by the
// next unrelated repaint mid-typing.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel } from '/design/src/components/content/panel.js';
import { TextField, Select } from '/design/src/components/content/fields.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { schedule } from '../state.js';
import { postContactRegister } from '../api.js';
import { tierLabel, TIER_ORDER, botNumber, brandName } from '../vocabulary.js';
import { glossaryLookup } from '../glossary.js';
import { toast, failMsg } from '../toasts.js';

const h = webjsx.createElement;

const form = { phone: '', name: '', tier: TIER_ORDER[1], busy: false, error: null };

/** @returns {string[]} the rungs a person can be registered into (never the default rung; the top one only for an admin). */
export function assignableTiers(isAdmin) {
    return TIER_ORDER.slice(1).filter((t) => isAdmin || t !== TIER_ORDER[TIER_ORDER.length - 1]);
}

export function tierOptions(isAdmin) {
    return assignableTiers(isAdmin).map((t) => ({ value: t, label: tierLabel(t) }));
}

async function submit(isAdmin, onDone) {
    if (form.busy) return;
    if (!form.phone.trim()) { form.error = 'Enter their WhatsApp number first.'; schedule(); return; }
    form.busy = true; form.error = null; schedule();
    try {
        const j = await postContactRegister(form.phone, form.name, form.tier);
        const c = j && j.contact;
        toast((c && c.display_name && c.named ? c.display_name : 'That number') + ' is now registered as ' + tierLabel(form.tier) + '.', 'ok');
        form.phone = ''; form.name = '';
        if (onDone) onDone();
    } catch (e) {
        form.error = await failMsg(e, 'The number was not registered. Check it and try again.');
    }
    form.busy = false; schedule();
}

export function TeamRegistration({ isAdmin, onDone }) {
    if (!assignableTiers(isAdmin).includes(form.tier)) form.tier = TIER_ORDER[1];
    return Panel({
        title: 'Register a team member',
        children: h('form', {
            class: 'ds-team-form', novalidate: true,
            onsubmit: (e) => { e.preventDefault(); submit(isAdmin, onDone); },
        },
            h('p', { class: 'ds-team-lede' }, 'Add someone by their WhatsApp number. Next time they message, they are treated in the role you pick here. They do not need to do anything.' + (botNumber() ? ' They reach ' + brandName() + ' on WhatsApp at ' + botNumber() + '.' : '')),
            h('div', { class: 'ds-team-row' },
                TextField({ key: 'tf-phone', name: 'team-phone', label: 'WhatsApp number', type: 'tel', value: form.phone, placeholder: '079 091 5297 or +27 79 091 5297', onInput: (v) => { form.phone = v; form.error = null; } }),
                TextField({ key: 'tf-name', name: 'team-name', label: 'Name (optional)', value: form.name, placeholder: 'e.g. Thandi Mokoena', maxLength: 80, onInput: (v) => { form.name = v; } }),
                Select({ key: 'sel-role', name: 'team-role', label: 'Role', value: form.tier, options: tierOptions(isAdmin), onChange: (v) => { form.tier = v; schedule(); } })),
            h('p', { class: 'ds-team-explain', 'data-role-explain': form.tier }, h('strong', {}, tierLabel(form.tier) + ': '), glossaryLookup(form.tier)),
            form.error ? h('p', { class: 'ds-team-error', role: 'alert' }, form.error) : null,
            h('div', { class: 'ds-contact-actions' },
                Btn({ disabled: form.busy, children: form.busy ? 'Registering...' : 'Register', onClick: () => submit(isAdmin, onDone) }))),
    });
}
