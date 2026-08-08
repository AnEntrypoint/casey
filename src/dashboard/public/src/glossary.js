// glossary.js -- casey's internal-jargon -> plain-words dictionary, backing
// ux-onboarding-contextual-help (contextual tooltips/glossary for jargon
// terms instead of only a static help card). Any label the operator UI
// still shows in its technical form (autonomy mode names, health-breach
// keys, stage names) gets an entry here; Term() wraps that label with a
// Tooltip using the entry's plain-words explanation, so hovering/focusing
// the WORD teaches the meaning in place instead of sending the operator
// back to the static ? help card to look it up.

export const GLOSSARY = {
    autonomy: 'How much casey is allowed to do on its own for this case.',
    auto: 'casey answers this person by itself, using its own judgement.',
    assisted: 'casey writes a reply and waits for you to approve or edit it before it sends.',
    observe: 'casey only listens and records -- it never replies. Only you can answer.',
    stage: 'Where this conversation is in casey\'s own sense of progress (for example: still gathering details, or done).',
    handoff: 'This case has been handed to a person -- casey will not reply on its own until you do.',
    priority: 'How urgent this case is, so the team knows what to work on first.',
    channel: 'Which app the person is messaging from (WhatsApp or Discord), or how the report was entered (by hand, or the public form).',
    case_type: 'What kind of report this is -- an outbreak, a routine follow-up, a lab sample, or an import alert.',
    sla: 'The time target the team has set for replying to a waiting case.',
    breach: 'A case that has gone past its reply-time target and needs attention.',
    draft: 'A reply casey has written but not sent yet -- it is waiting for you to send or discard it.',
    claim: 'Marking a case as yours, so the rest of the team knows you have it and does not answer the same person twice.',
    reference: 'The short code (like CASE-1042) that identifies this report -- share it with the person if they ask.',
    inbox: 'The "Needs you now" list -- cases ranked worst-first by how urgently they need a reply.',
    guardrail: 'An automatic check that flags a case which may be stuck or overdue, so a person notices it.',
    external_id: 'The internal address casey uses to message this person on their channel -- never shown to a field worker for privacy.',
    field_worker: 'A reporter an operator has trusted with extra access -- their own open cases, "near me" lookups, and location check-ins.',
    reporter: 'The default access level for anyone who messages casey -- report-only, casual, public.',
};

/**
 * @param {string} key - a GLOSSARY key.
 * @returns {string} the plain-words explanation, or '' if the key is unknown.
 */
export function glossaryLookup(key) {
    return GLOSSARY[key] || '';
}
