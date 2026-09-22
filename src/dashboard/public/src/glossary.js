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

import { brandName, entityLabel, entityLabelPlural } from './vocabulary.js';

const BRAND_TOKEN = /\{brand\}/g;
// {entity_plural} first: {entity} is a prefix of it, so substituting the
// singular first would turn "{entity_plural}" into "report_plural".
const ENTITY_PLURAL_TOKEN = /\{entity_plural\}/g;
const ENTITY_TOKEN = /\{entity\}/g;

function fill(s) {
    return s.replace(BRAND_TOKEN, brandName())
        .replace(ENTITY_PLURAL_TOKEN, entityLabelPlural())
        .replace(ENTITY_TOKEN, entityLabel());
}

// {brand} is this deployment's product name and {entity} is its name for the
// record (report-fields.yml's entity_label). Both are placeholders resolved at
// READ time rather than baked in, because the config arrives after this module
// loads -- and because a glossary that teaches "case" while every control on
// screen says "report" teaches the operator the wrong word on their first shift,
// which is the one thing a glossary must not do.
const GLOSSARY_TEMPLATE = {
    autonomy: 'How much {brand} is allowed to do on its own for this {entity}.',
    auto: '{brand} answers this person by itself, using its own judgement.',
    assisted: '{brand} writes a reply and waits for you to approve or edit it before it sends.',
    observe: '{brand} only listens and records. It never replies; only you can answer.',
    stage: 'How far along this conversation is, from a new message through to done.',
    handoff: 'This {entity} has been handed to a person. {brand} will not reply on its own until you do.',
    priority: 'How urgent this {entity} is, so the team knows what to work on first.',
    channel: 'Which app the person is messaging from (WhatsApp or Discord), or how the {entity} was entered (by hand, or the public form).',
    case_type: 'What kind of {entity} this is: a cluster of symptom reports, a routine follow-up, a lab sample, or an import alert. {brand} records what was reported, not a diagnosis.',
    sla: 'The time target the team has set for replying to a waiting {entity}.',
    breach: 'A {entity} that has gone past its reply-time target and needs attention.',
    draft: 'A reply {brand} has written but not sent yet. It is waiting for you to send or discard it.',
    claim: 'Marking a {entity} as yours, so the rest of the team knows you have it and does not answer the same person twice.',
    // The example reference was "CASE-1042". Real ones carry a random suffix
    // (CASE-1042-6TP7NWUD), so the shape shown here was not the shape an
    // operator reads one out from -- and this is the entry that exists to teach
    // them what a reference looks like.
    reference: 'The short code (like CASE-1042-4KGBXQ7M) that identifies this {entity}. Share it with the person if they ask.',
    inbox: 'The "Needs a person" list: {entity_plural} ranked worst-first by how urgently they need a reply.',
    guardrail: 'An automatic check that flags a {entity} which may be stuck or overdue, so a person notices it.',
    external_id: 'The internal address {brand} uses to message this person on their channel. Never shown to a field worker, for privacy.',
    field_worker: 'A reporter an operator has trusted with extra access: their own open {entity_plural}, "near me" lookups, and location check-ins.',
    reporter: 'The default access level for anyone who messages {brand}. Report-only, casual, public.',
    // The top of the access ladder, and the only rung that can finish a
    // {entity}. Stated as a capability rather than as a permission level,
    // because that is what an operator actually needs to know: if a {entity}
    // is complete and still not signed off, this is who it is waiting for.
    animal_health_technician: 'The highest access level: everything a trusted reporter has, plus the only authority to sign a {entity} off as done. Nobody else can finish one, however complete it is.',
    // The action, not the access level. Named here because the button exists and
    // an operator has to know what pressing it actually does to a real person.
    remind: 'Sends the person ONE message asking them to report back, on the channel they wrote in. Only for a {entity} that has gone quiet, never for someone who asked us to stop, and not twice in a row without them answering first.',
};

/**
 * The glossary with this deployment's own product name filled in.
 * @returns {Object<string,string>}
 */
export function glossary() {
    const out = {};
    for (const [k, v] of Object.entries(GLOSSARY_TEMPLATE)) out[k] = fill(v);
    return out;
}

/**
 * @param {string} key - a glossary key.
 * @returns {string} the plain-words explanation, or '' if the key is unknown.
 */
export function glossaryLookup(key) {
    // fill(), not a lone brand substitution: this is the path Term()'s in-place
    // tooltips read, and it was leaving every {entity} placeholder unresolved,
    // so hovering a term would have shown the literal braces on screen.
    const t = GLOSSARY_TEMPLATE[key];
    return t ? fill(t) : '';
}
