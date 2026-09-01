// reply-box.js -- TextField(multiline) reply composer, char counter
// (TextField's own maxLength counter), Ctrl+Enter send, canned-replies
// Dropdown (context-dependent, empty when opted out), draft banner
// (ux-ai-draft-state-and-actions: Alert-based approve/discard for
// assisted-mode held drafts), correction "take it back" toast wiring.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn } from '/design/src/components/shell.js';
import { TextField, Alert } from '/design/src/components/content.js';
import { Dropdown } from '/design/src/components/overlay-primitives.js';
import { state, schedule } from '../../state.js';
import { toast, undoToast, replyUndoToast, failMsg } from '../../toasts.js';
import { api, postDraftApprove, postDraftDiscard } from '../../api.js';
import { confirmDialog } from '../../components/dialog-shell.js';
const h = webjsx.createElement;

const REPLY_MAXLEN = 4096;

function tagList(c) { return String(c && c.tags || '').split(',').map(t => t.trim()).filter(Boolean); }
function caseHasDraft(c) { return tagList(c).includes('draft-pending'); }
function latestDraft(events) { const d = (events || []).filter(e => e.kind === 'draft'); return d.length ? d[d.length - 1] : null; }
function draftText(c, events) { if (!caseHasDraft(c)) return ''; const d = latestDraft(events); return (d && d.text) || ''; }

const NON_EN_WORDS = /\b(dankie|asseblief|hallo|goeie|siek|beeste|ngiyabonga|siyabonga|sawubona|izinkomo|usizo|enkosi|molo|nceda|iinkomo|dumela|kea leboha|dikgomo)\b/i;
function contactMaybeNonEnglish(events) {
    const lastIn = (events || []).filter(e => e.kind === 'inbound').slice(-1)[0];
    const txt = lastIn && lastIn.text;
    if (!txt) return false;
    for (let i = 0; i < txt.length; i++) { if (txt.charCodeAt(i) > 127) return true; }
    return NON_EN_WORDS.test(txt);
}

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
            if (!r.ok) { toast(await failMsg(r, 'send failed'), 'err'); schedule(); return; }
            const j = await r.json().catch(() => ({}));
            state._replyDraft = '';
            if (j.delivered) replyUndoToast(c.id, () => onReload && onReload(c.id));
            else toast(j.sent ? 'reply sent but it did not reach the contact - check the timeline' : 'reply logged (channel not connected)', 'ok');
            if (onReload) await onReload(c.id);
        } catch (e) { state._replySending = false; toast('send error: ' + e.message, 'err'); schedule(); }
    };

    const cans = cannedReplies(c);
    const draftPending = caseHasDraft(c);

    const draftBanner = draftPending
        ? Alert({
            kind: 'warn', title: 'AI drafted a reply -- review before it sends.',
            children: h('div', { class: 'casey-draft-actions' },
                Btn({ size: 'sm', variant: 'primary', children: 'Approve & send', onClick: async () => {
                    const t = text.trim();
                    try {
                        const j = await postDraftApprove(c.id, t);
                        toast(j.delivered ? 'draft sent' : 'draft logged (channel not connected)', 'ok');
                        if (onReload) await onReload(c.id);
                    } catch (e) { toast(await failMsg(e, 'approve failed'), 'err'); }
                } }),
                Btn({ size: 'sm', variant: 'ghost', children: 'Discard', onClick: async () => {
                    if (await confirmDialog({ title: 'Discard this draft?', message: 'It will not be sent. The case stays flagged for a human.', confirmLabel: 'Discard', danger: true }) === null) return;
                    try { await postDraftDiscard(c.id); toast('draft discarded', 'ok'); if (onReload) await onReload(c.id); }
                    catch (e) { toast(await failMsg(e, 'discard failed'), 'err'); }
                } })
            )
        })
        : null;

    return h('div', { key, class: 'casey-reply-box' },
        draftBanner,
        h('label', { class: 'casey-reply-label' }, 'Reply to contact on ' + c.channel),
        TextField({
            multiline: true, rows: 3, value: text, maxLength: REPLY_MAXLEN,
            placeholder: 'Send a message as a human operator... (Ctrl+Enter to send)',
            onInput: setText,
        }),
        contactMaybeNonEnglish(events) ? Alert({ kind: 'warn', children: 'This person may not be writing in English. Please reply in their language.' }) : null,
        cans.length ? h('div', { class: 'casey-canned-wrap' },
            h('p', { class: 'casey-canned-lab' }, 'Or tap a ready-made reply to start with:'),
            h('div', { class: 'casey-canned' }, ...cans.map((t, i) => h('button', {
                key: i, type: 'button', class: 'casey-canned-btn',
                onclick: () => setText(t)
            }, t)))
        ) : null,
        h('div', {
            class: 'casey-reply-send-row',
            onkeydown: (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); } }
        },
            Btn({ variant: 'primary', disabled: sending || !text.trim(), children: sending ? 'Sending...' : 'Send reply', onClick: send })
        )
    );
}
