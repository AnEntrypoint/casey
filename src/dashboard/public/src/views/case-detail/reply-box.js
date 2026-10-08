import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn } from '/design/src/components/shell.js';
import { TextField, Alert } from '/design/src/components/content.js';
import { state, schedule } from '../../state.js';
import { toast, replyUndoToast, failMsg } from '../../toasts.js';
import { api, postDraftApprove, postDraftDiscard, postCaseRemind } from '../../api.js';
import { confirmDialog } from '../../components/dialog-shell.js';
import { channelLabel, replyChannelLabel } from '../../format.js';
import { entityLabel } from '../../vocabulary.js';
import { word } from '../../words.js';
const h = webjsx.createElement;

const REPLY_MAXLEN = 4096;

function tagList(c) { return String(c && c.tags || '').split(',').map(t => t.trim()).filter(Boolean); }
function caseHasDraft(c) { return tagList(c).includes('draft-pending'); }
function latestDraft(events) { const d = (events || []).filter(e => e.kind === 'draft'); return d.length ? d[d.length - 1] : null; }
function draftText(c, events) { if (!caseHasDraft(c)) return ''; const d = latestDraft(events); return (d && d.text) || ''; }

function cannedReplies(c) {
    const tags = tagList(c);
    if (tags.includes('opted-out')) return [];
    if (tags.includes('needs-human')) return [
        word('ui.reply_box_canned_human_hi'),
        word('ui.reply_box_canned_human_help'),
        word('ui.reply_box_canned_human_wait'),
    ];
    if (c.status === 'waiting') return [
        word('ui.reply_box_canned_waiting_checkin'),
        word('ui.reply_box_canned_waiting_norush'),
    ];
    return [
        word('ui.reply_box_canned_thanks'),
        word('ui.reply_box_canned_got'),
        word('ui.reply_box_canned_more'),
    ];
}

export function ReplyBox({ c, events, onReload, key } = {}) {
    const draftKey = 'reply:' + c.id;
    if (state._replyDraft == null || state._replyDraftFor !== c.id) {
        state._replyDraft = draftText(c, events);
        state._replyDraftFor = c.id;
    }
    const text = state._replyDraft || '';
    const sending = !!state._replySending;

    const setText = (v) => { state._replyDraft = v; schedule(); };

    const send = async () => {
        const t = text.trim();
        if (!t || sending) return;
        state._replySending = true; schedule();
        try {
            const r = await api('/api/cases/' + encodeURIComponent(c.id) + '/reply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t }) });
            state._replySending = false;
            if (!r.ok) { toast(await failMsg(r, word('ui.reply_box_failed_send')), 'err'); schedule(); return; }
            const j = await r.json().catch(() => ({}));
            state._replyDraft = '';
            if (j.delivered) replyUndoToast(c.id, () => onReload && onReload(c.id));
            else if (j.sent) toast(word('ui.reply_box_sent_refused_check'), 'warn');
            else toast(word('ui.reply_box_saved_only_contact'), 'warn');
            if (onReload) await onReload(c.id);
        } catch (e) { state._replySending = false; toast(await failMsg(e, word('ui.reply_box_reply_failed')), 'err'); schedule(); }
    };

    const cans = cannedReplies(c);
    const draftPending = caseHasDraft(c);

    const draftBanner = draftPending
        ? Alert({
            kind: 'warn', title: word('ui.reply_box_draft_title'),
            children: h('div', { class: 'casey-draft-actions' },
                Btn({ size: 'sm', variant: 'primary', disabled: sending, children: sending ? word('ui.reply_box_sending') : word('ui.reply_box_approve'), onClick: async () => {
                    const t = text.trim();
                    if (sending) return;
                    state._replySending = true; schedule();
                    try {
                        const j = await postDraftApprove(c.id, t);
                        state._replySending = false;
                        if (j.delivered) toast(word('ui.reply_box_draft_sent'), 'ok');
                        else toast(j.sent
                            ? word('ui.reply_box_sent_refused_contact')
                            : word('ui.reply_box_saved_only_contact'), 'warn');
                        if (onReload) await onReload(c.id);
                    } catch (e) { state._replySending = false; toast(await failMsg(e, word('ui.reply_box_draft_failed')), 'err'); schedule(); }
                } }),
                Btn({ size: 'sm', variant: 'ghost', disabled: sending, children: word('ui.reply_box_discard'), onClick: async () => {
                    if (sending) return;
                    if (await confirmDialog({ title: word('ui.reply_box_discard_title'), message: word('ui.reply_box_discard_message'), confirmLabel: word('ui.reply_box_discard'), danger: true }) === null) return;
                    state._replySending = true; schedule();
                    try { await postDraftDiscard(c.id); state._replySending = false; toast(word('ui.reply_box_discard_done'), 'ok'); if (onReload) await onReload(c.id); }
                    catch (e) { state._replySending = false; toast(await failMsg(e, word('ui.reply_box_discard_failed')), 'err'); schedule(); }
                } })
            )
        })
        : null;

    return h('div', { key, class: 'casey-reply-box' },
        draftBanner,
        h('label', { class: 'casey-reply-label' }, replyChannelLabel(c.channel)
            ? word('ui.reply_box_reply_on', { channel: replyChannelLabel(c.channel) })
            : word('ui.reply_box_reply_to')),
        replyChannelLabel(c.channel) ? null : Alert({ kind: 'warn', children: word('ui.reply_box_no_app', { entity: entityLabel(), channel: channelLabel(c.channel) }) }),
        h('div', { onkeydown: (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); } } },
            TextField({
                multiline: true, rows: 3, value: text, maxLength: REPLY_MAXLEN,
                placeholder: word('ui.reply_box_placeholder'),
                onInput: setText,
            })),
        cans.length ? h('div', { class: 'casey-canned-wrap' },
            h('p', { class: 'casey-canned-lab' }, text.trim() ? word('ui.reply_box_tap_add') : word('ui.reply_box_tap_start')),
            h('div', { class: 'casey-canned' }, ...cans.map((t, i) => h('button', {
                key: i, type: 'button', class: 'casey-canned-btn',
                onclick: () => { const cur = state._replyDraft || ''; setText(cur.trim() ? cur.replace(/\s+$/, '') + '\n\n' + t : t); }
            }, t)))
        ) : null,
        h('div', {
            class: 'casey-reply-send-row',
        },
            Btn({ variant: 'primary', disabled: sending || !text.trim(), children: sending ? word('ui.reply_box_sending') : word('ui.reply_box_send'), onClick: send }),
            Btn({
                size: 'sm', variant: 'ghost', disabled: sending,
                children: sending ? word('ui.reply_box_sending') : word('ui.reply_box_ask_report'),
                onClick: async () => {
                    if (sending) return;
                    if (await confirmDialog({
                        title: word('ui.reply_box_remind_title'),
                        message: word('ui.reply_box_remind_message', { channel: replyChannelLabel(c.channel) || word('ui.reply_box_their_channel') }),
                        confirmLabel: word('ui.reply_box_remind_confirm'),
                    }) === null) return;
                    state._replySending = true; schedule();
                    try {
                        const j = await postCaseRemind(c.id);
                        state._replySending = false;
                        if (j.delivered) toast(word('ui.reply_box_remind_done'), 'ok');
                        else toast(j.sent
                            ? word('ui.reply_box_remind_refused')
                            : word('ui.reply_box_remind_nosend'), 'warn');
                        if (onReload) await onReload(c.id);
                    } catch (e) {
                        state._replySending = false;
                        toast(await failMsg(e, word('ui.reply_box_remind_failed')), 'err'); schedule();
                    }
                },
            })
        )
    );
}
