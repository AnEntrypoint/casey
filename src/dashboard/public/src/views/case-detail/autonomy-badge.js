// autonomy-badge.js -- the one-sentence explanation of what the Autonomy
// select beside it actually does, rendered under the select as ordinary help
// text.
//
// IT WAS A PILL READING "Who answers: auto", AND IT WAS THREE FAULTS AT ONCE.
//
// 1. It said "auto" -- the raw enum, the same six characters already selected
//    in the dropdown two millimetres to its left. A control and a badge
//    restating the control's own value is not a second fact.
// 2. "Who answers:" is a colon taxonomy, which is how a machine writes a
//    key-value pair, not how a person tells another person what a setting
//    does.
// 3. The part that was worth reading -- that on `auto` nothing waits for a
//    human before a farmer gets an answer -- was inside a Tooltip. A tooltip
//    is a hover affordance. The staff this deployment is for work from
//    phones. On the screen that matters, the explanation did not exist, and
//    the pill that replaced it said nothing the dropdown had not said.
//
// So the pill and the tooltip both went and the sentence came out into the
// open, in the Select's own `hint` slot -- where the Case type field beside
// it already puts its help text, and where the kit wires aria-describedby to
// the control for free. Same words, no chrome, readable without a pointing
// device. This module is now the copy table and nothing else; fields-editor.js
// passes what it returns straight to Select({ hint }).

import { state } from '../../state.js';

// The product name is the deployment's own (dashboard_ui.brand), never the
// literal 'casey', and the prose reads as prose rather than carrying the
// source tree's ASCII double-hyphen convention onto an operator's screen.
const AUTONOMY_COPY = {
    auto: '{brand} replies to the contact on its own, no review needed.',
    assisted: '{brand} drafts a reply and waits for a person to approve or discard it before it sends.',
    observe: '{brand} only logs what happens. It never replies; a person must reply by hand.',
};

export function autonomyExplanation(autonomy) {
    const brand = state.config?.dashboard_ui?.brand || 'casey';
    return (AUTONOMY_COPY[autonomy] || 'Sets who answers the contact.').replace(/\{brand\}/g, brand);
}
