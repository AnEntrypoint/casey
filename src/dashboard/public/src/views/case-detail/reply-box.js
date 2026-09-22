// The reply composer: a multiline TextField with Ctrl+Enter send, a row of
// context-dependent canned openers, the assisted-mode draft banner (approve or
// discard a held draft), and the "take it back" correction toast a sent reply
// gets instead of an undo it cannot have.

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

// There is deliberately no per-language word list here, and no
// "this person may not be writing in English" guess of any kind. The timeline
// sitting directly above this box already carries the contact's own messages
// verbatim, so their language is on the screen in full, for any language on
// earth, before an operator types a character -- a guess adds nothing an
// operator cannot already read, and a word list can only ever recognise the
// languages whoever wrote it happened to think of. It also baked one country's
// language set into casey's own generic source, which every deployment
// inherits unchanged. Where a deployment's report-fields.yml declares a field
// for it, the model's own reading of the language is recorded there too and
// report-sections.js renders it from the live /api/config like any other
// field. Do not reintroduce a guess: the agent already mirrors the contact's
// language in its own replies (hooks/prompt-sections.js), and
// help-overlay.js states the one thing true of every case -- that the
// mirroring is the agent's, and an operator typing here does it themselves.
function cannedReplies(c) {
    const tags = tagList(c);
    // 'opted-out' is a legal control (the contact said STOP). Its one
    // definition is src/hooks/heuristics.js's OPTED_OUT_TAG, which a browser
    // module cannot import -- so this literal must be changed in step with it,
    // and with todo-hint.js's own copy. Renaming the tag server-side without
    // these silently re-offers canned replies to someone who opted out.
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
            // Three genuinely different outcomes, and only one of them is
            // "the person has your message". The response says which: `sent`
            // is whether this process HAS a channel to send on at all (a
            // `casey dashboard` console is started without one), `delivered`
            // is whether the send actually landed. Neither of the two failures
            // is an 'ok' toast -- the reply is on the timeline either way, so
            // an operator who is not told will believe it arrived.
            if (j.delivered) replyUndoToast(c.id, () => onReload && onReload(c.id));
            else if (j.sent) toast('Saved to the timeline, but the channel refused it. The contact has NOT received this. Check the timeline.', 'warn');
            else toast('Saved to the timeline only. This console is not attached to the messaging channels, so nothing was sent to the contact.', 'warn');
            if (onReload) await onReload(c.id);
        } catch (e) { state._replySending = false; toast('The reply did not go out. ' + e.message, 'err'); schedule(); }
    };

    const cans = cannedReplies(c);
    const draftPending = caseHasDraft(c);

    const draftBanner = draftPending
        ? Alert({
            kind: 'warn', title: 'The AI helper drafted a reply. Review it before it sends.',
            children: h('div', { class: 'casey-draft-actions' },
                // GUARDED BY THE SAME IN-FLIGHT FLAG THE FREE-TEXT SEND USES.
                // These two buttons send to the same contact on the same
                // channel as send() above, and they had no guard at all while
                // send() has had one all along: no disabled state, no busy
                // label, nothing rendered while the request was out. On the
                // metered rural link this deployment targets, that request
                // takes seconds, the button looks untouched the whole time, and
                // a second tap posts /draft-approve again -- the contact gets
                // the message TWICE, and a duplicate message to a real person
                // is not a recoverable error. The flag is shared rather than a
                // second one of its own because it means one thing: a send to
                // this contact is already in flight.
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
                            : 'Saved to the timeline only. This console is not attached to the messaging channels, so nothing was sent to the contact.', 'warn');
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
        // The channel is a stored key, and two of its values are not apps at
        // all. This read 'Reply to contact on ' + c.channel, so it rendered
        // "on whatsapp" in lower case, and on a record entered by hand or
        // through the public form it read "Reply to contact on manual" /
        // "on form" -- naming a channel that does not exist and that nothing
        // typed here can reach. When there is no app to reply on, the label
        // says so instead of inventing one.
        h('label', { class: 'casey-reply-label' }, replyChannelLabel(c.channel)
            ? 'Reply to contact on ' + replyChannelLabel(c.channel)
            : 'Reply to contact'),
        replyChannelLabel(c.channel) ? null : Alert({ kind: 'warn', children: 'This ' + entityLabel() + ' came in ' + channelLabel(c.channel) + ', so there is no app to reply on. Anything sent here is recorded on the timeline only -- reach the person another way.' }),
        TextField({
            multiline: true, rows: 3, value: text, maxLength: REPLY_MAXLEN,
            // "Send a message as a human operator..." was the box explaining
            // its own role in the system to the human sitting in front of it.
            // They know they are a person; what they need from a placeholder
            // is the keyboard shortcut.
            placeholder: 'Type your reply here. Ctrl+Enter sends it.',
            onInput: setText,
        }),
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
            Btn({ variant: 'primary', disabled: sending || !text.trim(), children: sending ? 'Sending...' : 'Send reply', onClick: send }),
            // THE REMINDER, beside the reply and deliberately not dressed as one.
            //
            // It sits here because this is the one place on the screen that
            // already means "say something to this person", and an operator
            // deciding whether to nudge somebody is deciding between exactly these
            // two things: write to them yourself, or ask them to write to you.
            // Ghost, not primary: replying is the normal act and this is the
            // narrower one, used when there is nothing to say yet and only silence
            // to break.
            //
            // It never takes the text box's contents. That box is a reply the
            // operator composed; a reminder is a different message with its own
            // guards, and quietly sending a half-typed reply under a button
            // labelled "Ask them to report back" would be the worst kind of
            // surprise. The server composes it, and the operator is shown exactly
            // what went out.
            //
            // Shares _replySending for the reason the draft buttons do: it means
            // one send to this contact is in flight, and on a metered rural link a
            // second tap is a second real message to a real person.
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
                            : 'Saved to the timeline only. This console is not attached to the messaging channels, so nothing was sent.', 'warn');
                        if (onReload) await onReload(c.id);
                    } catch (e) {
                        state._replySending = false;
                        // The server's own refusal sentence is the useful one here
                        // (they opted out / outside the reply window / already
                        // asked), so failMsg's fallback is only for a transport
                        // failure that carries no sentence of its own.
                        toast(await failMsg(e, 'Nothing was sent. Try again.'), 'err'); schedule();
                    }
                },
            })
        )
    );
}
