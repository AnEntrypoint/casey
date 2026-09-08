// glossary.js -- the dashboard's internal-jargon -> plain-words dictionary,
// backing ux-onboarding-contextual-help (contextual tooltips/glossary for
// jargon terms instead of only a static help card). Any label the operator UI
// still shows in its technical form (autonomy mode names, health-breach keys,
// stage names) gets an entry here; Term() wraps that label with a Tooltip
// using the entry's plain-words explanation, so hovering/focusing the WORD
// teaches the meaning in place instead of sending the operator back to the
// static ? help card to look it up.
//
// Every entry that names the product reads it from config
// (dashboard_ui.brand, the same source app-view.js and todo-hint.js use).
// "casey" is the software this dashboard is built on, not the name of the
// deployment an operator is logged into -- on this one that name is "Herd
// Health", and an operator has no reason to ever meet the other word.
// Entries carry a {brand} placeholder and are resolved at read time, since
// the config arrives after this module loads.

import { state } from './state.js';

const BRAND_TOKEN = /\{brand\}/g;

const GLOSSARY_TEMPLATE = {
    autonomy: 'How much {brand} is allowed to do on its own for this case.',
    auto: '{brand} answers this person by itself, using its own judgement.',
    assisted: '{brand} writes a reply and waits for you to approve or edit it before it sends.',
    observe: '{brand} only listens and records. It never replies; only you can answer.',
    stage: 'How far along this conversation is, from a new message through to done.',
    handoff: 'This case has been handed to a person. {brand} will not reply on its own until you do.',
    priority: 'How urgent this case is, so the team knows what to work on first.',
    channel: 'Which app the person is messaging from (WhatsApp or Discord), or how the report was entered (by hand, or the public form).',
    case_type: 'What kind of report this is: an outbreak, a routine follow-up, a lab sample, or an import alert.',
    sla: 'The time target the team has set for replying to a waiting case.',
    breach: 'A case that has gone past its reply-time target and needs attention.',
    draft: 'A reply {brand} has written but not sent yet. It is waiting for you to send or discard it.',
    claim: 'Marking a case as yours, so the rest of the team knows you have it and does not answer the same person twice.',
    reference: 'The short code (like CASE-1042) that identifies this report. Share it with the person if they ask.',
    inbox: 'The "Needs a person" list: reports ranked worst-first by how urgently they need a reply.',
    guardrail: 'An automatic check that flags a case which may be stuck or overdue, so a person notices it.',
    external_id: 'The internal address {brand} uses to message this person on their channel. Never shown to a field worker, for privacy.',
    field_worker: 'A reporter an operator has trusted with extra access: their own open cases, "near me" lookups, and location check-ins.',
    reporter: 'The default access level for anyone who messages {brand}. Report-only, casual, public.',
};

function brandName() { return state.config?.dashboard_ui?.brand || 'casey'; }

/**
 * The glossary with this deployment's own product name filled in.
 * @returns {Object<string,string>}
 */
export function glossary() {
    const brand = brandName();
    const out = {};
    for (const [k, v] of Object.entries(GLOSSARY_TEMPLATE)) out[k] = v.replace(BRAND_TOKEN, brand);
    return out;
}

/**
 * @param {string} key - a glossary key.
 * @returns {string} the plain-words explanation, or '' if the key is unknown.
 */
export function glossaryLookup(key) {
    const t = GLOSSARY_TEMPLATE[key];
    return t ? t.replace(BRAND_TOKEN, brandName()) : '';
}
