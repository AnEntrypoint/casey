// hooks/reply-judge.js -- real-LLM outbound-reply quality judge.
//
// USER DIRECTIVE: no deterministic text classification anywhere -- the LLM
// is what interprets, judges, and responds. USER DIRECTIVE: cost is not a
// constraint here -- one extra real LLM round-trip per turn, deliberately,
// for flawless operation over a cheaper-but-blind heuristic.
//
// Distinct from the main conversational turn: this call carries NO case
// context, NO tools, and a fixed, narrow judging prompt -- it exists only to
// classify the ALREADY-COMPOSED reply text, never to compose or edit it.

// judgeReply(callLLM, replyText, { lastOutboundText, hadSuccessfulWrite,
// latestInbound, missingFacts, knownFacts }) ->
// real LLM verdict. Returns { clean: boolean, reasons: string[], category:
// 'jargon'|'other'|null }. clean:false means the reply must not be sent as-
// is. category:'jargon' is the shape with the most mechanical fix -- real
// content that just needs one internal word said in plain language -- so
// turn-attempts.js RETRIES it with the offending words named back to the model,
// and only a retry-budget-exhausted leak reaches turn-outcome.js's DRAFT hold
// for a human to reword. Every other shape is category:'other'.
//
// The SHAPE HEADING WORDS below are a wire protocol, not prose: turn-attempts.js
// routes a category:'jargon' verdict by category and a category:'other' verdict
// by regex over `reasons` -- 'jargon' retries then holds as a draft,
// /false.?confirm|claims?.*record/ retries then holds as a draft,
// /farewell.?gap/ retries with the last-chance push restated then SENDS ANYWAY,
// /repeat.?ask|already (asked|recorded|known)/ retries then SENDS ANYWAY,
// /repeated|echo|stock|meta.?commentary|planning narration/ retries then BLANKS
// the reply, /multi.?ask|wall of text/ retries then SENDS ANYWAY, and
// anything matching neither (TOOL REFUSAL) is sent as-is. Renaming a heading
// here silently reroutes that reply to the send-anyway branch. The two
// send-anyway shapes are ORDERED ahead of the blanking one in
// evaluateCandidate, because 'repeated ask' contains 'repeated' and would
// otherwise be blanked -- silence on a real message, for a reply that does
// answer the person.
//
// missingFacts (plain field LABELS, computed by the caller from the live report
// via prompt-context.js's missingMandatory/missingCritical, mandatory first)
// is the same class of input as hadSuccessfulWrite: a structural system fact
// handed to the judge, never a text classification. knownFacts is its
// complement -- the labels already recorded. Both exist because two of the
// shapes below are about the reply's relationship to the RECORD, which no
// amount of reading the reply's own words can establish.
//
// latestInbound (the contact's current message text) lets the judge apply
// REPEATED REPLY only when the latest message actually called for a fresh
// answer. It must be passed: without it a content-free "hi again" mid-intake
// makes a correct warm re-ask of still-missing facts read as "repeated", and
// the shape blanks the reply on every one of turn-attempts.js's
// MAX_TOOL_CHOICE_ATTEMPTS (3) attempts, so the contact gets the terminal
// fallback despite a healthy model.
//
// hadSuccessfulWrite (boolean, computed by the caller from this turn's real
// tool-call results -- turn-results.js's hadSuccessfulWrite(result)) tells
// the judge whether a case_report/case_update actually succeeded THIS turn,
// so it can catch the "fail-plausible" shape: a reply confidently saying
// "recorded"/"noted"/"got it" when nothing was actually written. This is
// STILL judged by the LLM, not a new regex -- only the true/false fact of
// "did a write land" is computed deterministically (that's a structural
// fact about tool-call results, not text classification), the judgment of
// whether the REPLY'S WORDS claim a write happened is the model's job, same
// as every other shape here.
export async function judgeReply(callLLM, replyText, { lastOutboundText = null, hadSuccessfulWrite = null, latestInbound = null, missingFacts = [], knownFacts = [] } = {}) {
  if (!replyText || !String(replyText).trim()) return { clean: true, reasons: [], category: null }
  if (typeof callLLM !== 'function') return { clean: true, reasons: [], category: null }

  const judgePrompt = [
    `You are a strict quality judge for a customer-facing chat reply. You are given`,
    `ONE candidate reply that an assistant is about to send to a real person (a`,
    `farmer or field worker reporting a sick or dead animal). Judge ONLY the shape`,
    `and content of this reply -- never its topic or correctness -- against these`,
    `real, previously-witnessed failure modes:`,
    `1. PROMPT ECHO: the reply is a canned/example message copied verbatim from`,
    `   the assistant's own system instructions rather than a real, freshly`,
    `   composed response to this specific person.`,
    `2. STOCK ACK: the reply is substantively ONLY a generic "thank you, we have`,
    `   your message, the team will look into it" acknowledgement with no real`,
    `   case-specific content, sent as if it were a real, thoughtful reply.`,
    `3. REPEATED REPLY: the reply is essentially identical (ignoring a reference`,
    `   code) to the PRIOR reply already sent in this same conversation, shown`,
    `   below if one exists -- a parrot, not a genuine new response. When the`,
    `   person's LATEST MESSAGE is shown below, apply this shape ONLY if that`,
    `   message carried new content to answer (new facts, a question, a`,
    `   correction): if the latest message is content-free (a bare greeting,`,
    `   thanks, acknowledgment) a warm re-ask of still-needed details is a`,
    `   genuine response to it, NOT a repeated reply -- do not flag it.`,
    `4. TOOL REFUSAL: the reply talks ABOUT the assistant's own limitations,`,
    `   tools, or access ("I don't have the tools/access to...", "as an AI, I...",`,
    `   "I cannot assist with that") instead of actually answering the person.`,
    `5. META-COMMENTARY / PLANNING NARRATION: the reply describes what the`,
    `   assistant is ABOUT to do or is thinking, instead of actually saying it`,
    `   TO the person (e.g. "I will reply warmly and ask about the location",`,
    `   "Now I'll wait for their reply", "I've asked one gentle question" --`,
    `   narration about the reply, not the reply itself).`,
    `6. INTERNAL JARGON LEAK: this is a STRICT, LITERAL word-presence rule, not a`,
    `   judgment call about whether the word sounds natural in context -- the`,
    `   reply must NEVER contain any of these internal system/process words as`,
    `   whole words, even when the sentence reads smoothly and sounds like`,
    `   normal customer-service English: "case" (except inside a literal`,
    `   reference code like CASE-1234-abcde, which is fine, or the ordinary`,
    `   conjunction "in case"/"just in case"), "ticket", "triage", "workflow",`,
    `   "status" (e.g. "your case status", "checking the status" -- ALWAYS a`,
    `   leak, even though it sounds like something a real support agent would`,
    `   naturally say), "priority" (e.g. "marked as high priority" -- ALWAYS a`,
    `   leak for the same reason), "escalate", "transition", "autonomy". A`,
    `   reply that otherwise reads as a perfectly normal, warm, professional`,
    `   message is STILL flagged the instant one of these exact words appears --`,
    `   naturalness of the phrasing is irrelevant to this specific shape; only`,
    `   whole-word presence matters.`,
    // The reply-shape rule the system prompt states THREE separate times (the
    // persona's ONE-QUESTION rule, GATHER's TOP TWO paragraph, and ONE ASK PER
    // REPLY) had no judge shape at all, so it was the one load-bearing reply rule
    // with no gate behind it -- and it is the rule a weak model breaks most.
    // Witnessed live against the configured free-tier chain, with the full domain
    // prompt in force: a first inbound about sick cattle came back as a
    // six-item numbered list of questions, twice in a row. The person reading
    // that is on a phone, in a hurry, in their second or third language; the
    // prompt's own words for what happens next are "answers two asks by
    // answering neither". Retryable with the reasons fed back (see
    // turn-attempts.js's multi-ask branch), and sent anyway once the budget is
    // spent -- a wall of text is still a real answer, and silence is worse.
    `7. MULTI-ASK WALL OF TEXT: the reply asks THREE OR MORE distinct questions,`,
    `   or presents what it wants to know as a numbered or bulleted LIST, or as a`,
    `   form of separate lines to fill in. This person is reading on a phone, in`,
    `   a hurry, often in their second or third language, and the assistant is`,
    `   allowed at most ONE question naming at most TWO still-missing things,`,
    `   woven into one natural sentence. A warm single sentence that happens to`,
    `   mention two things is CLEAN; a list, a form, or a third question is not.`,
    `   Judge the SHAPE only -- never whether the questions are good ones.`,
    hadSuccessfulWrite === false ? [
      `8. FALSE CONFIRMATION: NO field/report/detail was actually recorded this`,
      `   turn (a system fact, given to you directly -- trust it over the reply's`,
      `   own words). If the reply nonetheless confidently confirms something was`,
      `   recorded, noted, saved, or written down ("I've noted that", "got it,`,
      `   recorded", "that's on file now", "thank you, I've written that down"),`,
      `   that is a FALSE CONFIRMATION -- the reply is lying about system state`,
      `   to the person. A reply that asks a question, acknowledges what the`,
      `   person said in plain warm terms WITHOUT claiming anything was recorded,`,
      `   or genuinely does not touch on recording at all, is fine regardless of`,
      `   this fact.`,
    ].join('\n') : '',
    // The ONE reply rule the prompt states most emphatically and that had no
    // gate behind it at all: the on-site last-chance push. Live, twice in a row,
    // a farewell on a report missing visit-critical facts came back as a warm
    // send-off asking for none of them -- and nothing caught it, because the
    // reply IS warm, IS on topic, IS a genuine message to the person, and
    // therefore CLEAN under every shape above. The prompt already names the
    // exact missing fields (prompt-sections.js's LAST-CHANCE PUSH / MANDATORY
    // MINIMUM lines, from prompt-context.js's computed lists), so more prompt
    // text is not the missing piece -- the gate is. Same shape as the multi-ask
    // rule getting shape 7: the model is handed the fact, the judge checks the
    // reply against it, and a miss is retried with the rule restated.
    //
    // Gated on the caller actually having a non-empty list, exactly as shape 8
    // is gated on hadSuccessfulWrite === false: with nothing missing there is
    // nothing to ask for and a plain goodbye is correct.
    missingFacts.length ? [
      `9. FAREWELL WITH FACTS STILL MISSING: these facts are still blank on this`,
      `   person's report and CANNOT be got once they walk away from the animals`,
      `   (a system fact, given to you directly -- trust it over anything the reply`,
      `   implies): ${missingFacts.join(', ')}.`,
      `   If the candidate reply CLOSES THE CONVERSATION -- says goodbye, wishes`,
      `   them well, thanks them and signs off, tells them the team will take it`,
      `   from here, or otherwise reads as the last message of the exchange --`,
      `   while asking for NONE of those facts, that is a FAREWELL WITH FACTS`,
      `   STILL MISSING: the one chance to ask was spent on a send-off.`,
      `   A reply that asks for even ONE of them is CLEAN, in any language and`,
      `   however gently the ask is woven into the goodbye. A reply that is not a`,
      `   sign-off at all -- it asks something, answers something, carries the`,
      `   conversation on -- is CLEAN and this shape does not apply to it. Judge`,
      `   only whether an ask for one of those facts is present in a closing`,
      `   reply, never whether the ask is phrased well. Write the reason as`,
      `   "farewell-gap".`,
    ].join('\n') : '',
    // A paraphrased re-ask passed BOTH existing repeat guards: turn-attempts.js's
    // verbatim guard is a string equality (by design), and shape 3 above is
    // anchored on the reply being "essentially identical" to the prior one. A
    // question asked again in different words, or in a different language, is
    // neither -- so the person is asked twice for the same thing and the prompt's
    // "never re-ask a fact already sitting there" rule had no gate behind it.
    // This shape judges the ASK, not the string, which is why it needs the
    // recorded-facts list: "which farm are they on" cannot be recognised as a
    // re-ask of a location already recorded from the reply's words alone.
    // Gated, like shapes 8 and 9, on the input it needs existing at all: with no
    // prior reply and nothing recorded -- a genuine first message -- there is
    // nothing a question could be a repeat OF, and listing the shape anyway only
    // invites a false positive on the one turn where every ask is new.
    (lastOutboundText || knownFacts.length) ? [
    `10. REPEATED ASK IN NEW WORDS: the candidate asks the person for something`,
    `   the PRIOR REPLY (shown below, if any) already asked them for, or for a`,
    `   fact already listed under FACTS ALREADY RECORDED below -- even when the`,
    `   wording is completely different, the question is rephrased, or it is`,
    `   asked in another language. This shape is about the THING BEING ASKED`,
    `   FOR, never the words: "where are the animals?" and "which farm are they`,
    `   on?" are one ask, and so are "how many died?" and "did you lose any?".`,
    `   Shape 3 catches a parroted reply; this catches a fresh-sounding sentence`,
    `   that asks again for what is already known or already asked. Asking for`,
    `   something genuinely NEW is CLEAN even if the reply also recaps what the`,
    `   person already said -- a recap is not an ask. Write the reason as`,
    `   "repeat-ask".`,
    ].join('\n') : '',
    ``,
    `A reply that is a genuine, warm, on-topic message actually addressed TO the`,
    `person -- even if short, even if it asks a question, even if it is in a`,
    `language other than English -- is CLEAN. Only flag a reply that clearly`,
    `matches one of the shapes above.`,
    ``,
    lastOutboundText ? `PRIOR REPLY ALREADY SENT IN THIS CONVERSATION:\n${String(lastOutboundText).slice(0, 500)}\n` : '',
    latestInbound ? `PERSON'S LATEST MESSAGE (what the candidate reply must answer):\n${String(latestInbound).slice(0, 500)}\n` : '',
    // LABELS ONLY, never the recorded values: this call is deliberately
    // context-free about the case (see this file's header), and the values are
    // the contact's own words, which have no business in a second LLM call that
    // exists only to judge the shape of one sentence.
    knownFacts.length ? `FACTS ALREADY RECORDED ON THIS REPORT (asking for any of these again is shape 10):\n${knownFacts.join(', ')}\n` : '',
    `CANDIDATE REPLY TO JUDGE:`,
    String(replyText).slice(0, 2000),
    ``,
    `Respond with ONLY a single JSON object, no other text: {"clean": true} if none`,
    `of the shapes above apply, or {"clean": false, "category": "jargon"|"other",`,
    `"reasons": ["<short reason, e.g. \\"meta-commentary\\" or \\"jargon leak: case\\">",`,
    `...]} if one or more apply. Use category "jargon" ONLY when failure shape 6`,
    `(internal jargon leak) is the ONLY thing wrong -- the reply is otherwise a`,
    `genuine, on-topic message that just needs its jargon word(s) reworded by a`,
    `human, not discarded. Use category "other" for EVERY other shape listed`,
    `above, or when jargon is combined with any other shape (the reply has no`,
    `real content worth saving in that case). Some shapes above are numbered but`,
    `only listed when they apply -- judge only the shapes actually shown to you,`,
    `and never treat a gap in the numbering as a shape withheld. For shape 7`,
    `write the reason as "multi-ask", for shape 9 "farewell-gap", for shape 10`,
    `"repeat-ask", so the caller can route each one (see this file's header: the`,
    `shape heading words are a wire protocol, not prose).`,
  ].filter(Boolean).join('\n')

  let raw
  try {
    const result = await callLLM({ messages: [{ role: 'user', content: judgePrompt }], tools: [] })
    raw = (result?.content || '').toString().trim()
  } catch {
    // A judge-call failure must never block a real reply from reaching the
    // person: the judge is a quality gate, not the reply-generation path, so
    // it fails OPEN (treat as clean) rather than holding every reply hostage
    // to this second call's own reliability.
    return { clean: true, reasons: [], category: null }
  }

  try {
    // The judge is instructed to return ONLY JSON, but a real model can still
    // wrap it in prose or a code fence -- extract the first {...} block rather
    // than requiring an exact parse of the whole response.
    const match = raw.match(/\{[\s\S]*\}/)
    const parsed = JSON.parse(match ? match[0] : raw)
    if (parsed.clean === true) return { clean: true, reasons: [], category: null }
    if (parsed.clean === false) {
      const category = parsed.category === 'jargon' ? 'jargon' : 'other'
      return { clean: false, reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : ['judge flagged reply'], category }
    }
    return { clean: true, reasons: [], category: null }
  } catch {
    // An unparseable judge response is the judge's own failure, not the
    // reply's -- fail open for the same reason as a call failure above.
    return { clean: true, reasons: [], category: null }
  }
}
