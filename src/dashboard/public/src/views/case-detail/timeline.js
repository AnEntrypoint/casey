// timeline.js -- event timeline with visual distinction per event kind
// (ux-case-detail-timeline-visual-distinction: each kind gets a distinct
// Icon + tone via icons-map.js), client-side search filter, and load-older
// pagination.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Btn, Chip, Icon, IconButton } from '/design/src/components/shell.js';
import { SearchInput, LogRow } from '/design/src/components/content.js';
import { state, schedule, appendTimelineEvents, setTimelineSearch } from '../../state.js';
import { fetchCaseEvents, postFlagReply, postTranslateEvent } from '../../api.js';
import { word } from '../../words.js';
import { toast, failMsg } from '../../toasts.js';
import { rel, fmtTime, reportValue } from '../../format.js';
import { eventIcon, eventTone } from '../../icons-map.js';
import { confirmDialog } from '../../components/dialog-shell.js';
import { isFieldRole, isViewerRole } from '../../api-roles.js';
const h = webjsx.createElement;

// "Flag this reply" is pillar 8's live-feedback loop for prompt tuning: an
// operator marks a specific outbound reply as bad/off-target, right where
// they're already reading it, so a prompt writer has real flagged examples
// to review (GET /api/flagged-replies) instead of no signal at all. Only
// outbound (casey's own sent replies) can be flagged -- flagging an inbound
// contact message or an internal action/observation makes no sense here.
async function flagReply(caseId, e) {
    const reason = await confirmDialog({ title: 'Flag this reply', inputLabel: 'What was wrong with this reply? (optional)' });
    if (reason === null) return; // cancelled -- do not flag
    try {
        await postFlagReply(caseId, e.id, reason);
        e._flagged = true;
        schedule();
    } catch { /* best-effort -- a failed flag just leaves the button clickable to retry */ }
}

// The row itself is the kit's LogRow: a timeline entry is a dense line with a
// rail colour saying what kind of thing happened, and eight CSS rules here
// used to reimplement exactly that. What stays casey's is the vocabulary
// (eventIcon/eventTone) and the flag-a-bad-reply control.
//
// The per-kind class this used to emit (casey-ev--<kind>) was never styled by
// anything; LogRow's data-kind is the same targeting hook without pretending
// to be a style.
//
// THE ROW LABEL WAS `e.kind + '/' + e.actor`, so twenty-one rows of a real
// case read action/system, note/operator, transition/operator,
// observation/agent, inbound/contact -- two database columns joined with a
// slash, at 10px. That is a machine's own index of its event table shown to
// somebody trying to work out what happened to a farmer's cattle.
//
// The label itself is NOT cut, and that is the judgement: this is a dense
// list of many rows, the label is per-row, and it is what you scan the column
// by. It is the vocabulary that was wrong, not the position. So every pair
// gets the words a person would use for it, and an unmapped pair still
// degrades to kind/actor rather than to nothing -- a new event kind should
// look unfamiliar, not invisible.
const ROW_LABEL = {
    'inbound/contact': 'From the reporter',
    'outbound/agent': 'Replied automatically',
    'outbound/operator': 'Operator replied',
    'note/operator': 'Operator note',
    'note/system': 'System note',
    'note/agent': 'Note',
    'action/operator': 'Operator edit',
    'action/contact': 'Reporter update',
    'action/agent': 'Saved automatically',
    'action/system': 'System action',
    'observation/agent': 'Observed',
    'observation/system': 'Automatic note',
    'observation/operator': 'Observation',
    'transition/operator': 'Stage change',
    'transition/agent': 'Stage change',
    'transition/system': 'Stage change',
};
function rowLabel(e) {
    const pair = e.kind + '/' + e.actor;
    const label = ROW_LABEL[pair] || pair;
    // An outbound row used to read "Replied automatically" whether or not the
    // reply reached anyone. When the send fails, hooks/delivery.js marks the
    // outbound event itself (data.delivered === false) rather than only writing
    // a separate observation further down the list, because an operator
    // scanning a conversation reads the reply, not the row below it. Say it on
    // the reply.
    if (e.kind === 'outbound' && e.data && e.data.delivered === false) {
        return label + ' -- Not delivered';
    }
    return label;
}

// ---- "Show in English" ---------------------------------------------------------------
// One message at a time, on request (routes/translate.js). The original stays on screen; the
// translation sits under it, labelled as a machine's. A translation already paid for arrives
// with the events as a system observation `translation:<eventId>` and is shown without a click.
const TRANSLATION_PREFIX = 'translation:';
const isTranslationRow = (e) => e.kind === 'observation' && typeof e.text === 'string' && e.text.startsWith(TRANSLATION_PREFIX);
function evData(e) { if (e.data && typeof e.data === 'object') return e.data; try { return e.data ? JSON.parse(e.data) : {}; } catch { return {}; } }
// eventId -> { english, language } from the observations already loaded.
function storedTranslations(events) {
    const out = {};
    for (const e of events) {
        if (!isTranslationRow(e)) continue;
        const d = evData(e);
        if (d && typeof d.english === 'string' && d.english) out[e.text.slice(TRANSLATION_PREFIX.length)] = { english: d.english, language: d.language || '' };
    }
    return out;
}
const isContactMessage = (e) => e.kind === 'inbound' && e.actor === 'contact';
/** @returns {string} the language the bot recorded for this report (report.language_detected), '' if none. */
export function reportLanguage(c) {
    try { const r = c && c.report ? JSON.parse(c.report) : {}; const l = r && r.language_detected; return typeof l === 'string' ? l.trim().slice(0, 40) : ''; } catch { return ''; }
}
function trState() { return state._translate || (state._translate = {}); }

async function showInEnglish(caseId, caseRef, e) {
    const tr = trState();
    if (tr[e.id] && tr[e.id].busy) return;
    tr[e.id] = { busy: true }; schedule();
    try {
        const r = await postTranslateEvent(caseId, e.id, caseRef);
        tr[e.id] = { english: r.english, language: r.language || '', label: r.label || '' };
    } catch (err) {
        delete tr[e.id];
        toast(await failMsg(err, word('ui.translate_failed')), 'err');
    }
    schedule();
}

function TranslationNote({ shown, key } = {}) {
    const from = shown.language ? shown.language + ' > English -- ' : '';
    return h('div', { key, class: 'casey-ev-translation', role: 'status', 'data-translation-of': '1' },
        Chip({ size: 'sm', tag: true, children: from + word('ui.translate_label') }),
        h('span', { class: 'casey-ev-translated' }, reportValue(shown.english || '')));
}

// ---- humanize: what a person should read instead of the store's own wording -----------
// The agent writes its bookkeeping as plain text ("notice_shown: first_contact v3", "AUDIO
// RECEIVED: ... (saved: /server/path)"). Staff and field logins read this column, so each known
// shape gets its plain-words version, and the server path never reaches the screen.
const NOISE_RE = /^\s*(REPLY-JUDGE-FLAGGED|REPEAT-ASK|NOTICE-NOT-COMPOSED|TURN-START|TURN-HANDED-OFF|resume-attempted|RUNTIME)/i;
const isSystemNote = (e) => e.kind === 'observation' && typeof e.text === 'string' && NOISE_RE.test(e.text);
const SAVED_PATH_RE = /\s*\(saved:\s*[^)]*\)\.?/gi;
function humanize(e) {
    const d = evData(e);
    let text = String(e.text || '').replace(SAVED_PATH_RE, '').trim();
    const out = { text, chip: '', quote: '' };
    if (d.notice_shown) { out.text = 'Privacy notice shown'; return out; }
    if (e.kind === 'observation' && /^consent:/i.test(text)) {
        const c = String(d.phone_consent || '').toLowerCase();
        const declined = c ? c === 'declined' : /declin|refus|not agree/i.test(text);
        out.text = declined ? 'Declined; nothing is kept' : 'Agreed to keep their details';
        return out;
    }
    if (e.kind === 'observation' && /^AUDIO RECEIVED/i.test(text)) {
        const m = text.match(/"([^"]*)"\s*\.?\s*$/);
        out.text = 'Voice note received';
        if (m && m[1].trim()) out.quote = m[1].trim();
        return out;
    }
    if (isContactMessage(e) && d.transcribed) out.chip = 'Voice note, auto-transcribed (may be wrong)';
    return out;
}
const ENGLISH_RE = /^(en\b|en[-_]|english)/i;
/** True when the data says the message is (probably) English, so a translate button would be noise. */
function looksEnglish(e, reportLang) {
    const l = String(evData(e).language || reportLang || '').trim();
    return !!l && ENGLISH_RE.test(l);
}
function sysNotesOpen() { return !!state._showSystemNotes; }
function toggleSystemNotes() { state._showSystemNotes = !state._showSystemNotes; schedule(); }

function TimelineRow({ e, caseId, caseRef, canTranslate, shown, language, key } = {}) {
    const flagged = e._flagged || e.data?.flagged_reply;
    const hz = humanize(e);
    return LogRow({
        key, kind: e.kind, tone: eventTone(e.kind),
        leading: Icon(eventIcon(e.kind), { size: 13 }),
        label: rowLabel(e),
        // Bounded for the same reason a report value is: a timeline row's text
        // is store free-text of contact-influenced length, LogRow places it in
        // a flex row, and an oversized unbreakable run there is the shape that
        // froze the renderer (see format.js's reportValue). The bound is the
        // server's own 4000-character write cap, so nothing any operator or
        // reporter could send through casey is ever cut, and the true length is
        // stated when it is.
        text: hz.chip || hz.quote ? h('span', { class: 'casey-ev-body' },
            hz.chip ? Chip({ size: 'sm', tag: true, children: hz.chip }) : null,
            hz.text ? h('span', { class: 'casey-ev-msg' }, reportValue(hz.text)) : null,
            hz.quote ? h('em', { class: 'casey-ev-quote' }, '"' + reportValue(hz.quote) + '"') : null) : reportValue(hz.text),
        trailing: (canTranslate && isContactMessage(e) && !shown && !looksEnglish(e, language))
            ? h('div', { class: 'casey-ev-actions' }, Btn({ size: 'sm', variant: 'ghost', class: 'casey-translate-btn', disabled: !!(trState()[e.id] && trState()[e.id].busy),
                'aria-label': word('ui.translate_button') + ': ' + reportValue(e.text || '').slice(0, 40),
                children: (trState()[e.id] && trState()[e.id].busy) ? word('ui.translate_busy') : word('ui.translate_button'),
                onClick: () => showInEnglish(caseId, caseRef, e) }))
            : e.kind === 'outbound' && !flagged
            ? IconButton({ icon: Icon('warn', { size: 12 }), title: 'Flag this reply as bad/off-target', onClick: () => flagReply(caseId, e) })
            : (e.kind === 'outbound' && flagged ? h('span', { class: 'casey-ev-flagged', title: 'Flagged for review' }, Icon('warn', { size: 12 })) : null),
        // Wrapped so the exact timestamp stays available on hover -- LogRow
        // owns the meta slot's placement, not what the caller puts in it.
        meta: h('span', { title: fmtTime(e.created_at) }, rel(e.created_at)),
    });
}

export function Timeline({ caseId, events, eventsTotal, key, canTranslate = false, caseRef = null, language = '' } = {}) {
    const q = (state.timelineSearch || '').toLowerCase().trim();
    // Search the words on screen AND the underlying kind/actor keys: an
    // operator types what they can see ("reporter"), a maintainer types what
    // the store calls it ("inbound"), and both were true of this box before
    // the labels were rewritten. Only the first would be after, if the keys
    // were dropped from the haystack.
    const stored = storedTranslations(events);
    // The translation observations are bookkeeping: they appear under their message, not as rows.
    const hideNotes = isFieldRole() || isViewerRole();
    const notes = events.filter(e => !isTranslationRow(e) && isSystemNote(e));
    const shownEvents = events.filter(e => !isTranslationRow(e) && (!isSystemNote(e) || (!hideNotes && sysNotesOpen())));
    const filtered = q
        ? shownEvents.filter(e => (e.kind + ' ' + e.actor + ' ' + rowLabel(e) + ' ' + humanize(e).text).toLowerCase().includes(q))
        : shownEvents;
    const hasMore = eventsTotal != null && events.length < eventsTotal;

    const loadMore = async () => {
        const off = events.length;
        try {
            const older = await fetchCaseEvents(caseId, { offset: String(off) });
            appendTimelineEvents(older.events || []);
        } catch { /* best-effort; a stalled pagination leaves the button in place to retry */ }
    };

    return h('div', { key, class: 'casey-timeline-wrap' },
        // "Timeline (21/21)" on a fully loaded case is a fraction whose two
        // halves are always equal -- a loading statistic left on the screen
        // after loading finished. The count only says something while there
        // is more behind the "Load older events" button, so it is only shown
        // then, and then it is said rather than divided.
        h('h3', { class: 'casey-timeline-head' }, 'Timeline',
            hasMore ? ' -- showing the latest ' + events.length + ' of ' + eventsTotal : '',
            // What the bot recorded as the language this person writes in. Shown next to the
            // translate buttons because it tells staff whether pressing one is worth it.
            ...(language ? [' ', Chip({ size: 'sm', tag: true, tone: 'accent', children: word('ui.language_chip', { language }) })] : [])),
        SearchInput({ value: state.timelineSearch || '', placeholder: 'Search timeline...', onInput: setTimelineSearch, resultCount: q ? filtered.length + ' matching' : null }),
        !hideNotes && notes.length
            ? Btn({ variant: 'ghost', size: 'sm', class: 'casey-sysnotes-btn', 'aria-expanded': sysNotesOpen() ? 'true' : 'false', onClick: toggleSystemNotes,
                children: sysNotesOpen() ? 'Hide system notes' : 'Show system notes (' + notes.length + ')' })
            : null,
        h('div', { class: 'casey-timeline', id: 'timeline' }, ...filtered.flatMap((e, i) => {
            const shown = canTranslate && isContactMessage(e) ? (trState()[e.id] && trState()[e.id].english ? trState()[e.id] : stored[e.id]) : null;
            return [TimelineRow({ key: e.id || i, e, caseId, caseRef, canTranslate, shown, language }), shown ? TranslationNote({ key: 'tr-' + (e.id || i), shown }) : null].filter(Boolean);
        })),
        hasMore ? Btn({ variant: 'ghost', size: 'sm', class: 'casey-load-older', onClick: loadMore, children: 'Load older events' }) : null
    );
}
