import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn, Lede } from '/design/src/components/shell/atoms.js';
import { Dialog } from './dialog-shell.js';
import { glossary } from '../glossary.js';
import { brandName } from '../vocabulary.js';
import { queueName } from '../map-model.js';
import { word } from '../words.js';
const h = webjsx.createElement;

const KEY = 'casey_help_seen';

export function helpSeen() {
    try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function markHelpSeen() {
    try { localStorage.setItem(KEY, '1'); } catch {  }
}

function KeyRow({ k, desc }) {
    return h('li', { key: k }, h('kbd', { class: 'ds-kbd' }, k), ' - ', desc);
}

const TERM_WORD = { sla: 'ui.help_overlay_term_sla', external_id: 'ui.help_overlay_term_external_id' };
function termWord(term) { return TERM_WORD[term] ? word(TERM_WORD[term]) : term.replace(/_/g, ' '); }

export function HelpOverlay({ open, onClose, onShowOnboarding } = {}) {
    const brand = brandName();
    return Dialog({
        open, onClose,
        id: 'help',
        title: word('ui.help_overlay_title'),
        wide: true,
        footer: h('div', { class: 'ds-dialog-foot-row' },
            onShowOnboarding ? Btn({ variant: 'ghost', onClick: onShowOnboarding, children: word('ui.help_overlay_show_onboarding') }) : null,
            Btn({ variant: 'primary', onClick: onClose, children: word('ui.help_overlay_got_it') })
        ),
        children: [
            Lede({ children: word('ui.help_overlay_intro', { brand }) }),

            h('h3', { key: 'h-queue' }, word('ui.help_overlay_queue_heading', { queue: queueName() })),
            h('p', { key: 'p-queue' }, word('ui.help_overlay_queue_body')),
            h('p', { key: 'p-band' }, word('ui.help_overlay_band_body')),

            h('h3', { key: 'h-open' }, word('ui.help_overlay_open_heading')),
            h('ul', { key: 'ul-buttons' },
                h('li', { key: '1' }, h('b', {}, word('ui.help_overlay_claim_name')), word('ui.help_overlay_claim_desc'), h('b', {}, word('ui.help_overlay_yours')), word('ui.help_overlay_claim_other')),
                h('li', { key: '2' }, h('b', {}, word('ui.help_overlay_snooze_name')), word('ui.help_overlay_snooze_desc')),
                h('li', { key: '3' }, h('b', {}, word('ui.help_overlay_stage_name')), word('ui.help_overlay_stage_desc'), h('b', {}, word('ui.help_overlay_stage_example')), word('ui.help_overlay_stage_note')),
                h('li', { key: '4' }, h('b', {}, word('ui.help_overlay_reply_name')), word('ui.help_overlay_reply_desc'), h('b', {}, word('ui.help_overlay_reply_discord')), word('ui.help_overlay_reply_manual'), h('b', {}, word('ui.help_overlay_reply_contact')), word('ui.help_overlay_reply_warn'), h('b', {}, word('ui.help_overlay_send_reply')), word('ui.help_overlay_reply_note')),
                h('li', { key: '5' }, h('b', {}, word('ui.help_overlay_note_name')), word('ui.help_overlay_note_desc')),
                h('li', { key: '6' }, h('b', {}, word('ui.help_overlay_save_name')), word('ui.help_overlay_save_desc'), h('b', {}, word('ui.help_overlay_priority')), word('ui.help_overlay_priority_desc'), h('b', {}, word('ui.help_overlay_who_answers')), ' (', h('b', {}, word('ui.help_overlay_answer_own')), ', ', h('b', {}, word('ui.help_overlay_draft_send')), word('ui.help_overlay_or'), h('b', {}, word('ui.help_overlay_log_only')), word('ui.help_overlay_save_tail'))
            ),

            h('h3', { key: 'h-answer' }, word('ui.help_overlay_answer_heading')),
            h('p', { key: 'p-answer' }, word('ui.help_overlay_answer_1'), h('b', {}, word('ui.help_overlay_reply_contact')), word('ui.help_overlay_answer_2'), h('b', {}, word('ui.help_overlay_send_reply')), word('ui.help_overlay_answer_3')),
            h('p', { key: 'p-draft' }, word('ui.help_overlay_draft_1'), h('b', {}, word('ui.help_overlay_who_answers')), word('ui.help_overlay_draft_2'), h('b', {}, word('ui.help_overlay_draft_send')), ', ', word('ui.help_overlay_draft_3', { brand }), h('b', {}, word('ui.help_overlay_approve')), word('ui.help_overlay_and'), h('b', {}, word('ui.help_overlay_discard')), word('ui.help_overlay_draft_4')),

            h('h3', { key: 'h-keys' }, word('ui.help_overlay_keys_heading')),
            h('ul', { key: 'ul-keys', class: 'ds-help-keys' },
                KeyRow({ k: 'j / k', desc: word('ui.help_overlay_key_move') }),
                KeyRow({ k: 'o / Enter', desc: word('ui.help_overlay_key_open') }),
                KeyRow({ k: 'c', desc: word('ui.help_overlay_key_claim') }),
                KeyRow({ k: 'e', desc: word('ui.help_overlay_key_reply') }),
                KeyRow({ k: '/', desc: word('ui.help_overlay_key_search') }),
                KeyRow({ k: 'n', desc: word('ui.help_overlay_key_new') }),
                KeyRow({ k: 'Esc', desc: word('ui.help_overlay_key_back') }),
                KeyRow({ k: '?', desc: word('ui.help_overlay_key_help') })
            ),

            h('h3', { key: 'h-who' }, word('ui.help_overlay_who_heading')),
            h('p', { key: 'p-who' }, word('ui.help_overlay_who_body')),

            h('h3', { key: 'h-lang' }, word('ui.help_overlay_lang_heading')),
            h('p', { key: 'p-lang' }, word('ui.help_overlay_lang_body', { brand })),

            h('h3', { key: 'h-gloss' }, word('ui.help_overlay_gloss_heading')),
            h('dl', { key: 'dl-gloss', class: 'ds-help-glossary' },
                ...Object.entries(glossary()).map(([term, explain]) => [
                    h('dt', { key: 'dt-' + term }, termWord(term)),
                    h('dd', { key: 'dd-' + term }, explain),
                ]).flat()
            ),

            h('p', { key: 'p-foot', class: 'ds-dialog-foot-note' }, word('ui.help_overlay_foot_1'), h('b', {}, '?'), word('ui.help_overlay_foot_2'), h('b', {}, '?'), word('ui.help_overlay_foot_3'))
        ]
    });
}
