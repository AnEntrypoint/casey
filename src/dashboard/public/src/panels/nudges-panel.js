import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Row } from '/design/src/components/content/row.js';
import { setActiveId } from '../state.js';
import { api } from '../api.js';
import { createPanelLoader } from './panel-load.js';
import { fetchNudges } from '../api-roles.js';
import { entityLabel, entityLabelPlural } from '../vocabulary.js';

const h = webjsx.createElement;
let data = { people: [], capped: false };
let metrics = null;

const loader = createPanelLoader({
    what: () => 'the assigned ' + entityLabelPlural(),
    label: 'loading assigned reports',
    fetch: async () => {
        const nudges = await fetchNudges();
        try { const r = await api('/api/metrics/team'); metrics = r.ok ? await r.json() : null; } catch { metrics = null; }
        return nudges;
    },
    apply: (j) => { data = j || { people: [], capped: false }; },
});

const ago = (hours, none) => {
    if (hours == null) return none;
    if (hours < 1) return 'less than an hour ago';
    if (hours < 48) return Math.round(hours) === 1 ? '1 hour ago' : Math.round(hours) + ' hours ago';
    return Math.round(hours / 24) + ' days ago';
};
const safeWa = (u) => (typeof u === 'string' && u.startsWith('https://wa.me/') ? u : null);

function caseRow(c) {
    const sub = 'Given to them: ' + ago(c.hours_assigned, 'time not recorded')
        + '. Their last update on it: ' + ago(c.hours_since_activity, 'none yet')
        + '. The reporter last wrote: ' + ago(c.hours_since_reporter, 'never') + '. '
        + (c.missing.length ? 'Still needed: ' + c.missing.join(', ') + '.' : 'Nothing is missing.');
    return Row({ key: c.id, title: c.subject && c.subject !== c.ref ? c.subject : c.ref, sub: c.ref + '. ' + sub, onClick: () => setActiveId(c.id) });
}

const span = (ms) => {
    const h = ms / 3600e3;
    if (h < 1) return Math.max(1, Math.round(ms / 60e3)) + ' minutes';
    if (h < 48) return (Math.round(h * 10) / 10) + ' hours';
    return Math.round(h / 24) + ' days';
};

function metricsRow(m) {
    if (!m || !m.assigned) return null;
    const parts = [];
    parts.push(m.first_action && m.first_action.n
        ? 'First update after being given a ' + entityLabel() + ': usually ' + span(m.first_action.median_ms) + ' (slowest tenth ' + span(m.first_action.p90_ms) + ')'
        : 'No first update on any ' + entityLabel() + ' given to them yet');
    if (m.signoff && m.signoff.n) parts.push('Sign-off after hand-over: usually ' + span(m.signoff.median_ms));
    parts.push('Needed a nudge on ' + m.reports_nudged + ' of ' + m.assigned);
    if (m.stuck) parts.push(m.stuck + ' quiet for over ' + metrics.stuck_hours + ' hours');
    return Row({ key: 'metrics', title: 'How they are doing', sub: parts.join('. ') + '.' });
}

function personBlock(p) {
    const wa = safeWa(p.wa_link);
    return h('div', { key: p.key }, Panel({
        title: p.name + (p.role ? ' (' + p.role + ')' : ''), headingLevel: 2, count: p.cases.length,
        children: [
            h('div', { key: 'meta', class: 'ds-contact-actions' },
                p.phone ? h('span', {}, p.phone) : h('span', { class: 'casey-hint' }, 'No WhatsApp number on file for this person.'),
                wa ? h('a', { key: 'wa', class: 'btn btn-primary btn-sm', href: wa, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Message on WhatsApp: ' + p.name + ' (opens in a new tab)' }, 'Message on WhatsApp') : null),
            metrics ? metricsRow(metrics.people.find((m) => m.name === p.name)) : null,
            ...p.cases.map(caseRow),
        ].filter(Boolean),
    }));
}

export function NudgesPanel() {
    loader.ensureLoaded();
    return loader.slot(() => h('div', { class: 'field-home' },
        h('p', { class: 'casey-hint' }, 'Open ' + entityLabelPlural() + ' that have been given to a ranger or technician, the ones that have been quiet longest first. The WhatsApp button opens your own WhatsApp with a message ready to send.'),
        data.people.length
            ? data.people.map(personBlock)
            : h('p', {}, 'No ' + entityLabel() + ' is currently given to a ranger or technician.'),
        data.capped ? h('p', { class: 'casey-hint' }, 'Some people hold more reports than can be listed here.') : null,
        Btn({ variant: 'ghost', children: 'Refresh', onClick: () => loader.reload() }))) ;
}
