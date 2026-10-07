import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn } from '/design/src/components/shell.js';
import { TextField, Alert } from '/design/src/components/content.js';
import { state, schedule } from '../../state.js';
import { toast, replyUndoToast, failMsg } from '../../toasts.js';
import { api, postDraftApprove, postDraftDiscard, postCaseRemind } from '../../api.js';
import { confirmDialog } from '../../components/dialog-shell.js';
import { channelLabel, replyChannelLabel } from '../../format.js';
import { entityLabel } from '../../vocabulary.js';
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
        'Hi, this is a real person now. How can I help you?',
        'I am here to help. Can you tell me a bit more?',
        'Thank you for waiting. I am looking into this for you now.'
    ];
    if (c.status === 'waiting') return [
        'Just checking in - are you still there? Reply when you can.',
        'No rush. I am still here whenever you are ready.'
    ];
    return [
        'Thanks for your message. I am looking into this now.',
        'Got it - I will get back to you shortly.',
        'Can you tell me a little more so I can help?'
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
            if (!r.ok) { toast(await failMsg(r, 'The reply was not sent and nothing was recorded. Your text is still in the box -- try again.'), 'err'); schedule(); return; }
            const j = await r.json().catch(() => ({}));
            state._replyDraft = '';
            if (j.delivered) replyUndoToast(c.id, () => onReload && onReload(c.id));
            else if (j.sent) toast('Saved to the timeline, but the channel refused it. The contact has NOT received this. Check the timeline.', 'warn');
            else toast('Saved to the timeline only. This screen is not connected to WhatsApp, so nothing was sent to the contact.', 'warn');
            if (onReload) await onReload(c.id);
        } catch (e) { state._replySending = false; toast(await failMsg(e, 'The reply did not go out. Your text is still in the box -- try again.'), 'err'); schedule(); }
    };

    const cans = cannedReplies(c);
    const draftPending = caseHasDraft(c);

    const draftBanner = draftPending
        ? Alert({
            kind: 'warn', title: 'The AI helper drafted a reply. Review it before it sends.',
            children: h('div', { class: 'casey-draft-actions' },
                Btn({ size: 'sm', variant: 'primary', disabled: sending, children: sending ? 'Sending...' : 'Approve & send', onClick: async () => {
                    const t = text.trim();
                    if (sending) return;
                    state._replySending = true; schedule();
                    try {
                        const j = await postDraftApprove(c.id, t);
                        state._replySending = false;
                        if (j.delivered) toast('Draft sent to the contact.', 'ok');
                        else toast(j.sent
                            ? 'Saved to the timeline, but the channel refused it. The contact has NOT received this.'
                            : 'Saved to the timeline only. This screen is not connected to WhatsApp, so nothing was sent to the contact.', 'warn');
                        if (onReload) await onReload(c.id);
                    } catch (e) { state._replySending = false; toast(await failMsg(e, 'The draft was not sent and is still waiting here. Try again.'), 'err'); schedule(); }
                } }),
                Btn({ size: 'sm', variant: 'ghost', disabled: sending, children: 'Discard', onClick: async () => {
                    if (sending) return;
                    if (await confirmDialog({ title: 'Discard this draft?', message: 'It will not be sent. The case stays flagged for a human.', confirmLabel: 'Discard', danger: true }) === null) return;
                    state._replySending = true; schedule();
                    try { await postDraftDiscard(c.id); state._replySending = false; toast('Draft discarded. Nothing was sent, and this still needs a person.', 'ok'); if (onReload) await onReload(c.id); }
                    catch (e) { state._replySending = false; toast(await failMsg(e, 'The draft could not be discarded, so it is still waiting here. Try again.'), 'err'); schedule(); }
                } })
            )
        })
        : null;

    return h('div', { key, class: 'casey-reply-box' },
        draftBanner,
        h('label', { class: 'casey-reply-label' }, replyChannelLabel(c.channel)
            ? 'Reply to contact on ' + replyChannelLabel(c.channel)
            : 'Reply to contact'),
        replyChannelLabel(c.channel) ? null : Alert({ kind: 'warn', children: 'This ' + entityLabel() + ' came in ' + channelLabel(c.channel) + ', so there is no app to reply on. Anything sent here is recorded on the timeline only -- reach the person another way.' }),
        h('div', { onkeydown: (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); } } },
            TextField({
                multiline: true, rows: 3, value: text, maxLength: REPLY_MAXLEN,
                placeholder: 'Type your reply here. Ctrl+Enter sends it.',
                onInput: setText,
            })),
        cans.length ? h('div', { class: 'casey-canned-wrap' },
            h('p', { class: 'casey-canned-lab' }, text.trim() ? 'Or tap a ready-made reply to add to the end:' : 'Or tap a ready-made reply to start with:'),
            h('div', { class: 'casey-canned' }, ...cans.map((t, i) => h('button', {
                key: i, type: 'button', class: 'casey-canned-btn',
                onclick: () => { const cur = state._replyDraft || ''; setText(cur.trim() ? cur.replace(/\s+$/, '') + '\n\n' + t : t); }
            }, t)))
        ) : null,
        h('div', {
            class: 'casey-reply-send-row',
        },
            Btn({ variant: 'primary', disabled: sending || !text.trim(), children: sending ? 'Sending...' : 'Send reply', onClick: send }),
            Btn({
                size: 'sm', variant: 'ghost', disabled: sending,
                children: sending ? 'Sending...' : 'Ask them to report back',
                onClick: async () => {
                    if (sending) return;
                    if (await confirmDialog({
                        title: 'Ask this person to report back?',
                        message: 'Sends them ONE short message on ' + (replyChannelLabel(c.channel) || 'their channel')
                            + ', asking if anything has changed. It names their reference and how long it has been, and nothing else -- you will see exactly what went out on the timeline.'
                            + ' It will not send if they asked us to stop, if their channel is outside its reply window, or if they have already been asked and have not written back.',
                        confirmLabel: 'Send the reminder',
                    }) === null) return;
                    state._replySending = true; schedule();
                    try {
                        const j = await postCaseRemind(c.id);
                        state._replySending = false;
                        if (j.delivered) toast('Asked them to report back.', 'ok');
                        else toast(j.sent
                            ? 'Saved to the timeline, but the channel refused it. They have NOT received this.'
                            : 'Saved to the timeline only. This screen is not connected to WhatsApp, so nothing was sent.', 'warn');
                        if (onReload) await onReload(c.id);
                    } catch (e) {
                        state._replySending = false;
                        toast(await failMsg(e, 'Nothing was sent. Try again.'), 'err'); schedule();
                    }
                },
            })
        )
    );
}
