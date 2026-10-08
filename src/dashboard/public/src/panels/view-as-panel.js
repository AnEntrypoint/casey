import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { api, setViewAs, viewAsId } from '../api.js';
import { state } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { word } from '../words.js';

const h = webjsx.createElement;
let accounts = [];
const ROLE_KEY = {
    admin: 'ui.view_as_panel_role_admin',
    operator: 'ui.view_as_panel_role_operator',
    secretary: 'ui.view_as_panel_role_operator',
    eco_ranger: 'ui.view_as_panel_role_eco_ranger',
    animal_health_technician: 'ui.view_as_panel_role_technician',
    viewer: 'ui.view_as_panel_role_viewer',
};
const roleName = (role) => (ROLE_KEY[role] ? word(ROLE_KEY[role]) : role);
const ORDER = ['operator', 'secretary', 'animal_health_technician', 'eco_ranger', 'viewer', 'admin'];

const loader = createPanelLoader({
    what: () => word('ui.view_as_panel_what'),
    label: () => word('ui.view_as_panel_loading'),
    fetch: async () => { const r = await api('/api/accounts'); if (!r.ok) throw new Error('accounts ' + r.status); return r.json(); },
    apply: (j) => { accounts = (j && j.accounts) || []; },
});

export function ViewAsPanel() {
    const isAdmin = state.currentUser && state.currentUser.role === 'admin' && !viewAsId();
    if (!isAdmin) return h('p', { class: 'casey-hint' }, word('ui.view_as_panel_admin_only'));
    loader.ensureLoaded();
    return loader.slot(() => {
        const live = accounts.filter(a => !a.disabled && a.role !== 'admin');
        const roles = ORDER.filter(r => live.some(a => a.role === r));
        return h('div', { class: 'field-home' },
            h('p', { class: 'casey-hint' }, word('ui.view_as_panel_lede')),
            roles.length ? roles.map(role => h('div', { key: role, class: 'ds-view-as-group' },
                h('h3', {}, roleName(role)),
                live.filter(a => a.role === role).map(a => h('div', { key: a.id, class: 'ds-contact-actions' },
                    h('span', {}, (a.display_name || a.username) + (a.display_name && a.display_name !== a.username ? ' (' + a.username + ')' : '')),
                    Btn({ size: 'sm', variant: 'ghost', children: word('ui.view_as_panel_see_as'), 'aria-label': word('ui.view_as_panel_see_aria', { name: a.display_name || a.username }), onClick: () => setViewAs(a.id) }))))) : h('p', {}, word('ui.view_as_panel_none')),
            Btn({ variant: 'ghost', children: word('ui.view_as_panel_refresh'), onClick: () => loader.reload() }));
    });
}
