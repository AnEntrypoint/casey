import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn, IconButton, Icon, Heading } from '/design/src/components/shell.js';
import { state, schedule } from '../../state.js';
import { toast, undoToast } from '../../toasts.js';
import { fmtTime, rel, healthLabel, headline, channelLabel, NO_TIME_TEXT } from '../../format.js';
import { entityLabel } from '../../vocabulary.js';
import { teamRoster } from '../../api-roles.js';
import { postClaim, postSnooze } from '../../api.js';
import { todoHintText } from './todo-hint.js';
import { word } from '../../words.js';

function tagList(tags) { return String(tags || '').split(',').map(s => s.trim()).filter(Boolean); }

const SNOWFLAKE_PAIR = /^\d{15,20}:\d{15,20}$/;

function contactNode(contact) {
    const s = String(contact || '');
    if (SNOWFLAKE_PAIR.test(s)) {
        return h('span', { class: 'casey-meta-id', title: s }, word('ui.header_discord_contact', { head: s.slice(0, 6), tail: s.split(':')[1].slice(-6) }));
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
    'intake_mode:channel': 'ui.header_intake_channel',
    'intake_mode:manual': 'ui.header_intake_manual',
    'intake_mode:public_form': 'ui.header_intake_public_form',
};

function intakeNote(tags) {
    for (const t of tagList(tags)) {
        if (INTAKE_SENTENCE[t]) return h('p', { class: 'casey-hint' }, word(INTAKE_SENTENCE[t]));
    }
    return null;
}

const h = webjsx.createElement;

const PIN_HOW_KEY = { gps: 'ui.header_pin_how_gps', estimated: 'ui.header_pin_how_estimated', confirmed: 'ui.header_pin_how_confirmed' };
function pinLine(c) {
    const has = c && c.lat != null && c.lon != null && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lon));
    if (!has) return h('p', { class: 'casey-hint casey-pin-line' }, word('ui.header_no_pin'));
    const pct = Number.isFinite(Number(c.location_confidence)) && c.location_confidence != null ? Number(c.location_confidence) : null;
    const how = PIN_HOW_KEY[c.location_source] ? word(PIN_HOW_KEY[c.location_source]) : '';
    return h('p', { class: 'casey-hint casey-pin-line' },
        word('ui.header_pin', { lat: Number(c.lat).toFixed(4), lon: Number(c.lon).toFixed(4) })
        + (pct != null ? word('ui.header_pin_sure', { pct }) : '')
        + (how ? word('ui.header_pin_how', { how }) : ''));
}

function reporterLine(reporter) {
    if (!reporter) return null;
    const by = reporter.reported_by;
    if (!by && !reporter.shared_phone) return null;
    const who = by
        ? word('ui.header_reported_by', { name: String(by.name) }) + (by.relation ? word('ui.header_relation', { relation: String(by.relation) }) : '')
        : word('ui.header_not_recorded');
    return h('p', { class: 'casey-hint casey-reporter-line' }, who + (reporter.shared_phone ? word('ui.header_shared_phone', { people: String(reporter.people_on_phone) }) : ''));
}

async function reloadCase(id, onReload) { if (onReload) await onReload(id); }

export function CaseHeader({ c, suggestedAssignee, reporter, onReload, onOpenShare, onOpenSnooze, key } = {}) {
    const disclosed = state._headerDisclosed === c.id;
    const setDisclosed = (v) => { state._headerDisclosed = v ? c.id : null; schedule(); };
    const isMine = state.currentUser && c.assignee === state.currentUser.username;
    const snoozeUntil = snoozedUntilTag(c.tags);
    const contact = c.external_id_formatted || '';

    const claimBtn = (c.assignee && c.assignee !== 'agent')
        ? h('span', { class: 'casey-claimed' }, isMine
            ? word('ui.header_yours')
            : word('ui.header_claimed_by', { name: String(((teamRoster().find((m) => m.key === c.assignee) || {}).name || c.assignee_name || c.assignee)) }))
        : Btn({
            size: 'sm', variant: 'primary', children: word('ui.header_claim'),
            onClick: async () => {
                if (!state.currentUser) { toast(word('ui.header_log_in_to_claim', { entity: entityLabel() }), 'warn'); return; }
                try {
                    await postClaim(c.id);
                    undoToast(c.id, word('ui.header_claimed_undo'), () => reloadCase(c.id, onReload));
                    await reloadCase(c.id, onReload);
                } catch (e) { toast(word('ui.header_claim_failed', { entity: entityLabel() }), 'warn'); }
            }
        });

    const snoozeBtn = snoozeUntil
        ? Btn({
            size: 'sm', variant: 'ghost', children: word('ui.header_snoozed'),
            'aria-label': word('ui.header_snoozed_label', { time: fmtTime(snoozeUntil) || NO_TIME_TEXT }),
            onClick: async () => {
                try { await postSnooze(c.id, 0); toast(word('ui.header_snooze_cleared')); await reloadCase(c.id, onReload); }
                catch (e) { toast(word('ui.header_snooze_failed'), 'warn'); }
            }
        })
        : Btn({ size: 'sm', variant: 'ghost', children: word('ui.header_snooze'), onClick: () => onOpenSnooze && onOpenSnooze(c) });

    return h('div', { key, class: 'casey-case-header' },
        h('div', { class: 'casey-case-header-top' },
            Heading({ level: 2, class: 'casey-case-ref-text', children: headline(c.subject || c.ref) }),
            claimBtn,
            snoozeBtn,
            IconButton({ icon: Icon('external-link'), title: word('ui.header_print_title', { entity: entityLabel() }), onClick: () => window.open('/api/cases/' + encodeURIComponent(c.id) + '/report.html', '_blank') }),
            IconButton({ icon: Icon('link'), title: word('ui.header_share_title'), onClick: () => onOpenShare && onOpenShare(c) }),
            suggestedAssignee && (!c.assignee || c.assignee === 'agent')
                ? h('span', { class: 'casey-suggested' },
                    word('ui.header_suggested', { name: String(suggestedAssignee.name), area: placeName(suggestedAssignee.matched_area) }))
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
                ' ', channelLabel(c.channel), word('ui.header_details')
            ),
            disclosed ? h('div', { class: 'casey-meta-body' },
                contact ? contactNode(contact) : null,
                contact ? Btn({ variant: 'link', size: 'sm', children: word('ui.header_copy_contact'), onClick: async () => { try { await navigator.clipboard.writeText(contact); toast(word('ui.header_contact_copied')); } catch { toast(word('ui.header_copy_failed'), 'err'); } } }) : null,
                h('span', {}, word('ui.header_created'), rel(c.created_at))
            ) : null
        )
    );
}
