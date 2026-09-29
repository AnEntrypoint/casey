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

import { word, hasWord, wordsIn } from './words.js';

// The wording lives in config/vocabulary.yml under glossary.* (docs/vocabulary-guide.md).
// {brand} is this deployment's product name and {entity} its name for the record
// (report-fields.yml's entity_label); words.js fills both at READ time, because the config
// arrives after this module loads -- and because a glossary that teaches "case" while every
// control on screen says "report" teaches the operator the wrong word on their first
// shift, which is the one thing a glossary must not do.

/**
 * The glossary with this deployment's own product name filled in.
 * @returns {Object<string,string>}
 */
export function glossary() {
    const out = {};
    for (const k of Object.keys(wordsIn('glossary'))) out[k] = word('glossary.' + k);
    return out;
}

/**
 * @param {string} key - a glossary key.
 * @returns {string} the plain-words explanation, or '' if the key is unknown.
 */
export function glossaryLookup(key) {
    return hasWord('glossary.' + key) ? word('glossary.' + key) : '';
}
