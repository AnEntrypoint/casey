// header.js -- ref/channel disclosure (ux-case-detail-channel-ref-disclosure:
// ref prominent, channel + external-id-free metadata collapsed under a
// toggle), claim button, snooze control, share/print links, health badge
// chips, intake-mode badge, and the plain-language flag summary
// (ux-ai-plain-language-flag-summary: the same caseHints-mirroring
// todo-hint text, also surfaced as a standalone Lede up top).

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn, IconButton, Chip, Lede, Icon } from '/design/src/components/shell.js';
import { state, schedule } from '../../state.js';
import { toast, undoToast } from '../../toasts.js';
import { fmtPhone, fmtTime, rel, healthLabel } from '../../format.js';
import { postClaim, postSnooze } from '../../api.js';
import { todoHintText } from './todo-hint.js';

function tagList(tags) { return String(tags || '').split(',').map(s => s.trim()).filter(Boolean); }

const SNOWFLAKE_PAIR = /^\d{15,20}:\d{15,20}$/;

function externalIdNode(externalId) {
    const s = String(externalId || '');
    if (SNOWFLAKE_PAIR.test(s)) {
        return h('span', { class: 'casey-meta-id', title: s }, 'Discord: ' + s.slice(0, 6) + '...' + s.split(':')[1].slice(-6));
    }
    return h('span', {}, fmtPhone(externalId));
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

    return h('div', { key, class: 'casey-case-header' },
        h('div', { class: 'casey-case-header-top' },
            h('h2', { class: 'casey-case-ref' }, c.ref, ' ',
                Chip({ tone: c.status === 'closed' ? '' : 'accent', children: c.status })),
            claimBtn,
            snoozeBtn,
            IconButton({ icon: Icon('external-link'), title: 'Print report', onClick: () => window.open('/api/cases/' + encodeURIComponent(c.id) + '/report.html', '_blank') }),
            IconButton({ icon: Icon('link'), title: 'Share form with contact', onClick: () => onOpenShare && onOpenShare(c) }),
            suggestedAssignee && (!c.assignee || c.assignee === 'agent')
                ? h('span', { class: 'casey-suggested', title: 'Based on ' + suggestedAssignee.name + '\'s past work near ' + suggestedAssignee.matched_area }, 'suggested: ' + suggestedAssignee.name)
                : null
        ),
        Lede({ children: todoHintText(c) }),
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
                externalIdNode(c.external_id),
                h('button', { type: 'button', class: 'casey-copy-btn', onclick: () => { try { navigator.clipboard.writeText(c.external_id); toast('copied'); } catch { toast('copy failed', 'err'); } } }, 'copy contact'),
                h('span', {}, 'created ', rel(c.created_at))
            ) : null
        )
    );
}
