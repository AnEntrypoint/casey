// header.js -- the case's own heading (its subject), the ref line beneath it,
// channel + contact metadata collapsed under a toggle, claim button, snooze
// control, share/print links, the guardrail flags in plain words, how the
// case was created, and the one-line "what happens next" note mirroring
// caseHints' ladder.
//
// The heading is the SUBJECT and the note about who answers is an aside. It
// used to be the other way round: the ref led, and the automation notice
// rendered as a Lede at the pane's largest type, so a suspected
// foot-and-mouth report was announced by a sentence about the AI helper.
//
// NOTHING IN THIS HEADER IS A PILL ANY MORE, and that is the same judgement
// health-notices.js's header records, applied to the one place a case is
// looked at rather than scanned. Four rounded uppercase chips used to sit
// here: the stage ("WORKING ON IT"), the assignee ("P-VANWYK"), how the case
// arrived ("PUBLIC FORM"), and one per guardrail flag ("RESOLVED BUT NEVER
// CLOSED"). A pill is a LABEL, and it earns its shape when the shape is what
// you scan down a list of two hundred rows. There is exactly ONE case header
// on this page. Nothing is being scanned, so the shape bought nothing and
// cost three things:
//
//  - The stage chip said the same word the progress rail says two lines
//    below it, in a second vocabulary and a second visual grammar. The rail
//    also says how much is left; the chip could not.
//  - The guardrail labels are SENTENCES ("Resolved but never closed"),
//    squeezed into label shapes and then uppercased by the kit's chip rule,
//    which is how "Working but visit-critical facts still missing" reached an
//    operator's phone as shouting.
//  - An unmapped tag (format.js healthLabel has no entry for
//    health:premature_complete) rendered the raw enum key itself, in caps, in
//    a pill: HEALTH:PREMATURE_COMPLETE. A sentence line degrades to a legible
//    tag; a pill degrades to machine output wearing a badge.
//
// Every fact those chips carried is still on the screen. It is written out.
//
// The collapsed metadata reads c.external_id_formatted -- the DISPLAY form of
// the contact number, served only by the single-case projection
// (caseDetailProjection in routes/cases.js), never by the case list. It used
// to read c.external_id, the raw routing key, which GET /api/cases/:id has
// never returned: the field arrived only in the un-projected PATCH/transition
// response, so "copy contact" copied `undefined` on every reload and worked
// for exactly one render after an edit. Rendered only when the field is
// actually present, so a case object from any list-shaped source shows no
// dead affordance rather than an empty one.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn, IconButton, Icon } from '/design/src/components/shell.js';
import { state, schedule } from '../../state.js';
import { toast, undoToast } from '../../toasts.js';
import { fmtTime, rel, healthLabel } from '../../format.js';
import { postClaim, postSnooze } from '../../api.js';
import { todoHintText } from './todo-hint.js';

function tagList(tags) { return String(tags || '').split(',').map(s => s.trim()).filter(Boolean); }

const SNOWFLAKE_PAIR = /^\d{15,20}:\d{15,20}$/;

// Already display-formatted by the server (format.js fmtPhone27, the same
// formatter the contacts panel's external_id_formatted goes through), so this
// only handles the one shape a phone formatter passes through untouched: a
// Discord container:author pair, too long to read in full.
function contactNode(contact) {
    const s = String(contact || '');
    if (SNOWFLAKE_PAIR.test(s)) {
        return h('span', { class: 'casey-meta-id', title: s }, 'Discord: ' + s.slice(0, 6) + '...' + s.split(':')[1].slice(-6));
    }
    return h('span', {}, s);
}

function placeName(token) {
    const s = String(token || '').trim();
    return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function snoozedUntilTag(tags) {
    for (const t of tagList(tags)) {
        if (t.startsWith('snoozed-until:')) {
            const v = parseInt(t.slice('snoozed-until:'.length), 10);
            if (Number.isFinite(v) && v > Date.now()) return v;
        }
    }
    return null;
}

// One line per guardrail flag, in the words healthLabel already writes them
// in. They were chips; see this file's header for why they are not any more.
// A tag with no entry in format.js's HEALTH_LABEL still degrades to its own
// raw key here -- as a readable line rather than as an uppercase badge -- and
// that is a missing label to fix in format.js, not a state to hide.
function healthNotes(tags) {
    const list = tagList(tags).filter(t => t.indexOf('health:') === 0);
    if (!list.length) return null;
    return h('div', { class: 'casey-health-notes' }, ...list.map(t =>
        h('p', { key: t, class: 'casey-hint' }, healthLabel(t) + '.')));
}

// How the report reached us, written out. This is background, not status:
// nobody triages on it, they read it once when something about the report
// does not add up. A sentence at the size of the rest of the metadata is the
// honest weight for that.
const INTAKE_SENTENCE = {
    'intake_mode:channel': 'Came in as a chat message and was written up automatically.',
    'intake_mode:manual': 'Typed in by an operator.',
    'intake_mode:public_form': 'Came in through the public report form.',
};

function intakeNote(tags) {
    for (const t of tagList(tags)) {
        if (INTAKE_SENTENCE[t]) return h('p', { class: 'casey-hint' }, INTAKE_SENTENCE[t]);
    }
    return null;
}

const h = webjsx.createElement;

async function reloadCase(id, onReload) { if (onReload) await onReload(id); }

export function CaseHeader({ c, suggestedAssignee, onReload, onOpenShare, onOpenSnooze, key } = {}) {
    const disclosed = state._headerDisclosed === c.id;
    const setDisclosed = (v) => { state._headerDisclosed = v ? c.id : null; schedule(); };
    const isMine = state.currentUser && c.assignee === state.currentUser.username;
    const snoozeUntil = snoozedUntilTag(c.tags);
    const contact = c.external_id_formatted || '';

    // Claimed: the button is replaced by who has it, which is what the help
    // card promises. It was a chip, so an operator's own username reached the
    // screen shouted in caps as P-VANWYK; it is a name, so it is written as
    // one.
    const claimBtn = (c.assignee && c.assignee !== 'agent')
        ? h('span', { class: 'casey-claimed' }, isMine ? 'Yours' : 'Claimed by ' + c.assignee)
        : Btn({
            size: 'sm', variant: 'primary', children: 'Claim',
            onClick: async () => {
                if (!state.currentUser) { toast('Log in to claim a case.', 'warn'); return; }
                try {
                    await postClaim(c.id);
                    undoToast(c.id, 'Claimed -- this one is yours now', () => reloadCase(c.id, onReload));
                    await reloadCase(c.id, onReload);
                } catch (e) { toast('Could not claim this case', 'warn'); }
            }
        });

    const snoozeBtn = snoozeUntil
        ? Btn({
            size: 'sm', variant: 'ghost', children: 'Snoozed', 'aria-label': 'Snoozed until ' + fmtTime(snoozeUntil) + ' -- click to clear',
            onClick: async () => {
                try { await postSnooze(c.id, 0); toast('Snooze cleared'); await reloadCase(c.id, onReload); }
                catch (e) { toast('Could not clear snooze', 'warn'); }
            }
        })
        : Btn({ size: 'sm', variant: 'ghost', children: 'Snooze', onClick: () => onOpenSnooze && onOpenSnooze(c) });

    // The page is about the report, so the report is what the heading says.
    // The ref is the handle you quote on the phone, not the subject of the
    // page, and the automation notice is an aside about who answers next --
    // both sit under the heading now rather than above or instead of it.
    // Falls back to the ref when a case genuinely has no subject yet, so the
    // heading is never empty.
    return h('div', { key, class: 'casey-case-header' },
        h('div', { class: 'casey-case-header-top' },
            // The stage is NOT repeated here. It used to ride inside the
            // heading as a chip, which put it into the heading's accessible
            // name ("Cattle drooling and limping - possibly FMD WORKING ON
            // IT") and said, in a second vocabulary, exactly what the
            // progress rail below says with the sequence intact.
            h('h2', { class: 'casey-case-ref' }, c.subject || c.ref),
            claimBtn,
            snoozeBtn,
            IconButton({ icon: Icon('external-link'), title: 'Print report', onClick: () => window.open('/api/cases/' + encodeURIComponent(c.id) + '/report.html', '_blank') }),
            IconButton({ icon: Icon('link'), title: 'Share form with contact', onClick: () => onOpenShare && onOpenShare(c) }),
            // "suggested: k-dlamini" was a colon and a username. It is a
            // recommendation about a person, so it is worded as one, and the
            // reason it exists rides with it instead of only in a hover title
            // no phone can show.
            // matched_area is a lowercased index token off the learned-areas
            // list ("mpumalanga"), so it is capitalised on the way out -- it
            // is a place name in a sentence here, not a key.
            suggestedAssignee && (!c.assignee || c.assignee === 'agent')
                ? h('span', { class: 'casey-suggested' },
                    suggestedAssignee.name + ' has worked near ' + placeName(suggestedAssignee.matched_area) + ' before.')
                : null
        ),
        // .casey-case-ref is the pane's own heading rule (--fs-h1-app, weight
        // 600) and .casey-meta-id / .casey-hint are its own metadata and
        // small-note rules -- no new sizes are introduced here, the three
        // existing ones are just applied to the right three things.
        // Both classes deliberately: the mono face from .casey-meta-id (a ref
        // gets read down a phone line, so the digits have to be unambiguous)
        // at .casey-hint's size, which is the later rule in case-detail.css
        // and the one an operator can actually read on a handset.
        h('div', { class: 'casey-meta-id casey-hint' }, c.ref),
        h('p', { class: 'casey-hint' }, todoHintText(c)),
        healthNotes(c.tags),
        intakeNote(c.tags),
        h('div', { class: 'casey-case-meta' },
            h('button', {
                type: 'button', class: 'casey-meta-toggle',
                'aria-expanded': disclosed ? 'true' : 'false',
                onclick: () => setDisclosed(!disclosed)
            },
                Icon(disclosed ? 'chevron-down' : 'chevron-right', { size: 13 }),
                ' ', c.channel, ' details'
            ),
            disclosed ? h('div', { class: 'casey-meta-body' },
                contact ? contactNode(contact) : null,
                contact ? h('button', { type: 'button', class: 'casey-copy-btn', onclick: () => { try { navigator.clipboard.writeText(contact); toast('copied'); } catch { toast('copy failed', 'err'); } } }, 'copy contact') : null,
                h('span', {}, 'created ', rel(c.created_at))
            ) : null
        )
    );
}
