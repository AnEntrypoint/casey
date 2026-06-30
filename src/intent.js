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
export const ENQUIRY_KINDS = ['today', 'mine', 'open', 'near', 'count', 'geo', 'outbreaks', 'overview', 'overdue']

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
const ENQUIRY_MINE = /\b(my (cases?|reports?|work|visits?|jobs?|list|plate|area|patch|side))\b|\bwhat am i working on\b|\bassigned to me\b|\b(cases?|reports?) (i|to) (must|should|need to|have to) (do|visit|see|handle)\b|\b(which|wic|wich|what) (cases?|reports?) (i|do i|must i)\b/
const ENQUIRY_OPEN = /\b(open (cases?|reports?|work)|available work|anything (i can help|open)|what can i help|help with anything|(show me|list)( the| all)? (open )?(cases?|reports?))\b/
const ENQUIRY_TODAY = /\b(itinerary|itenerary|agenda|schedule|today|todays?|on the go|whats up|what'?s up|whats on|what'?s on|whats happening|what'?s happening|whats going on|whats new|anything (today|for me))\b/
const QUESTION_LEAD = /^(what|whats|what'?s|wat|wats|where|which|wic|wich|who|how|hows|hw|when|is there|are there|any (cases?|reports?)|do (we|i)|can (you|i)|show me|list|find|tell me)\b/
// STATUS-OF-MINE: a worker asking the status/progress of THEIR OWN report ("where are
// we at", "any update", "how is my report going", "did the vet come"). Routes to the
// status reply (the active case's plain status), NOT the generic question deflection.
// Gated in the classifier to NOT fire on a report (animal words) or a cases-list ask.
// NOTE: deliberately excludes "how are we doing"/"how are things" (those are an
// OVERVIEW enquiry, handled later) -- status-of-mine is about THE WORKER'S OWN report,
// so it keys on my/the report|case, "any update/news", "where are we at", "did the vet
// come", etc., never a bare "how are things".
// STATUS_OF_MINE tolerates truncations/typos of 'status' (workers send cut-off or
// misspelt words: statu/staus/stats from a clipped 'status') in its 'whats the X' arm.
const STATUS_OF_MINE =/\b(any (news|update|feedback)|hows? (it|my|the) (going|report|case)|how (is|are) (my|the) (report|case|thing)|how far|w(h)?ats? the (status|statu|staus|stats|update|updat)|w(h)?ats? happening (with|to|on) (my|the|it)|is (my|the) report|any reply|did (the|u|you|someone) (vet|come|send|check|guys|get)|(u|you|yous|guys) (get|got|recieved?|received) (my|the|that)|get my report|been looked|being looked|where (are we|do we stand)|wat now|update on|progress on)\b/
const COUNT_VERB = /^(count|tally)\b/
// FLEET-AGGREGATE enquiry shapes -- the same reach the dashboard GUI has, brought to
// the chat: counts, hotspots-by-area, suspected outbreaks, an overall picture, and
// what is overdue for a reply. Each maps to a pure dashboard aggregator
// (buildGeo/buildClusters/buildOverview/buildSLAReport) over the case store, rendered
// PII-free. 'spreading' is deliberately NOT an outbreak trigger (it mis-routes report
// prose "cattle dying, spreading across the farm").
const ENQUIRY_OUTBREAK = /\b(outbreaks?|clusters?|linked (cases?|reports?)|related (cases?|reports?)|suspected outbreak)\b/
const ENQUIRY_GEO = /\b(hotspots?|which (area|areas|place|places|region|town)|where.{0,12}(most|busiest|hotspot)|busiest (area|place)|most (reports?|cases?))\b/
const ENQUIRY_OVERDUE = /\b(overdue|over due|past due|late|at[- ]risk|urgent|breach(ed|ing)?|behind|unanswered|waiting too long|need(s|ing)? (a )?reply|sla)\b/
const ENQUIRY_OVERVIEW = /\b(how (are|is) (things|it going|everything|we doing)|how (things|everything) (look|looking|going)|hw are things|whats the (situation|picture|state)|overview|summary|sum up|status report|status of all|overall|how are we doing)\b/
// Interrogative count head only -- "how many / number of / count of / how much".
// Deliberately NOT a bare "total" (a quantity statement "10 total animals" is a
// report correction, not a count question).
const COUNT_HEAD = /\b(how many|how much|number of|count of)\b/
// Typo-tolerant variants of the high-value triggers (workers type fast on a phone).
// Wired AFTER the report/animal vetoes so a typo never overrides a real report.
const FUZ_HOWMANY = /\b(how m[ae]ny|hw many|how mny)\b/
const FUZ_OUTBREAK = /\b(out ?br[ea]?kes?|outbrak|clu?ster|cluser)\b/
const FUZ_OVERDUE = /\b(over ?d(ue|o|ew)|past ?due|breach\w*|unanswered)\b/
const FUZ_OPEN = /\b(op[ae]n)\b/
// Polite/filler leads stripped ONLY for the enquiry-lead test (never for the report
// veto), so "could you tell me how many are open" reads as an enquiry. No REPORT or
// ANIMAL word appears here, so stripping can never turn a report into an enquiry.
const POLITE_LEAD = /^(please|could you|can you|would you|will you|kindly|hey|hi|hello|just|so|um|er|tell me|let me know|i want to know|i'?d like to know|do you know|may i ask)[\s,]+/
const LEAD_FILLER = /\b(currently|right now|now|at the moment|sitting|are there|is there|today|still|yet|just)\b/g

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
  // A polite/filler-stripped copy used ONLY for the enquiry-lead test (never for the
  // report veto): strip up to 3 polite leads then collapse connective filler, so
  // "could you tell me how many are currently sitting open" reads as a clear lead.
  let leadCompact = t
  for (let i = 0; i < 3 && POLITE_LEAD.test(leadCompact); i++) leadCompact = leadCompact.replace(POLITE_LEAD, '')
  leadCompact = leadCompact.replace(LEAD_FILLER, ' ').replace(/\s+/g, ' ').trim()
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
  const clearEnquiryLead = /\b(any|show me|list|how many|whats|what'?s|wat|wats|which|wic|wich)\b.{0,24}\b(cases?|reports?|open)\b/.test(leadCompact)
    || ENQUIRY_MINE.test(t) || ENQUIRY_OPEN.test(t)
  // Species-count guard, BEFORE looksReport: "how many sick cattle" must answer as a
  // count, but it names an animal so looksReport / the ANIMAL_WORDS veto would
  // otherwise swallow it as intake. A "how many <animal/symptom>" with no explicit
  // cases-lead is a count enquiry (the renderer tallies by species over the reports).
  // "how many cattle died" still reads as report below (it has the animal but the
  // count head + no enquiry frame -> the count renderer handles the species tally).
  // "count open cases" / "tally cases per area" is a count enquiry -- but only with a
  // cases/reports noun, so "count is 10" (a report quantity) is not a count question.
  const howMany = COUNT_HEAD.test(t) || FUZ_HOWMANY.test(t) || (COUNT_VERB.test(t) && mentionsCases)
  const countsAnimals = howMany && (REPORT_WORDS.test(t) || ANIMAL_WORDS.test(t))
  if (countsAnimals && !clearEnquiryLead) return { kind: 'enquiry', enquiry_kind: 'count', source: 'fallback' }
  // A clear animal description is a REPORT, however it is phrased -- this wins over
  // every enquiry/question shape so a real report is never mis-read. EXCEPT when the
  // message opens with a clear enquiry frame (above), which pre-empts it.
  const looksReport = !clearEnquiryLead && (REPORT_WORDS.test(t) || (ANIMAL_WORDS.test(t) && /\b(is|are|got|have|has|my|the)\b/.test(t) && !QUESTION_LEAD.test(t)))
  if (looksReport) return { kind: 'report', source: 'fallback' }
  // Bare greeting -> chitchat (the warm opener path drives intake from there).
  if (GREETING_ONLY.test(t)) return { kind: 'chitchat', source: 'fallback' }
  // STATUS-OF-MINE: a worker asking the progress of THEIR report ("where are we at",
  // "any update", "did the vet come") -> status (the active case's plain status), not
  // a deflection. Gated !ANIMAL_WORDS (so "where are the animals" stays report-intake)
  // and !mentionsCases (so a cases-list ask stays an enquiry). looksReport already
  // returned for a real report, so a "morning, any news on the sick cows" never lands
  // here (the report veto wins).
  // "my report"/"my case" (singular possessive) is a status-of-MINE query even though
  // it mentions "case/report"; only a PLURAL/listy "my cases"/"the cases" is an
  // enquiry-list. So the cases-gate excludes the singular-possessive form.
  const listyCases = mentionsCases && !/\bmy (case|report)\b/.test(t)
  if (STATUS_OF_MINE.test(t) && !ANIMAL_WORDS.test(t) && !listyCases) return { kind: 'status', source: 'fallback' }
  // Disease-service safe default: a message naming livestock that is NOT a clear
  // enquiry is intake, not a store query -- "any cattle in kzn", "report some sheep
  // losses around musina" describe animals, so they open a report. (An explicit
  // "any reports/cases in <place>" is a clear enquiry and still enquires below.)
  if (ANIMAL_WORDS.test(t) && !clearEnquiryLead) return { kind: 'report', source: 'fallback' }
  // FLEET-AGGREGATE enquiries -- the dashboard's reach in the chat. Checked after the
  // report/animal veto (a real report always wins) and BEFORE the per-case
  // near/mine/open/today cascade. Order matters: outbreaks/geo are distinct fleet
  // rollups, so "which area has the most" is a hotspot summary, not a place-scoped
  // list; overdue is noun-gated so it never fires on report prose ("waiting to give
  // birth"); count needs a cases/reports noun here (the animal form already returned
  // above via the species-count guard).
  // A "how many ..." count question wins over the overdue/outbreak triggers it may
  // also contain ("how many cases are open and unanswered" is a COUNT, not overdue).
  // A status word ("how many waiting/new/resolved/in progress/...") routes to a
  // per-status breakdown -- the count head guards against a report ("the cow is
  // waiting" has no "how many"), so report-veto is preserved. The status is carried
  // for the renderer to count cases in THAT status.
  const statusWord = (t.match(/\b(waiting|new|resolved|closed|triaging|in[ _]progress|in progress|done|finished|active|pending)\b/) || [])[1]
  if (howMany && (mentionsCases || FUZ_OPEN.test(t) || statusWord)) {
    const cp0 = resolvePlace(t)
    const status = statusWord ? statusWord.replace(/[ ]/g, '_') : null
    return { kind: 'enquiry', enquiry_kind: 'count', source: 'fallback', ...(cp0 ? { place: cp0.matchedAlias } : {}), ...(status ? { status } : {}) }
  }
  if (ENQUIRY_OUTBREAK.test(t) || FUZ_OUTBREAK.test(t)) return { kind: 'enquiry', enquiry_kind: 'outbreaks', source: 'fallback' }
  if (ENQUIRY_GEO.test(t)) return { kind: 'enquiry', enquiry_kind: 'geo', source: 'fallback' }
  // Overdue is noun-gated on an EXISTING-DATA context word (cases/reports/open/reply/
  // sla/anything/everything) -- NOT on the trigger word itself ("late"/"overdue"),
  // which appears in plain report prose ("my order is late", "the cow is waiting").
  // So "whats overdue"/"anything running late"/"any reports overdue" enquire, while a
  // bare "X is late" stays a report.
  if ((ENQUIRY_OVERDUE.test(t) || FUZ_OVERDUE.test(t)) && (mentionsCases || /\b(open|reply|sla|anything|everything|urgent|whats|what'?s)\b/.test(t))) return { kind: 'enquiry', enquiry_kind: 'overdue', source: 'fallback' }
  if (ENQUIRY_OVERVIEW.test(t)) return { kind: 'enquiry', enquiry_kind: 'overview', source: 'fallback' }
  if (ENQUIRY_NEAR.test(t) && mentionsCases) return { kind: 'enquiry', enquiry_kind: 'near', place: extractPlace(t), source: 'fallback' }
  // A proximity ENQUIRY ("whats near margate", "nearest case to margate", "any near
  // X") where the place RESOLVES to a known SA town/province is an enquiry even
  // without a "cases"/"reports" word -- the near-lead plus a question/listing shape
  // signals a store query. Gated on QUESTION_LEAD (or nearest/closest, which are
  // inherently a query) so a DECLARATIVE location statement ("the farm is near
  // Ermelo" -- report content) does NOT trip it.
  const nearQueryShape = QUESTION_LEAD.test(t) || /\b(nearest|closest)\b/.test(t)
  if (ENQUIRY_NEAR.test(t) && nearQueryShape) {
    const np = resolvePlace(t)
    if (np) return { kind: 'enquiry', enquiry_kind: 'near', place: np.matchedAlias, source: 'fallback' }
  }
  if (ENQUIRY_MINE.test(t)) return { kind: 'enquiry', enquiry_kind: 'mine', source: 'fallback' }
  if (ENQUIRY_OPEN.test(t)) return { kind: 'enquiry', enquiry_kind: 'open', source: 'fallback' }
  // A bare "open" cases ask without the full ENQUIRY_OPEN frame ("wat is still open",
  // "what i got open") -- gated on a cases/reports word so report prose never trips it.
  if (mentionsCases && FUZ_OPEN.test(t) && !looksReport) return { kind: 'enquiry', enquiry_kind: 'open', source: 'fallback' }
  // The bare-"today" route must carry an enquiry frame: a cases word, an explicit
  // today-list cue (itinerary/agenda/whats on/...), or a question lead. Otherwise
  // "whats the weather today" / "is the road open today" / "u guys working today?"
  // wrongly dumped today's CASES.
  if (ENQUIRY_TODAY.test(t) && (mentionsCases || /\b(itinerary|itenerary|agenda|schedule|my (day|list)|whats on|what'?s on|whats up|what'?s up|whats happening|what'?s happening|going on|on the go)\b/.test(t))) return { kind: 'enquiry', enquiry_kind: 'today', source: 'fallback' }
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
