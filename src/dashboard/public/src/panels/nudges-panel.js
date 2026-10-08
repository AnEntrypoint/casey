import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Row } from '/design/src/components/content/row.js';
import { setActiveId } from '../state.js';
import { api } from '../api.js';
import { createPanelLoader } from './panel-load.js';
import { fetchNudges } from '../api-roles.js';
import { rel, NO_TIME_TEXT } from '../format.js';
import { word } from '../words.js';

const h = webjsx.createElement;
let data = { people: [], capped: false };
let metrics = null;

const loader = createPanelLoader({
    what: () => word('ui.nudges_panel_what'),
    label: () => word('ui.nudges_panel_loading'),
    fetch: async () => {
        const nudges = await fetchNudges();
        try { const r = await api('/api/metrics/team'); metrics = r.ok ? await r.json() : null; } catch { metrics = null; }
        return nudges;
    },
    apply: (j) => { data = j || { people: [], capped: false }; },
});

const ago = (hours, none) => (hours == null ? none : rel(Date.now() - hours * 3600e3));
const safeWa = (u) => (typeof u === 'string' && u.startsWith('https://wa.me/') ? u : null);

function caseRow(c) {
    const sub = word('ui.nudges_panel_case_sub', {
        given: ago(c.hours_assigned, NO_TIME_TEXT),
        last: ago(c.hours_since_activity, word('ui.nudges_panel_none_yet')),
        reporter: ago(c.hours_since_reporter, word('ui.nudges_panel_never')),
        missing: c.missing.length ? word('ui.nudges_panel_still_needed', { list: c.missing.join(', ') }) : word('ui.nudges_panel_nothing_missing'),
    });
    return Row({ key: c.id, title: c.subject && c.subject !== c.ref ? c.subject : c.ref, sub: c.ref + '. ' + sub, onClick: () => setActiveId(c.id) });
}

const span = (ms) => {
    const h = ms / 3600e3;
    if (h < 1) return word('ui.nudges_panel_minutes', { count: Math.max(1, Math.round(ms / 60e3)) });
    if (h < 48) return word('ui.nudges_panel_hours', { count: Math.round(h * 10) / 10 });
    return word('ui.nudges_panel_days', { count: Math.round(h / 24) });
};

function metricsRow(m) {
    if (!m || !m.assigned) return null;
    const parts = [];
    parts.push(m.first_action && m.first_action.n
        ? word('ui.nudges_panel_first_update', { median: span(m.first_action.median_ms), slowest: span(m.first_action.p90_ms) })
        : word('ui.nudges_panel_no_first_update'));
    if (m.signoff && m.signoff.n) parts.push(word('ui.nudges_panel_signoff', { median: span(m.signoff.median_ms) }));
    parts.push(word('ui.nudges_panel_nudged', { nudged: m.reports_nudged, assigned: m.assigned }));
    if (m.stuck) parts.push(word('ui.nudges_panel_stuck', { stuck: m.stuck, hours: metrics.stuck_hours }));
    return Row({ key: 'metrics', title: word('ui.nudges_panel_how_doing'), sub: parts.join('. ') + '.' });
}

function personBlock(p) {
    const wa = safeWa(p.wa_link);
    return h('div', { key: p.key }, Panel({
        title: p.name + (p.role ? ' (' + p.role + ')' : ''), headingLevel: 2, count: p.cases.length,
        children: [
            h('div', { key: 'meta', class: 'ds-contact-actions' },
                p.phone ? h('span', {}, p.phone) : h('span', { class: 'casey-hint' }, word('ui.nudges_panel_no_number')),
                wa ? h('a', { key: 'wa', class: 'btn btn-primary btn-sm', href: wa, target: '_blank', rel: 'noopener noreferrer', 'aria-label': word('ui.nudges_panel_wa_aria', { name: p.name }) }, word('ui.nudges_panel_message_wa')) : null),
            metrics ? metricsRow(metrics.people.find((m) => m.name === p.name)) : null,
            ...p.cases.map(caseRow),
        ].filter(Boolean),
    }));
}

export function NudgesPanel() {
    loader.ensureLoaded();
    return loader.slot(() => h('div', { class: 'field-home' },
        h('p', { class: 'casey-hint' }, word('ui.nudges_panel_intro')),
        data.people.length
            ? data.people.map(personBlock)
            : h('p', {}, word('ui.nudges_panel_none')),
        data.capped ? h('p', { class: 'casey-hint' }, word('ui.nudges_panel_capped')) : null,
        Btn({ variant: 'ghost', children: word('ui.nudges_panel_refresh'), onClick: () => loader.reload() }))) ;
}
