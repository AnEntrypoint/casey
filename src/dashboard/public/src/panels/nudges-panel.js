// Nudges panel -- the operator's view of assigned reports that may be stalling.
// One block per field-team member holding open reports: how long since the
// report was given to them, since they last touched it, since the reporter last
// wrote, and what is still missing, with a one-click "Message on WhatsApp" that
// opens the operator's OWN WhatsApp with a drafted nudge. Nothing is sent from
// here; the link is built and escaped on the server (dashboard/wa-link.js).
import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { Section } from '/design/src/components/content/panel.js';
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

const ago = (hours) => {
    if (hours == null) return 'not recorded';
    if (hours < 1) return 'less than an hour ago';
    if (hours < 48) return Math.round(hours) + ' hours ago';
    return Math.round(hours / 24) + ' days ago';
};
const safeWa = (u) => (typeof u === 'string' && u.startsWith('https://wa.me/') ? u : null);

function caseRow(c) {
    return h('li', { key: c.id, class: 'field-nudge-case' },
        h('button', { type: 'button', class: 'field-linkbtn', onclick: () => setActiveId(c.id) }, c.ref),
        ' ' + (c.subject && c.subject !== c.ref ? c.subject : ''),
        h('div', { class: 'casey-hint' },
            'Given to them: ' + ago(c.hours_assigned) + '. They last did something on it: ' + ago(c.hours_since_activity)
            + '. The reporter last wrote: ' + ago(c.hours_since_reporter) + '.'),
        h('div', { class: 'casey-hint' }, c.missing.length ? 'Still needed: ' + c.missing.join(', ') + '.' : 'Nothing is missing.'));
}

function personBlock(p) {
    const wa = safeWa(p.wa_link);
    return h('div', { key: p.key, class: 'field-nudge-person' },
        Section({
            title: p.name + (p.role ? ' (' + p.role + ')' : ''),
            children: [
                h('div', { key: 'meta', class: 'field-nudge-meta' },
                    p.phone ? h('span', {}, p.phone) : h('span', { class: 'casey-hint' }, 'No WhatsApp number on file for this person.'),
                    wa ? h('a', { class: 'field-wa-link', href: wa, target: '_blank', rel: 'noopener noreferrer' }, 'Message on WhatsApp') : null),
                h('ul', { key: 'cases', class: 'field-nudge-list' }, ...p.cases.map(caseRow)),
            ],
        }));
}

export function NudgesPanel() {
    loader.ensureLoaded();
    return loader.slot(() => h('div', { class: 'field-nudges' },
        h('p', { class: 'casey-hint' }, 'Open ' + entityLabelPlural() + ' that have been given to a ranger or technician, the ones that have been quiet longest first. The WhatsApp button opens your own WhatsApp with a message ready to send.'),
        data.people.length
            ? data.people.map(personBlock)
            : h('p', {}, 'No ' + entityLabel() + ' is currently given to a ranger or technician.'),
        data.capped ? h('p', { class: 'casey-hint' }, 'Some people hold more reports than can be listed here.') : null,
        Btn({ variant: 'ghost', children: 'Refresh', onClick: () => loader.reload() }))) ;
}
