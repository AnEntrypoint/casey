// header.js -- the case's own heading (its subject), the ref line beneath it,
// channel + contact metadata collapsed under a toggle, claim button, snooze
// control, share/print links, health badge chips, intake-mode badge, and the
// one-line "what happens next" note mirroring caseHints' ladder.
//
// The heading is the SUBJECT and the note about who answers is an aside. It
// used to be the other way round: the ref led, and the automation notice
// rendered as a Lede at the pane's largest type, so a suspected
// foot-and-mouth report was announced by a sentence about the AI helper.
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
import { Btn, IconButton, Chip, Icon } from '/design/src/components/shell.js';
import { state, schedule } from '../../state.js';
import { toast, undoToast } from '../../toasts.js';
import { fmtTime, rel, healthLabel, stageLabel } from '../../format.js';
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

function snoozedUntilTag(tags) {
    for (const t of tagList(tags)) {
        if (t.startsWith('snoozed-until:')) {
            const v = parseInt(t.slice('snoozed-until:'.length), 10);
            if (Number.isFinite(v) && v > Date.now()) return v;
        }
    }
    return null;
}

function healthBadges(tags) {
    const list = tagList(tags).filter(t => t.indexOf('health:') === 0);
    if (!list.length) return null;
    return h('div', { class: 'casey-health-badges' }, ...list.map(t =>
        h('span', { key: t, title: t }, Chip({ tone: 'warn', children: healthLabel(t) }))));
}

function intakeModeBadge(tags) {
    const t = tagList(tags);
    const parts = [];
    if (t.includes('intake_mode:channel')) parts.push(Chip({ tone: 'accent', size: 'sm', children: 'AI channel' }));
    if (t.includes('intake_mode:manual')) parts.push(Chip({ tone: 'ok', size: 'sm', children: 'Operator entry' }));
    if (t.includes('intake_mode:public_form')) parts.push(Chip({ tone: '', size: 'sm', children: 'Public form' }));
    if (!parts.length) return null;
    return h('span', { class: 'casey-intake-badge', title: 'How this case was created' }, ...parts);
}

const h = webjsx.createElement;

async function reloadCase(id, onReload) { if (onReload) await onReload(id); }

export function CaseHeader({ c, suggestedAssignee, onReload, onOpenShare, onOpenSnooze, key } = {}) {
    const disclosed = state._headerDisclosed === c.id;
    const setDisclosed = (v) => { state._headerDisclosed = v ? c.id : null; schedule(); };
    const isMine = state.currentUser && c.assignee === state.currentUser.username;
    const snoozeUntil = snoozedUntilTag(c.tags);
    const contact = c.external_id_formatted || '';

    const claimBtn = (c.assignee && c.assignee !== 'agent')
        ? Chip({ tone: isMine ? 'accent' : '', children: isMine ? 'yours' : c.assignee })
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
            h('h2', { class: 'casey-case-ref' }, c.subject || c.ref, ' ',
                Chip({ tone: c.status === 'closed' ? '' : 'accent', children: stageLabel(c.status) })),
            claimBtn,
            snoozeBtn,
            IconButton({ icon: Icon('external-link'), title: 'Print report', onClick: () => window.open('/api/cases/' + encodeURIComponent(c.id) + '/report.html', '_blank') }),
            IconButton({ icon: Icon('link'), title: 'Share form with contact', onClick: () => onOpenShare && onOpenShare(c) }),
            suggestedAssignee && (!c.assignee || c.assignee === 'agent')
                ? h('span', { class: 'casey-suggested', title: 'Based on ' + suggestedAssignee.name + '\'s past work near ' + suggestedAssignee.matched_area }, 'suggested: ' + suggestedAssignee.name)
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
        healthBadges(c.tags),
        intakeModeBadge(c.tags),
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
