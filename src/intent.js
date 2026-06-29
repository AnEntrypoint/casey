// intent.js -- interpret what a worker's message IS, softly.
//
// The hard keyword detectors casey used to carry (long phrase lists for
// today/mine/open/near, each patched whenever a new phrasing slipped through) are
// gone: the in-loop agent model interprets the message and DECLARES its intent via
// the freddie `case_intent` tool, and this module turns that declaration into a
// structured intent the gateway acts on. A small deterministic classifier remains
// ONLY as a SOFT fallback for when the (often weak) production model emits no
// declaration -- it suggests, it does not dictate, and the conversation FSM treats
// every transition as soft so a wrong guess is flagged, never a dead-end.
//
// An intent is { kind, enquiry_kind?, place?, source }. kind is one of:
//   report     -- the worker is telling us about an animal (intake content)
//   enquiry    -- asking ABOUT existing cases (enquiry_kind: today|mine|open|near)
//   question   -- a general question that is not a report and not a known enquiry
//   chitchat   -- a greeting / social opener with no content
//   status|help|human|stop -- the fixed service intents (still deterministic)
// source is 'model' (declared) or 'fallback' (heuristic).

import { resolvePlace } from './places.js'

export const INTENT_KINDS = ['report', 'enquiry', 'question', 'chitchat', 'status', 'help', 'human', 'stop']
export const ENQUIRY_KINDS = ['today', 'mine', 'open', 'near']

// Validate + normalise a model-declared intent (from the case_intent tool call).
// Returns a clean intent or null when the declaration is unusable.
export function normalizeIntent(raw, source = 'model') {
  if (!raw || typeof raw !== 'object') return null
  const kind = String(raw.kind || '').toLowerCase().trim()
  if (!INTENT_KINDS.includes(kind)) return null
  const out = { kind, source }
  if (kind === 'enquiry') {
    const ek = String(raw.enquiry_kind || '').toLowerCase().trim()
    out.enquiry_kind = ENQUIRY_KINDS.includes(ek) ? ek : 'today'
    if (raw.place != null && String(raw.place).trim()) out.place = String(raw.place).trim().slice(0, 60)
  }
  return out
}

// The deterministic SOFT fallback. Deliberately minimal -- it is not the old phrase
// maze, just enough signal to route when the model declared nothing. It reads the
// SHAPE of the message (is it a report? a question? an enquiry about cases? a bare
// greeting?) rather than matching an exhaustive phrase list. Everything it returns
// is a SUGGESTION the soft FSM can override.
const REPORT_WORDS = /\b(sick|ill|dead|dying|died|die|drool|blood|bleed|limp|lame|blister|cough|collaps|swollen|swelling|not eating|vomit|diarr|weak|fever|aborting|miscarr)\b/
const ANIMAL_WORDS = /\b(cattle|cow|cows|calf|calves|ox|oxen|sheep|lamb|goat|goats|pig|pigs|chicken|chickens|poultry|herd|livestock|animal|animals|beeste|bok|skaap|vark)\b/
const GREETING_ONLY = /^(hi|hello|hey|hallo|hi there|good morning|good day|molo|sawubona|dumela|yebo|howzit|hoezit)[\s!.,]*$/
// Enquiry SHAPE: asking about cases/reports/work, optionally with a place or "today".
const ENQUIRY_NEAR = /\b(near|nearest|closest|around|close to|close by)\b/
const ENQUIRY_MINE = /\b(my (cases?|reports?|work|visits?|jobs?|list|plate))\b|\bwhat am i working on\b|\bassigned to me\b/
const ENQUIRY_OPEN = /\b(open (cases?|work)|available work|anything (i can help|open)|what can i help|help with anything)\b/
const ENQUIRY_TODAY = /\b(itinerary|itenerary|agenda|schedule|today|todays?|on the go|whats up|what'?s up|whats on|what'?s on|whats happening|what'?s happening|whats going on|whats new|anything (today|for me))\b/
const QUESTION_LEAD = /^(what|whats|what'?s|where|which|who|how|hows|when|is there|are there|any (cases?|reports?)|do (we|i)|can (you|i)|show me|list|find|tell me)\b/

// Pull a place out of a near-enquiry: the words after the proximity connector.
export function extractPlace(text) {
  const t = String(text || '').toLowerCase()
  const m = /(?:nearest|closest|near|nearby|around|close to|close by)\s+(?:case|cases|report|reports|one|ones)?\s*(?:to|near|around|by|from|of|in)?\s*([a-z][a-z\s\-]{1,40})$/.exec(t)
  if (m && m[1]) return m[1].trim()
  const m2 = /\b(?:to|near|around|by)\s+([a-z][a-z\s\-]{1,40})$/.exec(t)
  return m2 && m2[1] ? m2[1].trim() : ''
}

export function classifyIntentFallback(text) {
  const raw = String(text || '').trim()
  if (!raw) return { kind: 'chitchat', source: 'fallback' }
  const t = raw.toLowerCase()
  const mentionsCases = /\b(cases?|reports?)\b/.test(t)
  // A CLEAR enquiry lead: an explicit "any/show me/list/how many/which ...
  // cases/reports", "what is on", "my cases", "open work". This distinguishes the
  // NOUN reports (an enquiry: "any reports in kzn", "any reports of sick cattle in
  // kzn") from the VERB report ("report some losses"), and -- because it is checked
  // FIRST -- lets an explicit enquiry frame win even when the message also names a
  // symptom/animal, so "any reports of sick cattle in kzn" is a store query, not a
  // new report.
  // NOTE: deliberately does NOT include the loose ENQUIRY_TODAY (it matches a bare
  // "today" anywhere, which would mark "2 cows died today" as an enquiry). Only an
  // explicit cases/reports/open/my-list lead counts as clear.
  const clearEnquiryLead = /\b(any|show me|list|how many|whats|what'?s|which)\b.{0,24}\b(cases?|reports?|open)\b/.test(t)
    || ENQUIRY_MINE.test(t) || ENQUIRY_OPEN.test(t)
  // A clear animal description is a REPORT, however it is phrased -- this wins over
  // every enquiry/question shape so a real report is never mis-read. EXCEPT when the
  // message opens with a clear enquiry frame (above), which pre-empts it.
  const looksReport = !clearEnquiryLead && (REPORT_WORDS.test(t) || (ANIMAL_WORDS.test(t) && /\b(is|are|got|have|has|my|the)\b/.test(t) && !QUESTION_LEAD.test(t)))
  if (looksReport) return { kind: 'report', source: 'fallback' }
  // Bare greeting -> chitchat (the warm opener path drives intake from there).
  if (GREETING_ONLY.test(t)) return { kind: 'chitchat', source: 'fallback' }
  // Disease-service safe default: a message naming livestock that is NOT a clear
  // enquiry is intake, not a store query -- "any cattle in kzn", "report some sheep
  // losses around musina" describe animals, so they open a report. (An explicit
  // "any reports/cases in <place>" is a clear enquiry and still enquires below.)
  if (ANIMAL_WORDS.test(t) && !clearEnquiryLead) return { kind: 'report', source: 'fallback' }
  if (ENQUIRY_NEAR.test(t) && mentionsCases) return { kind: 'enquiry', enquiry_kind: 'near', place: extractPlace(t), source: 'fallback' }
  if (ENQUIRY_MINE.test(t)) return { kind: 'enquiry', enquiry_kind: 'mine', source: 'fallback' }
  if (ENQUIRY_OPEN.test(t)) return { kind: 'enquiry', enquiry_kind: 'open', source: 'fallback' }
  if (ENQUIRY_TODAY.test(t)) return { kind: 'enquiry', enquiry_kind: 'today', source: 'fallback' }
  // REGION / PLACE enquiry: "any cases in kzn", "anything in the eastern cape",
  // "margate". resolvePlace turns a SA province/alias/town into a region, so a place
  // question is answered from the store instead of deflected. Gated so it never
  // swallows a report: ANIMAL_WORDS present -> default to report (a disease service's
  // safe default for "any cattle in kzn"); and a bare place needs either a
  // cases/reports word OR a STRONG term (a province name/alias) to count, so a lone
  // WEAK common-word town in report prose does not flip intent. (looksReport already
  // returned above, so "cattle dying in vryheid" never reaches here.)
  const resolved = resolvePlace(t)
  if (resolved && (!ANIMAL_WORDS.test(t) || clearEnquiryLead) && (mentionsCases || resolved.strong)) {
    return { kind: 'enquiry', enquiry_kind: 'near', place: resolved.matchedAlias, source: 'fallback' }
  }
  // A question that is not a report or a known enquiry: a general question. It must
  // be ANSWERED, never closed out with the complete-report exit.
  if (raw.endsWith('?') || QUESTION_LEAD.test(t)) return { kind: 'question', source: 'fallback' }
  // Anything else with content is treated as report intake (the safe default for a
  // disease-reporting service -- a worker describing something becomes a report).
  return { kind: 'report', source: 'fallback' }
}
