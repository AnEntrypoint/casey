import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn, IconButton, Icon, Heading } from '/design/src/components/shell.js';
import { state, schedule } from '../../state.js';
import { toast, undoToast } from '../../toasts.js';
import { fmtTime, rel, healthLabel, headline, channelLabel } from '../../format.js';
import { entityLabel } from '../../vocabulary.js';
import { teamRoster } from '../../api-roles.js';
import { postClaim, postSnooze } from '../../api.js';
import { todoHintText } from './todo-hint.js';

function tagList(tags) { return String(tags || '').split(',').map(s => s.trim()).filter(Boolean); }

const SNOWFLAKE_PAIR = /^\d{15,20}:\d{15,20}$/;

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

function healthNotes(tags) {
    const list = tagList(tags).filter(t => t.indexOf('health:') === 0);
    if (!list.length) return null;
    return h('div', { class: 'casey-health-notes' }, ...list.map(t =>
        h('p', { key: t, class: 'casey-hint' }, healthLabel(t) + '.')));
}

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

const PIN_HOW = { gps: 'GPS', estimated: 'estimated from the place named', confirmed: 'confirmed by the reporter' };
function pinLine(c) {
    const has = c && c.lat != null && c.lon != null && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lon));
    if (!has) return h('p', { class: 'casey-hint casey-pin-line' }, 'No pin yet');
    const pct = Number.isFinite(Number(c.location_confidence)) && c.location_confidence != null ? Number(c.location_confidence) : null;
    const how = PIN_HOW[c.location_source] || '';
    return h('p', { class: 'casey-hint casey-pin-line' }, 'Pin ' + Number(c.lat).toFixed(4) + ', ' + Number(c.lon).toFixed(4) + (pct != null ? ', ' + pct + '% sure' : '') + (how ? ' (' + how + ')' : ''));
}

function reporterLine(reporter) {
    if (!reporter) return null;
    const by = reporter.reported_by;
    if (!by && !reporter.shared_phone) return null;
    const who = by ? 'Reported by ' + by.name + (by.relation ? ' (' + by.relation + ')' : '') : 'Reporter not recorded';
    return h('p', { class: 'casey-hint casey-reporter-line' }, who + (reporter.shared_phone ? ', shared phone: ' + reporter.people_on_phone + ' people' : ''));
}

async function reloadCase(id, onReload) { if (onReload) await onReload(id); }

export function CaseHeader({ c, suggestedAssignee, reporter, onReload, onOpenShare, onOpenSnooze, key } = {}) {
    const disclosed = state._headerDisclosed === c.id;
    const setDisclosed = (v) => { state._headerDisclosed = v ? c.id : null; schedule(); };
    const isMine = state.currentUser && c.assignee === state.currentUser.username;
    const snoozeUntil = snoozedUntilTag(c.tags);
    const contact = c.external_id_formatted || '';

    const claimBtn = (c.assignee && c.assignee !== 'agent')
        ? h('span', { class: 'casey-claimed' }, isMine ? 'Yours' : 'Claimed by ' + ((teamRoster().find((m) => m.key === c.assignee) || {}).name || c.assignee_name || c.assignee))
        : Btn({
            size: 'sm', variant: 'primary', children: 'Claim',
            onClick: async () => {
                if (!state.currentUser) { toast('Log in to claim a ' + entityLabel() + '.', 'warn'); return; }
                try {
                    await postClaim(c.id);
                    undoToast(c.id, 'Claimed -- this one is yours now', () => reloadCase(c.id, onReload));
                    await reloadCase(c.id, onReload);
                } catch (e) { toast('Could not claim this ' + entityLabel() + ' -- somebody else may have taken it first. Reload to see who has it.', 'warn'); }
            }
        });

    const snoozeBtn = snoozeUntil
        ? Btn({
            size: 'sm', variant: 'ghost', children: 'Snoozed', 'aria-label': 'Snoozed until ' + fmtTime(snoozeUntil) + ' -- click to clear',
            onClick: async () => {
                try { await postSnooze(c.id, 0); toast('Snooze cleared -- this is back in the queue.'); await reloadCase(c.id, onReload); }
                catch (e) { toast('The snooze could not be cleared, so this is still hidden from the queue. Try again.', 'warn'); }
            }
        })
        : Btn({ size: 'sm', variant: 'ghost', children: 'Snooze', onClick: () => onOpenSnooze && onOpenSnooze(c) });

    return h('div', { key, class: 'casey-case-header' },
        h('div', { class: 'casey-case-header-top' },
            Heading({ level: 2, class: 'casey-case-ref-text', children: headline(c.subject || c.ref) }),
            claimBtn,
            snoozeBtn,
            IconButton({ icon: Icon('external-link'), title: 'Print this ' + entityLabel(), onClick: () => window.open('/api/cases/' + encodeURIComponent(c.id) + '/report.html', '_blank') }),
            IconButton({ icon: Icon('link'), title: 'Share form with contact', onClick: () => onOpenShare && onOpenShare(c) }),
            suggestedAssignee && (!c.assignee || c.assignee === 'agent')
                ? h('span', { class: 'casey-suggested' },
                    suggestedAssignee.name + ' has worked near ' + placeName(suggestedAssignee.matched_area) + ' before.')
                : null
        ),
        h('div', { class: 'casey-meta-id casey-hint' }, c.ref),
        h('p', { class: 'casey-hint' }, todoHintText(c)),
        reporterLine(reporter),
        pinLine(c),
        healthNotes(c.tags),
        intakeNote(c.tags),
        h('div', { class: 'casey-case-meta' },
            h('button', {
                type: 'button', class: 'casey-meta-toggle',
                'aria-expanded': disclosed ? 'true' : 'false',
                onclick: () => setDisclosed(!disclosed)
            },
                Icon(disclosed ? 'chevron-down' : 'chevron-right', { size: 13 }),
                ' ', channelLabel(c.channel), ' details'
            ),
            disclosed ? h('div', { class: 'casey-meta-body' },
                contact ? contactNode(contact) : null,
                contact ? Btn({ variant: 'link', size: 'sm', children: 'Copy contact', onClick: async () => { try { await navigator.clipboard.writeText(contact); toast('Contact copied to the clipboard.'); } catch { toast('This browser would not let the page copy. Select the number above and copy it by hand.', 'err'); } } }) : null,
                h('span', {}, 'created ', rel(c.created_at))
            ) : null
        )
    );
}
