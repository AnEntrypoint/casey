// stub-llm.js  --  a deterministic fake model for offline simulation and tests.
// NOT for production: `casey up` runs the real model via freddie's resolver
// (callLLM=null, resolved to acptoapi). This lets `casey sim` and the test suite
// exercise the full AGENT-DRIVEN loop with no provider keys.
//
// Shape matches freddie's callLLM contract: ({messages,tools}) => {content, tool_calls}.
//
// Since the pure-agent reshape removed casey's deterministic intent routing, the
// STUB now carries the classification+extraction a real model would: per message it
// detects the shape and CALLS the case tools (case_report to record fields, case_list
// for a place/region enquiry, case_get for status, case_mine/case_today for the
// worker's itinerary, case_new for a fresh report on a complete case, case_stop for
// an opt-out) -- then, on the follow-up turn once the tool RESULT is in the messages,
// composes a plain reply FROM that result. This is the ONLY message-shape logic that
// survives, and it is a TEST DOUBLE (a stand-in for the real model), never production
// text processing. It imports extract.js (the retained empty-case floor) for field
// extraction but NEVER intent.js/places.js (deleted).
import { extractFields } from '../extract.js'

// A minimal, self-contained shape classifier: is this message an enquiry, a status
// ask, an opt-out/human ask, or a report? Deterministic and inline -- it does NOT
// reach into the deleted intent.js/places.js. It only needs to be good enough to
// make the stub call the RIGHT tool so the agent-path is exercised end to end.
const ENQUIRY_TODAY = /\b(itinerary|itenerary|agenda|schedule|today|on for today|my day|rounds)\b/i
const ENQUIRY_MINE = /\b(my cases?|my reports?|what am i working on|what i am working on|assigned to me|mine)\b/i
const ENQUIRY_OPEN = /\b(open cases?|open work|anything i can help|what can i help|whats open|what.?s open)\b/i
const ENQUIRY_NEAR = /\b(near|nearest|closest|close to|around|by)\b/i
const ENQUIRY_COUNT = /\bhow many\b/i
const ENQUIRY_GEO = /\b(which area|what area|where are|hotspot|most reports)\b/i
const ENQUIRY_OUTBREAK = /\boutbreaks?\b/i
const ENQUIRY_OVERVIEW = /\b(how are we|hows it going|how.?s it going|overview|how are things)\b/i
const ENQUIRY_OVERDUE = /\b(overdue|whats overdue|what.?s overdue|breaching|at risk)\b/i
const STATUS_ASK = /\b(status|update|any news|where are we|how is|hows|any progress|did the vet)\b/i
const REF_RE = /\bcase[\s-]?\d+(?:-[a-z0-9]+)?\b/i
const STOP_RE = /\b(stop|unsubscribe|cancel|leave me alone|no more messages)\b/i
const HUMAN_RE = /\b(human|real person|speak to (a|someone)|talk to (a|someone)|operator|agent|call me)\b/i
// A report-content veto: livestock + a problem word means this is a REPORT, never an
// enquiry/status ask (the "my cattle are sick" case).
const ANIMAL_RE = /\b(cattle|cow|cows|calf|calves|ox|oxen|sheep|goat|goats|pig|pigs|chicken|fowl|izinkomo|skape|beeste|diere|animal|animals|livestock|herd|flock)\b/i
const PROBLEM_RE = /\b(sick|ill|dead|died|dying|drool|drooling|blood|cough|limp|limping|swollen|not eating|stopped eating|vrek|gevrek|siek|weak|down|collapsed|sores?|lesions?)\b/i

// A place token for a region/near enquiry: the word(s) after a spatial lead, or a
// bare capitalised/lowercase place after "in". Good enough for the stub; the real
// model extracts the place itself and passes it to case_list(location).
function extractPlaceToken(text) {
  const t = String(text || '')
  let m = t.match(/\b(?:near|nearest|closest|close to|around|by|in|at)\s+(?:the\s+)?([a-z][a-z' -]{2,30})/i)
  if (m) return m[1].trim().replace(/\b(main road|today|please|now)\b.*$/i, '').trim()
  return ''
}

function looksReport(t) { return ANIMAL_RE.test(t) && PROBLEM_RE.test(t) }

// Classify to a tool intent. Report content vetoes every enquiry/status read.
function shapeOf(text) {
  const t = String(text || '')
  if (!t.trim()) return { kind: 'chitchat' }
  if (STOP_RE.test(t)) return { kind: 'stop' }
  if (HUMAN_RE.test(t)) return { kind: 'human' }
  if (looksReport(t)) return { kind: 'report' }
  // A bare/near case ref (not inside a report) -> status-by-ref.
  if (REF_RE.test(t) && !looksReport(t)) return { kind: 'status_ref', ref: (t.match(REF_RE) || [])[0] }
  // Fleet-aggregate enquiries.
  if (ENQUIRY_COUNT.test(t)) return { kind: 'enquiry', enquiry_kind: 'count' }
  if (ENQUIRY_OUTBREAK.test(t)) return { kind: 'enquiry', enquiry_kind: 'outbreaks' }
  if (ENQUIRY_OVERDUE.test(t)) return { kind: 'enquiry', enquiry_kind: 'overdue' }
  if (ENQUIRY_OVERVIEW.test(t)) return { kind: 'enquiry', enquiry_kind: 'overview' }
  if (ENQUIRY_GEO.test(t)) return { kind: 'enquiry', enquiry_kind: 'geo' }
  // Place/region + near enquiries -> case_list(location).
  const place = extractPlaceToken(t)
  if (ENQUIRY_NEAR.test(t) && place) return { kind: 'enquiry', enquiry_kind: 'near', place }
  if (place && /\b(any cases?|reports?|anything)\b/i.test(t)) return { kind: 'enquiry', enquiry_kind: 'near', place }
  // Worker itinerary enquiries.
  if (ENQUIRY_MINE.test(t)) return { kind: 'enquiry', enquiry_kind: 'mine' }
  if (ENQUIRY_OPEN.test(t)) return { kind: 'enquiry', enquiry_kind: 'open' }
  if (ENQUIRY_TODAY.test(t)) return { kind: 'enquiry', enquiry_kind: 'today' }
  // A status ask about the worker's own active case.
  if (STATUS_ASK.test(t)) return { kind: 'status' }
  return { kind: 'chitchat' }
}

export function stubLLM() {
  return async ({ messages, tools }) => {
    const sys = messages.find(m => m.role === 'system')?.content || ''
    const toolNames = new Set((tools || []).map(t => t.name || t.function?.name))
    const caseId = (sys.match(/id=(\S+?)\)/) || [])[1]
    const ref = (sys.match(/CURRENT CASE (\S+)/) || [])[1] || caseId || ''
    const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || ''
    const toolMsgs = messages.filter(m => m.role === 'tool')

    // PHASE 2: a tool result is in the conversation -> compose a plain reply FROM it.
    // This is where an enquiry/status answer is rendered (the model relays the tool's
    // rows/case body into warm plain language). Guarded so we reply once.
    if (toolMsgs.length) {
      const lastTool = toolMsgs[toolMsgs.length - 1]
      const payload = safeJson(lastTool?.content)
      const reply = composeFromToolResult(payload, ref, lastUser)
      if (reply) return { content: reply, tool_calls: [] }
      return { content: composeReply(lastUser, ref), tool_calls: [] }
    }

    // PHASE 1: no tool result yet -> classify the message and CALL the right tool.
    if (!caseId) return { content: composeReply(lastUser, ref), tool_calls: [] }
    const shape = shapeOf(lastUser)

    if (shape.kind === 'stop' && toolNames.has('case_stop')) {
      return { content: '', tool_calls: [{ id: 's1', name: 'case_stop', arguments: { id: caseId } }] }
    }
    if (shape.kind === 'human' && toolNames.has('case_handoff')) {
      return { content: '', tool_calls: [{ id: 'h1', name: 'case_handoff', arguments: { id: caseId } }] }
    }
    if (shape.kind === 'status_ref' && toolNames.has('case_get')) {
      // Status of a named case: the stub passes the ref as the id -- the tool resolves
      // it (in the real toolset case_get takes an id; the harness maps ref->id).
      return { content: '', tool_calls: [{ id: 'g1', name: 'case_get', arguments: { id: shape.ref } }] }
    }
    if (shape.kind === 'status' && toolNames.has('case_get')) {
      return { content: '', tool_calls: [{ id: 'g1', name: 'case_get', arguments: { id: caseId } }] }
    }
    if (shape.kind === 'enquiry') {
      const ek = shape.enquiry_kind
      if ((ek === 'near') && shape.place && toolNames.has('case_list')) {
        return { content: '', tool_calls: [{ id: 'l1', name: 'case_list', arguments: { location: shape.place, status: 'open' } }] }
      }
      if (ek === 'mine' && toolNames.has('case_mine')) return { content: '', tool_calls: [{ id: 'm1', name: 'case_mine', arguments: {} }] }
      if ((ek === 'today' || ek === 'open') && toolNames.has('case_today')) return { content: '', tool_calls: [{ id: 'd1', name: 'case_today', arguments: {} }] }
      // Fleet aggregates (count/geo/outbreaks/overview/overdue): the stub lists open
      // cases and composeFromToolResult renders an aggregate scalar from the count.
      if (toolNames.has('case_list')) return { content: '', tool_calls: [{ id: 'a1', name: 'case_list', arguments: { status: 'open' }, _aggregate: ek }] }
    }

    // REPORT / chitchat: record any plainly-stated fields via case_report (the agent's
    // extraction), then reply. This drives intake -- the empty-case floor also records
    // fields, but the stub calling case_report exercises the real tool path.
    const fields = extractFields(lastUser)
    const calls = []
    if (Object.keys(fields).length && toolNames.has('case_report')) {
      calls.push({ id: 'r1', name: 'case_report', arguments: { id: caseId, ...fields } })
    }
    if (calls.length) return { content: '', tool_calls: calls }
    // Nothing to record (a greeting/chitchat): drive intake with a warm opener + the
    // first needed fact, or a warm reply. The agent composes this in production; the
    // stub gives a deterministic plain line.
    return { content: composeReply(lastUser, ref), tool_calls: [] }
  }
}

function safeJson(s) {
  if (s == null) return null
  if (typeof s === 'object') return s
  try { return JSON.parse(s) } catch { return null }
}

// Render a plain reply from a case tool result. Handles the enquiry list shape
// ({count, cases:[...]}) and the case_get body ({case:{ref,status,...}}). PII-free by
// construction: the tools already project to enquiryRow for a worker, so no
// external_id/phone is present to leak.
function composeFromToolResult(payload, ref, userText) {
  if (!payload || typeof payload !== 'object') return ''
  // case_get -> a status body.
  if (payload.case && typeof payload.case === 'object') {
    const c = payload.case
    const cref = c.ref || ref
    const status = plainStatusWord(c.status)
    return `Here is where ${cref} stands: ${status}. The team will keep it moving and update you.`
  }
  // an enquiry list.
  if (typeof payload.count === 'number' && Array.isArray(payload.cases)) {
    const n = payload.count
    const place = extractPlaceToken(userText)
    if (/\bhow many\b/i.test(userText)) return `There are ${n} open ${n === 1 ? 'report' : 'reports'} right now.`
    if (place) return `I found ${n} open ${n === 1 ? 'report' : 'reports'} in that area (${place}).`
    if (n === 0) return `There is nothing on your list right now. I will let you know as reports come in.`
    const refs = payload.cases.slice(0, 5).map(c => c.ref).filter(Boolean).join(', ')
    return `You have ${n} open ${n === 1 ? 'report' : 'reports'}${refs ? `: ${refs}` : ''}.`
  }
  // opt-out / handoff acknowledgements.
  if (payload.ok === true) return `Done. I have taken care of that for you.`
  return ''
}

function plainStatusWord(status) {
  const map = { new: 'newly logged', triaging: 'being looked at', investigating: 'under investigation', resolved: 'resolved', closed: 'closed' }
  return map[status] || (status ? String(status) : 'logged with the team')
}

// Deterministic, plain, calm reply. Always names the reference; switches to a
// human-handoff message when asked for a person; mirrors Afrikaans (the SA
// stand-in for "reply in the contact's language") when the message looks
// Afrikaans. Never diagnoses or promises -- "the team will look into it".
function composeReply(text, ref) {
  const t = (text || '').toLowerCase()
  const af = looksAfrikaans(t)
  const tag = ref ? (af ? ` U verwysing is ${ref}.` : ` Your reference is ${ref}.`) : ''
  if (wantsHuman(t)) {
    return af
      ? `Natuurlik. Iemand van die span sal u nou help. Hulle antwoord hier.${tag}`
      : `Of course. I am asking a person from the team to help you now. They will reply here.${tag}`
  }
  return af
    ? `Dankie dat u laat weet het. Ons het u boodskap en die span sal hierna kyk.${tag}`
    : `Thank you for letting us know. We have your message and the team will look into it.${tag}`
}

function wantsHuman(t) {
  return /\b(human|person|someone|somebody|real|agent|operator|staff|talk to|speak to|call me)\b/.test(t)
    || /\b(mens|persoon|iemand|umuntu|praat)\b/.test(t)
}

// Cheap, deterministic Afrikaans detector for the sim (the SA stand-in language).
function looksAfrikaans(t) {
  return /\b(dankie|asseblief|hallo|goeie|siek|beeste|diere|vrek|gevrek|my beeste|het nie)\b/.test(t)
}
