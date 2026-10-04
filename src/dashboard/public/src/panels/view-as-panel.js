import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { api, setViewAs, viewAsId } from '../api.js';
import { state } from '../state.js';
import { createPanelLoader } from './panel-load.js';

const h = webjsx.createElement;
let accounts = [];
const ROLE_WORD = { admin: 'Admin', operator: 'Operator', secretary: 'Operator', eco_ranger: 'Eco ranger', animal_health_technician: 'Animal health technician', viewer: 'Viewer' };
const ORDER = ['operator', 'secretary', 'animal_health_technician', 'eco_ranger', 'viewer', 'admin'];

const loader = createPanelLoader({
    what: () => 'the logins',
    label: 'loading logins',
    fetch: async () => { const r = await api('/api/accounts'); if (!r.ok) throw new Error('accounts ' + r.status); return r.json(); },
    apply: (j) => { accounts = (j && j.accounts) || []; },
});

export function ViewAsPanel() {
    const isAdmin = state.currentUser && state.currentUser.role === 'admin' && !viewAsId();
    if (!isAdmin) return h('p', { class: 'casey-hint' }, 'Only an admin can look at the dashboard as another login.');
    loader.ensureLoaded();
    return loader.slot(() => {
        const live = accounts.filter(a => !a.disabled && a.role !== 'admin');
        const roles = ORDER.filter(r => live.some(a => a.role === r));
        return h('div', { class: 'field-home' },
            h('p', { class: 'casey-hint' }, 'Pick a login to see the dashboard the way that person sees it: the same screens, the same reports, the same limits. It is read-only, so nothing you do there changes anything. A bar at the top lets you leave.'),
            roles.length ? roles.map(role => h('div', { key: role, class: 'ds-view-as-group' },
                h('h3', {}, ROLE_WORD[role] || role),
                live.filter(a => a.role === role).map(a => h('div', { key: a.id, class: 'ds-contact-actions' },
                    h('span', {}, (a.display_name || a.username) + (a.display_name && a.display_name !== a.username ? ' (' + a.username + ')' : '')),
                    Btn({ size: 'sm', variant: 'ghost', children: 'See as them', 'aria-label': 'See the dashboard as ' + (a.display_name || a.username), onClick: () => setViewAs(a.id) }))))) : h('p', {}, 'There are no other logins to look at yet.'),
            Btn({ variant: 'ghost', children: 'Refresh', onClick: () => loader.reload() }));
    });
}
