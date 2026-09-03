// hooks/reply-judge.js -- real-LLM outbound-reply quality judge.
//
// USER DIRECTIVE: no deterministic text classification anywhere -- the LLM
// is what interprets, judges, and responds. This replaces FIVE separate
// regex/hardcoded-string classifiers that used to gate every outbound reply
// (isPromptEcho, isStockAck, isToolRefusal, isMetaCommentary, jargonHits, all
// formerly in heuristics.js) with ONE real LLM call that judges the actual
// composed reply against the same real-world failure shapes those regexes
// were each hand-written to catch, one at a time, over many sessions of live
// Discord traffic. USER DIRECTIVE: cost is not a constraint here -- one
// extra real LLM round-trip per turn, deliberately, for flawless operation
// over a cheaper-but-blind heuristic.
//
// Distinct from the main conversational turn: this call carries NO case
// context, NO tools, and a fixed, narrow judging prompt -- it exists only to
// classify the ALREADY-COMPOSED reply text, never to compose or edit it.

// judgeReply(callLLM, replyText, { lastOutboundText, hadSuccessfulWrite, latestInbound }) ->
// real LLM verdict. Returns { clean: boolean, reasons: string[], category:
// 'jargon'|'other'|null }. clean:false means the reply must not be sent as-
// is. category distinguishes the ONE recoverable failure shape (a jargon
// leak -- the old jargonHits gate held the reply as a DRAFT for a human to
// reword, never discarded it outright, since the underlying content was
// otherwise fine) from every other shape (prompt echo / stock ack / tool
// refusal / meta-commentary / false confirmation -- the old gates discarded
// these entirely, since there is no real content worth a human rewriting).
// Callers branch on category to preserve that same distinction.
//
// latestInbound (the contact's current message text) lets the judge apply
// REPEATED REPLY only when the latest message actually called for a fresh
// answer. Live-witnessed without it: a bare "hi again" mid-intake has no new
// content to answer, so the model's correct warm re-ask of still-missing
// facts was flagged "repeated" on all 3 retry attempts and the contact got
// the terminal fallback despite a healthy model -- the repeat rule firing on
// a message that demanded no novelty at all.
//
// hadSuccessfulWrite (boolean, computed by the caller from this turn's real
// tool-call results -- handler.js's hadSuccessfulWriteThisTurn) tells the
// judge whether a case_report/case_update actually succeeded THIS turn, so
// it can catch the "fail-plausible" shape: a reply confidently saying
// "recorded"/"noted"/"got it" when nothing was actually written. This is
// STILL judged by the LLM, not a new regex -- only the true/false fact of
// "did a write land" is computed deterministically (that's a structural
// fact about tool-call results, not text classification), the judgment of
// whether the REPLY'S WORDS claim a write happened is the model's job, same
// as every other shape here.
export async function judgeReply(callLLM, replyText, { lastOutboundText = null, hadSuccessfulWrite = null, latestInbound = null } = {}) {
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
    hadSuccessfulWrite === false ? [
      `7. FALSE CONFIRMATION: NO field/report/detail was actually recorded this`,
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
    ``,
    `A reply that is a genuine, warm, on-topic message actually addressed TO the`,
    `person -- even if short, even if it asks a question, even if it is in a`,
    `language other than English -- is CLEAN. Only flag a reply that clearly`,
    `matches one of the shapes above.`,
    ``,
    lastOutboundText ? `PRIOR REPLY ALREADY SENT IN THIS CONVERSATION:\n${String(lastOutboundText).slice(0, 500)}\n` : '',
    latestInbound ? `PERSON'S LATEST MESSAGE (what the candidate reply must answer):\n${String(latestInbound).slice(0, 500)}\n` : '',
    `CANDIDATE REPLY TO JUDGE:`,
    String(replyText).slice(0, 2000),
    ``,
    `Respond with ONLY a single JSON object, no other text: {"clean": true} if none`,
    `of the shapes above apply, or {"clean": false, "category": "jargon"|"other",`,
    `"reasons": ["<short reason, e.g. \\"meta-commentary\\" or \\"jargon leak: case\\">",`,
    `...]} if one or more apply. Use category "jargon" ONLY when failure shape 6`,
    `(internal jargon leak) is the ONLY thing wrong -- the reply is otherwise a`,
    `genuine, on-topic message that just needs its jargon word(s) reworded by a`,
    `human, not discarded. Use category "other" for every other shape (1-5, and`,
    `7 when present), or when jargon is combined with any other shape (the reply`,
    `has no real content worth saving in that case).`,
  ].filter(Boolean).join('\n')

  let raw
  try {
    const result = await callLLM({ messages: [{ role: 'user', content: judgePrompt }], tools: [] })
    raw = (result?.content || '').toString().trim()
  } catch {
    // A judge-call failure must never block a real reply from reaching the
    // person (the judge is a quality gate, not the reply-generation path
    // itself) -- fail OPEN (treat as clean) rather than silently holding
    // every reply hostage to this second call's own reliability.
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
