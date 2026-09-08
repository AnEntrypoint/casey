// HelpOverlay -- full reference / keyboard shortcuts, reopenable via `?`.
// This is the CANONICAL implementation of the modal dialog the dialog-shaped
// overlays (help/onboarding/skills/settings/stats) share via dialog-shell.js's
// Dialog. Beyond the static reference card it also renders the full glossary
// (ux-onboarding-contextual-help: a static list here backs a user who wants to
// read every term at once, while Term() elsewhere backs in-place hover/focus
// lookup) and an explicit i18n-scope note (ux-i18n-clarify-scope).
//
// EVERY CONTROL NAMED BELOW EXISTS AND IS SPELLED THE WAY IT RENDERS. That is
// not a style note, it is the contract: an operator reading this screen goes
// looking for the word it gave them. This card previously sent them after a
// yellow dot (the map legend has no yellow), an "Aa" button (there is none),
// a name box at the top right (identity comes from the session, never an
// assertion), and four case-page buttons under names none of them carry. If a
// control is renamed, rename it here in the same commit or delete the line.
//
// The product name comes from dashboard_ui.brand, like every other
// operator-facing surface -- "casey" is the software this is built on, not
// the name of the deployment somebody is logged into.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn, Lede } from '/design/src/components/shell/atoms.js';
import { Dialog } from './dialog-shell.js';
import { glossary } from '../glossary.js';
import { state } from '../state.js';
import { QUEUE_NAME } from '../map-model.js';
const h = webjsx.createElement;

const KEY = 'casey_help_seen';

export function helpSeen() {
    try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function markHelpSeen() {
    try { localStorage.setItem(KEY, '1'); } catch { /* never blocks close */ }
}

function KeyRow({ k, desc }) {
    return h('li', { key: k }, h('kbd', { class: 'ds-kbd' }, k), ' - ', desc);
}

/**
 * @param {Object} props
 * @param {boolean} props.open
 * @param {Function} props.onClose
 * @param {Function} [props.onShowOnboarding] - "Show me the first-shift steps again" callback.
 */
export function HelpOverlay({ open, onClose, onShowOnboarding } = {}) {
    const brand = state.config?.dashboard_ui?.brand || 'casey';
    return Dialog({
        open, onClose,
        id: 'help',
        title: 'How this screen works',
        wide: true,
        footer: h('div', { class: 'ds-dialog-foot-row' },
            onShowOnboarding ? Btn({ variant: 'ghost', onClick: onShowOnboarding, children: 'Show me the first-shift steps again' }) : null,
            Btn({ variant: 'primary', onClick: onClose, children: 'Got it' })
        ),
        children: [
            Lede({ children: `${brand} reads the messages people send on WhatsApp and Discord, writes down what they report, and puts the ones that need you at the top of this screen. Here is what you are looking at, in plain words.` }),

            h('h3', { key: 'h-queue' }, `The "${QUEUE_NAME}" list`),
            h('p', { key: 'p-queue' }, 'It is the list beside the map, and it is the whole job: the report that needs somebody most is at the top. Each row leads with what the report is about, then the reference code, then one line saying why it is in the list. Tap a row to open it.'),
            h('p', { key: 'p-band' }, 'A coloured stripe runs down the left edge of a row. Red means it needs a person now, amber means it needs a look today, grey means it can wait. The map beside the list marks the same reports the same way, and the legend on the map says what every pin colour and outline means.'),

            h('h3', { key: 'h-open' }, 'What you can do on an open report'),
            h('ul', { key: 'ul-buttons' },
                h('li', { key: '1' }, h('b', {}, 'Claim'), ' - takes it as yours, so nobody else answers the same person. Once it is yours the button is replaced by your name.'),
                h('li', { key: '2' }, h('b', {}, 'Snooze'), ' - hides it from the list for a set number of minutes. A report where someone asked for a real person is never hidden.'),
                h('li', { key: '3' }, h('b', {}, 'Change the stage'), ' - the row of arrow buttons under the report, one per stage it can move to next, such as ', h('b', {}, '-> Done'), '. Moving it by hand does not message the person.'),
                h('li', { key: '4' }, h('b', {}, 'Reply to contact on whatsapp'), ' - the message box further down (it names whichever app they wrote from). Type there and press ', h('b', {}, 'Send reply'), ', then read the note that comes back: it says whether the message reached them.'),
                h('li', { key: '5' }, h('b', {}, 'note'), ' - the small button at the end of every report line. It attaches a note to that one fact without changing it.'),
                h('li', { key: '6' }, h('b', {}, 'Save edits'), ' - the form near the bottom, where you set ', h('b', {}, 'Priority'), ' (how urgent), ', h('b', {}, 'Autonomy'), ' (who answers this person: ', h('b', {}, 'auto'), ', ', h('b', {}, 'assisted'), ' or ', h('b', {}, 'observe'), '), the assignee, the subject and your own tags.')
            ),

            h('h3', { key: 'h-answer' }, 'How do I answer someone?'),
            h('p', { key: 'p-answer' }, 'Open the report. Scroll to ', h('b', {}, 'Reply to contact'), ', type your message, and press ', h('b', {}, 'Send reply'), '. It goes out on whichever app they wrote from, and the note that appears afterwards tells you whether it actually reached them. Read it: a reply is always added to the timeline, even on the occasions it could not be delivered.'),
            h('p', { key: 'p-draft' }, 'When a report is set to ', h('b', {}, 'assisted'), ', ' + brand + ' writes the reply and holds it. A banner at the top of the message box shows the draft with ', h('b', {}, 'Approve & send'), ' and ', h('b', {}, 'Discard'), '. Nothing goes out until you press one.'),

            h('h3', { key: 'h-keys' }, 'Keyboard shortcuts (for fast triage)'),
            h('ul', { key: 'ul-keys', class: 'ds-help-keys' },
                KeyRow({ k: 'j / k', desc: 'move down / up the list' }),
                KeyRow({ k: 'o / Enter', desc: 'open the highlighted report' }),
                KeyRow({ k: 'c', desc: 'claim the open report as yours' }),
                KeyRow({ k: 'e', desc: 'jump to the reply box' }),
                KeyRow({ k: '/', desc: 'search' }),
                KeyRow({ k: 'n', desc: 'new report' }),
                KeyRow({ k: 'Esc', desc: 'back / close' }),
                KeyRow({ k: '?', desc: 'show this help' })
            ),

            h('h3', { key: 'h-who' }, 'Who you are'),
            h('p', { key: 'p-who' }, 'Your name is taken from the account you signed in with, and every reply and claim is recorded against it. There is nothing to pick and nothing to type: if the name at the top right is not yours, sign out from that menu and sign in again.'),

            h('h3', { key: 'h-lang' }, 'Language'),
            h('p', { key: 'p-lang' }, 'The buttons, the labels and this help are only in English. When ' + brand + ' replies to a person, it writes back in whatever language they wrote in; that mirroring happens only in the conversation itself, never in this dashboard.'),

            h('h3', { key: 'h-gloss' }, 'Words this screen uses'),
            h('dl', { key: 'dl-gloss', class: 'ds-help-glossary' },
                ...Object.entries(glossary()).map(([term, explain]) => [
                    h('dt', { key: 'dt-' + term }, term.replace(/_/g, ' ')),
                    h('dd', { key: 'dd-' + term }, explain),
                ]).flat()
            ),

            h('p', { key: 'p-foot', class: 'ds-dialog-foot-note' }, 'You can open this help again any time with the ', h('b', {}, '?'), ' button at the top, or by pressing ', h('b', {}, '?'), ' on the keyboard.')
        ]
    });
}
