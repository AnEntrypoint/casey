// Nudges panel -- the operator's view of assigned reports that may be stalling.
// One block per field-team member holding open reports: how long since the
// report was given to them, since they last touched it, since the reporter last
// wrote, and what is still missing, with a one-click "Message on WhatsApp" that
// opens the operator's OWN WhatsApp with a drafted nudge. Nothing is sent from
// here; the link is built and escaped on the server (dashboard/wa-link.js).
import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { Panel } from '/design/src/components/content/panel.js';
import { Row } from '/design/src/components/content/row.js';
import { setActiveId } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchNudges } from '../api-roles.js';
import { entityLabel, entityLabelPlural } from '../vocabulary.js';

const h = webjsx.createElement;
let data = { people: [], capped: false };

const loader = createPanelLoader({
    what: () => 'the assigned ' + entityLabelPlural(),
    label: 'loading assigned reports',
    fetch: () => fetchNudges(),
    apply: (j) => { data = j || { people: [], capped: false }; },
});

// "3 hours ago" -- or the plain word for having no such moment on record, so a sentence
// never reads "they last did something on it not recorded".
const ago = (hours, none) => {
    if (hours == null) return none;
    if (hours < 1) return 'less than an hour ago';
    if (hours < 48) return Math.round(hours) === 1 ? '1 hour ago' : Math.round(hours) + ' hours ago';
    return Math.round(hours / 24) + ' days ago';
};
const safeWa = (u) => (typeof u === 'string' && u.startsWith('https://wa.me/') ? u : null);

// One held report as a kit Row: the subject is the title, the three clocks and what is
// still missing are its sub line, and the whole row opens the report.
function caseRow(c) {
    const sub = 'Given to them: ' + ago(c.hours_assigned, 'time not recorded')
        + '. Their last update on it: ' + ago(c.hours_since_activity, 'none yet')
        + '. The reporter last wrote: ' + ago(c.hours_since_reporter, 'never') + '. '
        + (c.missing.length ? 'Still needed: ' + c.missing.join(', ') + '.' : 'Nothing is missing.');
    return Row({ key: c.id, title: c.subject && c.subject !== c.ref ? c.subject : c.ref, sub: c.ref + '. ' + sub, onClick: () => setActiveId(c.id) });
}

function personBlock(p) {
    const wa = safeWa(p.wa_link);
    return h('div', { key: p.key }, Panel({
        title: p.name + (p.role ? ' (' + p.role + ')' : ''), headingLevel: 2, count: p.cases.length,
        children: [
            h('div', { key: 'meta', class: 'ds-contact-actions' },
                p.phone ? h('span', {}, p.phone) : h('span', { class: 'casey-hint' }, 'No WhatsApp number on file for this person.'),
                // The kit's button classes on an anchor: Btn has no target/rel, and this must open in
                // a new tab so the operator keeps the dashboard.
                wa ? h('a', { key: 'wa', class: 'btn btn-primary btn-sm', href: wa, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Message on WhatsApp: ' + p.name + ' (opens in a new tab)' }, 'Message on WhatsApp') : null),
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
