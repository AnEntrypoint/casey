// hooks/reply-judge.js -- real-LLM outbound-reply quality judge.
//
// USER DIRECTIVE: no deterministic text classification anywhere -- the LLM
// is what interprets, judges, and responds. USER DIRECTIVE: cost is not a
// constraint here -- one extra real LLM round-trip per turn, deliberately,
// for flawless operation over a cheaper-but-blind heuristic.
//
// Distinct from the main conversational turn: this call carries NO tools and a
// fixed, narrow judging prompt -- it exists only to classify the
// ALREADY-COMPOSED reply text, never to compose or edit it. The only case
// context it carries is structural and label-only: whether a write landed this
// turn, and WHICH report fields are recorded and which are blank, by display
// label. Never a recorded value, never the report itself.

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
// /repeat.?ask/ retries then SENDS ANYWAY,
// /repeated|echo|stock|meta.?commentary|planning narration/ retries then BLANKS
// the reply, /multi.?ask|wall of text/ retries then SENDS ANYWAY,
// /advice.?given/ retries then HOLDS the reply for a human (advice is worse than silence),
// /promise.?made|wrong.?language|safety.?line.?missing/ retry then SEND ANYWAY, and
// anything matching neither (TOOL REFUSAL) is sent as-is. Renaming a heading
// here silently reroutes that reply to the send-anyway branch.
//
// EVERY ROUTE MUST MATCH A COINED TOKEN, never ordinary English. `farewell-gap`,
// `repeat-ask` and `multi-ask` are words no judge writes by accident; a route
// keyed on a phrase like "already recorded" or "already asked" instead catches a
// STOCK ACK or a REPEATED REPLY whose reason happens to contain it and sends a
// reply that should have been blanked, retried under a diagnosis that misnames
// the fault. The two send-anyway shapes are still ORDERED ahead of the blanking
// one, because a judge writing "repeated ask" in prose would otherwise be blanked
// -- silence on a real message, for a reply that does answer the person.
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
export async function judgeReply(callLLM, replyText, { lastOutboundText = null, hadSuccessfulWrite = null, latestInbound = null, missingFacts = [], knownFacts = [], shape = null, adviceRefusal = null, controlNoted = false, safetyNumbers = [], consentOwed = false, clarifyOwed = false, recordedLanguage = '' } = {}) {
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
    `   "I cannot assist with that") instead of actually answering the person. Saying kindly that it`,
    `   is not a vet and cannot give treatment advice, or cannot say when anyone will come, is the`,
    `   assistant's real, required answer to such a question and is NOT a tool refusal.`,
    `5. META-COMMENTARY / PLANNING NARRATION: the reply describes what the`,
    `   assistant is ABOUT to do or is thinking, instead of actually saying it`,
    `   TO the person (e.g. "I will reply warmly and ask about the location",`,
    `   "Now I'll wait for their reply", "I've asked one gentle question" --`,
    `   narration about the reply, not the reply itself).`,
    // Shape 6 (internal jargon words) and shape 7 (more than one question) are decided in CODE
    // (plain-text.js jargonIn / singleAsk), never asked of this model: a literal word list and a
    // question-mark count do not need a classifier, and this one misfired on both.
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
    ].join('\n') : null,
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
      `   reply, never whether the ask is phrased well.`,
      // THE ASK IS SPENT ONCE. Without this, the shape fires again on the very
      // next turn -- the one where the person has already been asked and has
      // said they cannot answer -- and the retry instruction then demands the
      // second ask the standing rules explicitly forbid ("Ask once only. If they
      // cannot say, or they have already gone, let them go warmly anyway").
      `   ONE EXCEPTION, and it overrides everything above: if the PRIOR REPLY`,
      `   shown below already asked for one of those facts, the one ask has been`,
      `   SPENT -- a goodbye now is CLEAN however many facts are still blank, and`,
      `   so is a goodbye after the person declined, said they do not know, said`,
      `   they have left, or simply did not answer it. Nobody is asked twice.`,
      `   Write the reason as "farewell-gap".`,
    ].join('\n') : null,
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
    `   on?" are one ask. Shape 3 catches a parroted reply; this catches a`,
    `   fresh-sounding sentence that asks again for what is already known or`,
    `   already asked.`,
    consentOwed ? `   EXCEPTION while shape 15 is shown: asking whether it is okay for the team to keep what they send is never a repeated ask, however many times it was asked before; it is required until they answer.` : null,
    // Three carve-outs, each one a shape this would otherwise flag on the most
    // ordinary intake turn there is. The first is structural: the two lists
    // handed to you are disjoint by construction, so a still-blank fact can
    // never be a repeat however much its NAME resembles a recorded one ("how to
    // find the place" beside a recorded "where", "how many died" beside a
    // recorded "how many affected").
    `   THREE THINGS ARE ALWAYS CLEAN, whatever they sound like:`,
    `   (a) asking for any fact NOT in the recorded list -- the recorded and the`,
    `   still-missing facts are different facts even when their names are close;`,
    `   (b) a clarifying re-ask of something the person gave vaguely, partly, or`,
    `   in a way nobody could act on ("sorry, was that twenty or thirty?") --`,
    `   this shape is for asking as though they had never answered at all;`,
    `   (c) a recap of what they said, which is not an ask.`,
    `   Write the reason as "repeat-ask".`,
    ].join('\n') : null,
    // Shapes 11-13 are always shown. Each is judged by the model reading the reply, and each
    // has a COINED reason word for the router in turn-attempts.js (see this file's header).
    `11. ADVICE GIVEN: the assistant connects people and never advises; it is not a vet. Flag a`,
    `   reply that tells the person what to give, do, keep, avoid or watch for (a medicine, dose,`,
    `   remedy, vaccine, feed, moving, separating, isolating, selling, slaughtering, eating,`,
    `   burying, washing or any handling or safety step, or a "you should"), reassures them that`,
    `   something is or is not safe, says whether the animals will live, names or guesses what`,
    `   disease it is or explains it, or says that something is legal or illegal. Where the person`,
    `   may be in danger, the helpline numbers and a warm acknowledgement are CLEAN, but further`,
    `   counselling or instructions are advice.`,
    adviceRefusal ? `   The only thing a reply may offer in place of advice is this, in any words: ${adviceRefusal}. Saying that is CLEAN.` : null,
    `   ASKING what the person has already given or done is CLEAN. Write the reason as "advice-given".`,
    `12. PROMISE THE SYSTEM DOES NOT KEEP: nothing here alerts, phones, messages or sends`,
    `   anyone; a report is recorded and the animal health team reads reports later.`,
    `   Flag a reply that says or implies that a person, the team or a vet has been`,
    `   alerted, asked, flagged, passed it to, told to act, is on the way, will come,`,
    `   phone, call back, contact, follow up, reply or be in touch, that it will chase or`,
    `   arrange something, or that anything will happen by some time, or OFFERS to have someone`,
    `   phone, visit or fetch something for them ("shall I ask a person to call you"). "Your report is`,
    `   recorded" and "the animal health team reads reports" are CLEAN, and so is saying`,
    `   kindly that it cannot say whether or when anyone will come or call: a sentence that says`,
    `   it CANNOT promise or say is the opposite of a promise. A general statement`,
    `   that the team reads the report and can follow up is CLEAN; that it WILL is not.`,
    `   Offering that a person from the team can help them, or asking whether they would like a`,
    `   person from the team to help, is CLEAN: the system really does pass that request to the team.`,
    `   Only a claim or offer about WHEN, HOW or THAT someone will phone, visit or arrive is flagged.`,
    controlNoted ? `   The person asked for a human (or to stop) and the system DID register that this turn (a system fact): saying their request is written down is CLEAN; saying anyone will reply, call or come, or when, is not.` : null,
    `   Write the reason as "promise-made".`,
    safetyNumbers.length && latestInbound ? [
      `14. SAFETY LINE MISSING: read the PERSON'S LATEST MESSAGE below. If it says they may hurt`,
      `   or kill themselves or someone else, the reply MUST contain these helpline numbers, written out:`,
      `   ${safetyNumbers.join(', ')} (a system fact: the candidate reply does NOT contain all of them).`,
      `   If the latest message says nothing of the kind, this shape does not apply. Write the reason as`,
      `   "safety-line-missing".`,
    ].join('\n') : null,
    // Only listed while this number has not yet agreed (phone-consent.js): the reply must ask, every time, until it has.
    consentOwed ? [
      `15. CONSENT NOT ASKED: this person's number has not yet said it is okay for the team to keep what they send`,
      `   (a system fact). The reply MUST clearly ask them, in their language, whether that is okay. A reply that only`,
      `   greets, or only asks about the animals, or only acknowledges, without that question, is flagged. Write the`,
      `   reason as "consent-not-asked".`,
    ].join('\n') : null,
    // Only listed while a person who came back to a complete report has not yet said whether it is more on it or a new problem.
    clarifyOwed ? [
      `16. RETURN NOT CLARIFIED: this person came back to a report that is already complete and has not yet said whether`,
      `   the new message is MORE about that report or a NEW problem (a system fact). The reply MUST ask that, in their`,
      `   language, and ask who is writing. A reply that only acknowledges, or records, or asks for more facts about the`,
      `   animals, without that question, is flagged. Write the reason as "clarify-not-asked".`,
    ].join('\n') : null,
    // Shape 13 (wrong language) is its own narrow call below (languageDiffers), not part of this list: it is a
    // single question and is answered far more reliably alone.
    ``,
    `A reply that is a genuine, warm, on-topic message actually addressed TO the`,
    `person -- even if short, even if it asks a question, even if it is in a`,
    `language other than English -- is CLEAN. Only flag a reply that clearly`,
    `matches one of the shapes above.`,
    ``,
    lastOutboundText ? `PRIOR REPLY ALREADY SENT IN THIS CONVERSATION:\n${String(lastOutboundText).slice(0, 500)}\n` : null,
    latestInbound ? `PERSON'S LATEST MESSAGE (what the candidate reply must answer):\n${String(latestInbound).slice(0, 500)}\n` : null,
    // LABELS ONLY, never the recorded values: this call is deliberately
    // context-free about the case (see this file's header), and the values are
    // the contact's own words, which have no business in a second LLM call that
    // exists only to judge the shape of one sentence.
    knownFacts.length ? `FACTS ALREADY RECORDED ON THIS REPORT (asking for any of these again is shape 10):\n${knownFacts.join(', ')}\n` : null,
    `CANDIDATE REPLY TO JUDGE:`,
    String(replyText).slice(0, 2000),
    ``,
    `Respond with ONLY a single JSON object, no other text: {"findings": []} if none of the`,
    `shapes above apply, or {"findings": [{"shape": "<reason word>", "quote": "<the exact words`,
    `copied from the candidate reply that show it>"}, ...]} with one entry per shape that applies.`,
    `The quote MUST be copied character for character from the CANDIDATE REPLY (a short run of`,
    `its own words); a finding whose quote is not in the reply is thrown away. Only the shapes`,
    `whose fault is something MISSING (${[missingFacts.length ? '"farewell-gap"' : null, consentOwed ? '"consent-not-asked"' : null, clarifyOwed ? '"clarify-not-asked"' : null, safetyNumbers.length && latestInbound ? '"safety-line-missing"' : null].filter(Boolean).join(', ') || 'none here'}) may leave "quote" empty.`,
    `Judge only the shapes actually shown to you, and never treat a gap in the numbering as a`,
    `shape withheld. Each shape has a REQUIRED reason word (the heading words are a wire protocol,`,
    `not prose; see this file's header): ${[
      missingFacts.length ? 'shape 9 "farewell-gap"' : null,
      (lastOutboundText || knownFacts.length) ? 'shape 10 "repeat-ask"' : null,
      'shape 11 "advice-given"', 'shape 12 "promise-made"',
      consentOwed ? 'shape 15 "consent-not-asked"' : null,
      clarifyOwed ? 'shape 16 "clarify-not-asked"' : null,
      safetyNumbers.length && latestInbound ? 'shape 14 "safety-line-missing"' : null,
    ].filter(Boolean).join(', ')}. Shapes 1-5 and 8 use "prompt-echo", "stock-ack", "repeated", "tool-refusal", "meta-commentary" and "false-confirmation".`,
  ].filter(line => line !== null).join('\n')

  // One judging pass: the quoted findings that survive (see below), or null when the call failed. A failing
  // call is retried once because a judge that fails open passes advice and promises as well as everything else,
  // and a transient provider miss is the usual cause. A judge-call failure must never block a real reply from
  // reaching the person (this is a quality gate, not the reply path), so after that it fails OPEN.
  const norm = (t) => String(t ?? '').toLowerCase().replace(/[\u2018\u2019\u201c\u201d"'`]/g, '').replace(/\s+/g, ' ').trim()
  const haystack = norm(replyText)
  const ABSENCE = /farewell.?gap|consent.?not.?asked|clarify.?not.?asked|safety.?line.?missing/i
  async function pass() {
    let raw = ''
    for (let tryNo = 0; tryNo < 2 && !raw; tryNo++) {
      try { raw = ((await callLLM({ messages: [{ role: 'user', content: judgePrompt }], tools: [] }))?.content || '').toString().trim() } catch { raw = '' }
    }
    if (!raw) return null
    try {
      // The judge returns ONLY JSON, but a real model can still wrap it in prose or a code fence: take the first
      // {...} block. A finding about something PRESENT in the reply must quote it, and the quote must really be in
      // the reply: a flag the reply cannot back up (a word "found" that is not there) is dropped here.
      const match = raw.match(/\{[\s\S]*\}/)
      const parsed = JSON.parse(match ? match[0] : raw)
      return (Array.isArray(parsed.findings) ? parsed.findings : [])
        .map(f => ({ shape: String(f?.shape || '').trim(), quote: norm(f?.quote) }))
        .filter(f => f.shape && (ABSENCE.test(f.shape) || (f.quote.length >= 4 && haystack.includes(f.quote))))
        .map(f => f.shape)
    } catch { return null }
  }
  const [first, wrongLanguage] = await Promise.all([pass(), languageDiffers(callLLM, replyText, latestInbound, recordedLanguage)])
  const langReasons = wrongLanguage ? ['wrong-language'] : []
  if (!first || !first.length) return langReasons.length ? { clean: false, reasons: langReasons, category: 'other' } : { clean: true, reasons: [], category: null }
  // A flag is acted on only when a SECOND pass over the same reply raises it too. One pass of a small judge model
  // misfires on a clean reply about one time in ten, and each misfire used to cost a whole extra agent turn; the
  // second pass runs only when the first flagged something, so a clean reply (nearly all of them) costs no more.
  const second = await pass()
  // Except the two whose miss costs the most and whose flag costs one soft retry: a goodbye that spent the on-site
  // question, and the helpline line for someone in danger. Those act on the first pass.
  const FIRST_PASS_ONLY = /farewell.?gap|safety.?line.?missing/i
  const agreed = [...new Set(first)].filter(w => FIRST_PASS_ONLY.test(w) || (second || []).some(x => x.toLowerCase() === w.toLowerCase()))
  const reasons = [...agreed, ...langReasons]
  return reasons.length ? { clean: false, reasons, category: 'other' } : { clean: true, reasons: [], category: null }
}

// WRONG LANGUAGE, as one narrow question: does the reply use a different language from the person's message?
// A reply in the language the report records for them also counts as right. Skipped when the message has too few
// letters to carry a language (a number, "ok", an emoji). Fails open: a failed call flags nothing.
export async function languageDiffers(callLLM, replyText, latestInbound, recordedLanguage = '') {
  const msg = String(latestInbound || '').trim()
  if ((msg.match(/\p{L}/gu) || []).length < 3 || !String(replyText || '').trim()) return false
  const recorded = String(recordedLanguage || '').replace(/["\n]/g, ' ').slice(0, 40).trim()
  const prompt = [
    'Two texts from a chat. Name the language each is written in (ignore names, places, numbers and reference codes), then say whether both are written in the same language.',
    recorded ? `(The person's language is recorded as "${recorded}": a reply in that language also counts as the same.)` : null,
    'MESSAGE FROM THE PERSON:', msg.slice(0, 500), '', 'REPLY TO THEM:', String(replyText).slice(0, 1500), '',
    'Respond with ONLY JSON: {"message_language":"<language>","reply_language":"<language>","same":true|false}',
  ].filter(l => l !== null).join('\n')
  try {
    const raw = String((await callLLM({ messages: [{ role: 'user', content: prompt }], tools: [] }))?.content || '')
    const m = raw.match(/\{[\s\S]*\}/)
    return JSON.parse(m ? m[0] : raw).same === false
  } catch { return false }
}
