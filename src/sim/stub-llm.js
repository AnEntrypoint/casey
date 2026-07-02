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
// composes a plain reply FROM that result. This is a TEST DOUBLE (a stand-in for the
// model) -- it inlines a minimal field parser so the stub can call case_report the
// way a real model would. This shape logic lives ONLY in the stub (a test fixture),
// never in production (casey has no deterministic field extraction any more -- the
// LLM owns it). It imports nothing from the deleted intent.js/places.js/extract.js.

// Minimal field parser for the stub -- ONLY enough to exercise the case_report path
// offline (species, a count, a location after a spatial lead, a couple of symptoms).
// Deliberately small: it is a test double, not casey behaviour.
function stubExtract(text) {
  const t = String(text || '').toLowerCase()
  const f = {}
  const sp = t.match(/\b(cattle|cows?|calf|calves|ox|oxen|sheep|goats?|pigs?|chickens?|izinkomo|skape|beeste)\b/)
  if (sp) f.species = sp[1]
  const wordNum = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' }
  const cnt = t.match(/\b(\d{1,4})\b/) || t.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/)
  if (cnt) { const n = wordNum[cnt[1]] || cnt[1]; if (/\bdied|dead\b/.test(t)) f.dead_count = n; else f.affected_count = n }
  const loc = t.match(/\b(?:near|close to|just outside|at|in|by)\s+(?:the\s+)?([a-z][a-z' -]{2,30})/)
  if (loc) { const p = loc[1].trim().replace(/\b(main road|today|please|farm)\b.*$/, '').trim(); if (p) f.location = p }
  const sym = t.match(/\b(drool\w*|sick|ill|dying|limp\w*|cough\w*|blister\w*|blood|swollen|sores?|not eating|weak)\b/)
  if (sym) f.symptoms = sym[1]
  return f
}

// A minimal, self-contained shape classifier: is this message an enquiry, a status
// ask, an opt-out/human ask, or a report? Deterministic and inline -- it does NOT
// reach into the deleted intent.js/places.js. It only needs to be good enough to
// make the stub call the RIGHT tool so the agent-path is exercised end to end.
const ENQUIRY_TODAY = /\b(itinerary|itenerary|agenda|schedule|today|on for today|my day|rounds)\b/i
const ENQUIRY_MINE = /\b(my cases?|my reports?|what am i working on|what i am working on|assigned to me|mine)\b/i
const ENQUIRY_OPEN = /\b(open cases?|open work|anything i can help|what can i help|whats open|what.?s open)\b/i
const ENQUIRY_NEAR = /\b(near|nearest|closest|close to|around|by)\b/i
const ENQUIRY_COUNT = /\bhow many\b/i
const ENQUIRY_GEO = /\b(which area|what area|hotspot|most reports|where are the (cases|reports|outbreaks))\b/i
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
  // Place/region + near enquiries -> case_list(location). A place ALONE is NOT an
  // enquiry (it is usually an intake location answer, "near Bela-Bela on the farm
  // road"); an enquiry needs an explicit QUERY lead (any cases / reports / nearest /
  // closest / show me / which). This keeps a bare-location intake reply out of the
  // enquiry branch (the report veto above already caught animal+problem messages).
  const place = extractPlaceToken(t)
  const queryLead = /\b(any cases?|any reports?|anything|reports? (in|near|around)|cases? (in|near|around)|nearest|closest|show me|list|which cases?|whats? (in|near|around))\b/i.test(t)
  if (place && queryLead) return { kind: 'enquiry', enquiry_kind: 'near', place }
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

    // PHASE 2: the trailing messages (since the last user turn) are tool RESULTS from
    // the tool calls THIS turn -> compose a plain reply from them. Detected by the tail
    // being tool results, NOT by any tool message anywhere in the session history (a
    // prior turn's tool messages must not short-circuit a fresh turn -- the bug that
    // made a later enquiry skip its tool call and fall to the plain reply). We render
    // from the last tool result whose payload is an enquiry/status answer.
    const lastUserIdx = messages.map(m => m.role).lastIndexOf('user')
    const tail = messages.slice(lastUserIdx + 1)
    const tailTools = tail.filter(m => m.role === 'tool')
    // Phase 2 iff the tail (since the last user turn) carries tool results AND no
    // assistant TEXT reply has been produced after them yet (a trailing assistant with
    // no tool_calls would mean the turn is already answered). freddie may append
    // hook `system` messages after the tool results, so we do NOT require the very last
    // message to be the tool result -- only that no answering assistant turn follows.
    const answered = tail.some(m => m.role === 'assistant' && !(m.tool_calls && m.tool_calls.length))
    if (tailTools.length && !answered) {
      // Render from the first tail tool result that yields an enquiry/status reply
      // (case_update/transition/report results yield '' and are skipped).
      for (const tm of tailTools) {
        const reply = composeFromToolResult(safeJson(tm?.content), ref, lastUser)
        if (reply) return { content: reply, tool_calls: [] }
      }
      return { content: composeReply(lastUser, ref), tool_calls: [] }
    }

    // PHASE 1: no tool result yet for this turn -> classify the message and CALL the tool.
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
      // Like a real model, the stub also DECLARES its phase (case_stage) alongside the
      // data call, so the dstate loop (STAGE-DECLARED -> advanceCase) is exercised
      // offline. case_stage results render '' in composeFromToolResult, so the reply
      // still comes from the data tool's rows.
      const stage = toolNames.has('case_stage') ? [{ id: 'sg1', name: 'case_stage', arguments: { to: 'enquiring' } }] : []
      if ((ek === 'near') && shape.place && toolNames.has('case_list')) {
        return { content: '', tool_calls: [...stage, { id: 'l1', name: 'case_list', arguments: { location: shape.place } }] }
      }
      if (ek === 'mine' && toolNames.has('case_mine')) return { content: '', tool_calls: [...stage, { id: 'm1', name: 'case_mine', arguments: {} }] }
      if ((ek === 'today' || ek === 'open') && toolNames.has('case_today')) return { content: '', tool_calls: [...stage, { id: 'd1', name: 'case_today', arguments: {} }] }
      // Fleet aggregates (count/geo/outbreaks/overview/overdue): list the caseload
      // (no status filter -- the case enum has no literal 'open' state) and
      // composeFromToolResult renders a PII-free aggregate scalar from the count.
      if (toolNames.has('case_list')) return { content: '', tool_calls: [...stage, { id: 'a1', name: 'case_list', arguments: {} }] }
    }

    // REPORT / chitchat: the agent logs the case for the team. On the FIRST turn it
    // sets a summary + priority (case_update) and moves the case into triaging
    // (case_transition), and records any plainly-stated report fields (case_report) --
    // exercising the real action/transition tool path. `firstTurn` = no prior agent
    // outbound in this conversation (the sys prompt has no tool result and this is the
    // opening turn). The empty-case floor also records fields; case_report here
    // exercises the model-driven path.
    const isFirstTurn = messages.filter(m => m.role === 'assistant').length === 0
    const fields = stubExtract(lastUser)
    const calls = []
    if (isFirstTurn) {
      calls.push({ id: 'u1', name: 'case_update', arguments: { id: caseId, summary: `Report: ${lastUser.slice(0, 80)}`, priority: 'high' } })
      calls.push({ id: 't1', name: 'case_transition', arguments: { id: caseId, to: 'triaging', reason: 'logged for the team (stub)' } })
    }
    if (Object.keys(fields).length && toolNames.has('case_report')) {
      calls.push({ id: 'r1', name: 'case_report', arguments: { id: caseId, ...fields } })
      // Declare the intake phase like a real model would, so the offline path
      // exercises the STAGE-DECLARED -> dstate advance loop.
      if (toolNames.has('case_stage')) calls.push({ id: 'sg2', name: 'case_stage', arguments: { to: 'gathering' } })
    }
    // A wrap-up ("thanks", a goodbye) once report fields already exist -> the report
    // is on record: declare 'complete' (the recoverable dstate phase, never a sink).
    const wrapUp = /\b(thanks|thank you|dankie|ngiyabonga|enkosi|bye|goodbye|cheers)\b/i.test(lastUser)
    const haveRecorded = !/\(nothing recorded yet\)/.test(sys)
    if (!calls.length && wrapUp && haveRecorded && toolNames.has('case_stage')) {
      calls.push({ id: 'sg3', name: 'case_stage', arguments: { to: 'complete' } })
    }
    if (calls.length) return { content: '', tool_calls: calls }
    // Nothing to record (a later greeting/chitchat): a warm reply. The agent composes
    // this in production; the stub gives a deterministic plain line.
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
  // case_get -> a status body. It carries BOTH `case` and `events`; case_update's
  // result also carries `case` but no `events`, and is logging (not an answer), so
  // only a case_get result (has `events`) renders a status reply.
  if (payload.case && typeof payload.case === 'object' && Array.isArray(payload.events)) {
    const c = payload.case
    const cref = c.ref || ref
    const status = plainStatusWord(c.status)
    return `Here is where ${cref} stands: ${status}. The team will keep it moving and update you.`
  }
  // an enquiry list ({count, cases}). Render the right shape from the ask.
  if (typeof payload.count === 'number' && Array.isArray(payload.cases)) {
    const n = payload.count
    const u = String(userText || '')
    const place = extractPlaceToken(u)
    // Fleet aggregates -- a scalar, PII-free (no per-case row).
    if (/\bhow many\b/i.test(u)) return `There are ${n} open ${n === 1 ? 'report' : 'reports'} right now.`
    if (/\boutbreaks?\b/i.test(u)) return `Looking across the reports, there ${n === 1 ? 'is' : 'are'} ${n} open ${n === 1 ? 'report' : 'reports'} that could point to an outbreak.`
    if (/\b(overdue|breaching|at risk)\b/i.test(u)) return `There ${n === 1 ? 'is' : 'are'} ${n} open ${n === 1 ? 'report' : 'reports'} to keep an eye on.`
    if (/\b(how are we|hows it going|how.?s it going|overview|how are things)\b/i.test(u)) return `We are doing okay -- ${n} open ${n === 1 ? 'report' : 'reports'} on the go right now.`
    if (/\b(which area|what area|where are|hotspot|most reports)\b/i.test(u)) return `Across ${n} open ${n === 1 ? 'report' : 'reports'}, the busiest areas are where most reports are coming from.`
    // Place / region enquiry.
    if (place) return `I found ${n} open ${n === 1 ? 'report' : 'reports'} in that area (${place}).`
    // The worker's own itinerary (mine / today / open).
    if (n === 0) return `Nothing is on your list right now. I will let you know as reports come in.`
    const refs = [...new Set(payload.cases.map(c => c.ref).filter(Boolean))].slice(0, 5).join(', ')
    return `Here is what is on the go today: ${n} ${n === 1 ? 'report' : 'reports'}${refs ? ` (${refs})` : ''}.`
  }
  // Everything else (case_update/case_transition/case_report/case_stop/case_handoff
  // results -- {ok:true} with or without report/case) is NOT an enquiry answer: it is
  // logging or a control action. Return '' so the caller falls through to composeReply,
  // which gives the ref-citing intake line (or the stop/human line keyed off the user
  // text). This keeps a report/control turn from rendering a bare "Done".
  return ''
}

function plainStatusWord(status) {
  const map = { new: 'newly logged and still with the team', triaging: 'being looked at', in_progress: 'still being worked on', waiting: 'still waiting on a next step', resolved: 'sorted out', closed: 'closed' }
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
