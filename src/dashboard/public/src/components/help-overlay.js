// HelpOverlay -- full reference / keyboard shortcuts, reopenable via `?`.
// This is the CANONICAL implementation of "casey's modal dialog" the four
// dialog-shaped overlays (help/onboarding/skills/settings/stats) share via
// dialog-shell.js's Dialog. Beyond the static reference card the legacy
// app.js shipped, this also renders the full glossary (ux-onboarding-
// contextual-help: a static list here backs a user who wants to read every
// term at once, while Term() elsewhere backs in-place hover/focus lookup)
// and an explicit i18n-scope note (ux-i18n-clarify-scope).

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn, Lede } from '/design/src/components/shell/atoms.js';
import { Dialog } from './dialog-shell.js';
import { GLOSSARY } from '../glossary.js';
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
 * @param {Function} [props.onShowOnboarding] - "Show me the quick start again" callback.
 */
export function HelpOverlay({ open, onClose, onShowOnboarding } = {}) {
    return Dialog({
        open, onClose,
        id: 'help',
        title: 'Welcome to casey',
        wide: true,
        footer: h('div', { class: 'ds-dialog-foot-row' },
            onShowOnboarding ? Btn({ variant: 'ghost', onClick: onShowOnboarding }, 'Show me the quick start again') : null,
            Btn({ variant: 'primary', onClick: onClose }, 'Got it')
        ),
        children: [
            Lede({ children: 'casey watches your messages on WhatsApp and Discord and helps you answer them. Here is what this screen shows you, in plain words.' }),

            h('h3', { key: 'h-row' }, 'What is each row?'),
            h('p', { key: 'p-row' }, 'Each row on the left is one person who messaged you, and the whole story of what they need. Click a row to open it.'),

            h('h3', { key: 'h-dot' }, 'What is the yellow dot?'),
            h('p', { key: 'p-dot' }, h('span', { class: 'ds-help-swatch', 'aria-hidden': 'true' }), ' A yellow dot means this one is waiting for a person. casey will not answer it on its own. Open it, read it, and reply.'),

            h('h3', { key: 'h-buttons' }, 'The buttons when you open one'),
            h('ul', { key: 'ul-buttons' },
                h('li', { key: '1' }, h('b', {}, 'How urgent'), ' - mark how important it is, so you know what to do first.'),
                h('li', { key: '2' }, h('b', {}, 'Who answers'), ' - choose who replies to the person: casey on its own, casey writes a draft for you to send, or only you (casey just listens).'),
                h('li', { key: '3' }, h('b', {}, 'Reply to contact'), ' - type a message and send it to the person yourself.'),
                h('li', { key: '4' }, h('b', {}, 'Change the stage'), ' - move it along by hand, like marking it Done. The person is not told.')
            ),

            h('h3', { key: 'h-answer' }, 'How do I answer someone?'),
            h('p', { key: 'p-answer' }, 'Open the row. Scroll to ', h('b', {}, 'Reply to contact'), ', type your message, and press ', h('b', {}, 'Send reply'), '. The person gets it on WhatsApp or Discord.'),
            h('p', { key: 'p-tip' }, h('span', { class: 'ds-help-hint' }, 'Tip: the ', h('b', {}, 'Aa'), ' button at the top turns on plain-language labels everywhere.')),

            h('h3', { key: 'h-keys' }, 'Keyboard shortcuts (for fast triage)'),
            h('ul', { key: 'ul-keys', class: 'ds-help-keys' },
                KeyRow({ k: 'j / k', desc: 'move down / up the list' }),
                KeyRow({ k: 'o / Enter', desc: 'open the highlighted case' }),
                KeyRow({ k: 'c', desc: 'claim the open case as yours' }),
                KeyRow({ k: 'e', desc: 'jump to the reply box' }),
                KeyRow({ k: '/', desc: 'search' }),
                KeyRow({ k: 'n', desc: 'new case' }),
                KeyRow({ k: 'Esc', desc: 'back / close' }),
                KeyRow({ k: '?', desc: 'show this help' })
            ),

            h('h3', { key: 'h-lang' }, 'Language'),
            h('p', { key: 'p-lang' }, 'This screen -- the buttons, labels, and this help -- is only in English. When casey replies to a person, it writes back in whatever language they wrote to it in; that mirroring only happens in the conversation itself, never in this dashboard\'s own chrome.'),

            h('h3', { key: 'h-gloss' }, 'Words casey uses'),
            h('dl', { key: 'dl-gloss', class: 'ds-help-glossary' },
                ...Object.entries(GLOSSARY).map(([term, explain]) => [
                    h('dt', { key: 'dt-' + term }, term.replace(/_/g, ' ')),
                    h('dd', { key: 'dd-' + term }, explain),
                ]).flat()
            ),

            h('p', { key: 'p-foot', class: 'ds-dialog-foot-note' }, 'You can open this help again any time with the ', h('b', {}, '?'), ' button at the top.')
        ]
    });
}
