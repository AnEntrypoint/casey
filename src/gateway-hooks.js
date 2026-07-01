// gateway-hooks.js -- casey's inbound handler for the freddie Gateway.
//
// freddie's built-in Gateway.handleInbound runs a context-free runTurn and
// sends the result. casey needs the agent turn to carry full case context and
// have the case_* tools, and needs every step on the thatcher timeline. So
// instead of layering hooks around freddie's turn (which would run a second,
// context-free turn), casey REPLACES handleInbound with makeCaseHandler():
//
//   inbound message
// -> find/create case (thatcher)
// -> log inbound event
// -> agent turn with case context + case tools (runTurn)
// -> log outbound event
// -> send reply via the channel adapter
//
// All writes go through the CaseStore, so the dashboard observes everything and
// an operator can override case state at any time.

import { runTurn } from 'freddie'
// The PII-free enquiry projection vocabulary is owned by freddie (the layering
// mandate: agentic + enquiry code lives in freddie). casey reuses projectCase so a
// deterministic itinerary answer is scrubbed by the SAME whitelist the agent's
// enquiry tools use -- external_id/contact_id can never leak into a worker's list.
import { projectCase, DEFAULT_PROJECTION } from '../../freddie/src/plugins/case/toolset.js'
import { VISIT_CRITICAL } from './case-health.js'
import { extractFields } from './extract.js'
import { buildAlertPayload, buildSLAReport } from './report-analytics.js'
import { buildGeo } from './geo.js'
import { buildClusters } from './clusters.js'
import { buildOverview } from './overview.js'
import { fmtTimeSAST } from './format.js'
import { classifyIntentFallback, normalizeIntent } from './intent.js'
import { advanceConversation } from './conversation-fsm.js'
import { resolvePlace, placeRegionLabel, containsTerm } from './places.js'

// Report fields casey is allowed to fill deterministically at ingress. Mirrors
// REPORT_KEYS in case-store.js; extractFields may emit keys outside the report
// (e.g. contact_name belongs on the contact, not the report) so we filter here.
const CAPTURE_KEYS = new Set(['species', 'symptoms', 'location', 'affected_count', 'dead_count', 'onset'])

// Deterministic field capture from the inbound text, run on EVERY turn before the
// reply regardless of which path answers. The production model is small and does
// not reliably call case_report, so without this a real conversation logs an empty
// case ("only logs cases from messages, without the relevant details"). Fills only
// fields still empty (never clobbers the model's or a prior turn's richer value),
// is observe-guarded + locked inside the store, and records which keys it filled.
// LLM field-extraction floor: a cheap forced single-tool call that interprets ONE
// worker message into report fields, so natural-language answers the regex misses
// ("a small holding near amapondos", "theyre coughing and wont eat", "about 20, three
// down") are understood. Returns a {key:value} object (only the whitelisted report
// keys, owner_contact excluded -- a phone must never enter capture/summary). Strictly
// additive: merged fill-if-empty by the caller. Returns {} on any error / model-down
// so the deterministic path is the byte-identical fallback. Gated by the caller to
// run only on confirmed intake (never an enquiry/greeting/fixed-intent).
const LLM_EXTRACT_KEYS = ['species', 'symptoms', 'location', 'how_to_find', 'affected_count',
  'dead_count', 'onset', 'suspected_disease', 'present_person', 'present_person_relation', 'owner_name']
const EXTRACT_TOOL = {
  name: 'record_fields',
  description: 'Record the animal-report fields the worker LITERALLY stated in their latest message. Only fields actually stated; never guess. A place in any spelling or description (even lowercase, "a small holding near X") IS the location.',
  parameters: {
    type: 'object',
    properties: Object.fromEntries(LLM_EXTRACT_KEYS.map(k => [k, { type: 'string' }])),
  },
}
async function llmExtractFields({ callLLM, text, pendingKey, log }) {
  if (!callLLM || !text) return {}
  try {
    const sys = `You convert ONE field-worker message about sick or dead farm animals into report fields. Record ONLY fields the message literally states; never guess. A place in any casing or description (e.g. "a small holding near amapondos") IS the location.${pendingKey ? ` The worker was just asked for "${pendingKey}" -- if their message answers it, set that field.` : ''} If the message is only a greeting, question, thanks, or "I don't know", call the tool with NO fields.`
    const res = await callLLM({ messages: [{ role: 'system', content: sys }, { role: 'user', content: String(text).slice(0, 500) }], tools: [EXTRACT_TOOL], tool_choice: 'required', max_tokens: 200 })
    const call = (res?.tool_calls || []).find(c => c.name === 'record_fields')
    const args = call ? (typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments) : null
    if (!args || typeof args !== 'object') return {}
    const out = {}
    for (const k of LLM_EXTRACT_KEYS) {
      const v = args[k]
      if (v != null && String(v).trim()) out[k] = String(v).trim().slice(0, 200)
    }
    return out
  } catch (e) { log?.warn?.('[casey] llm-extract failed', { error: e.message }); return {} }
}

async function captureFieldsFromText(store, caseId, text, log, callLLM = null, pendingKey = null) {
  try {
    const all = extractFields(text)
    const fields = {}
    for (const [k, v] of Object.entries(all)) if (CAPTURE_KEYS.has(k)) fields[k] = v
    // LLM floor: interpret the natural-language message into the long-tail fields the
    // regex misses, merged UNDER the deterministic capture (regex wins on its closed
    // vocabulary; the LLM fills the rest). Off when callLLM is absent/down -> {}.
    if (callLLM) {
      const llm = await llmExtractFields({ callLLM, text, pendingKey, log })
      const added = Object.keys(llm).filter(k => fields[k] == null)
      for (const k of added) fields[k] = llm[k]
      // Observability: record what the LLM floor contributed (KEYS only, never raw
      // text), so production behaviour is visible -- if the model never returns the
      // record_fields call, this stays empty and the deterministic floor is doing all
      // the work, which is the signal to broaden the regex (not silently re-ask).
      log?.info?.('[casey] llm-extract', { added, regex: Object.keys(all) })
    }
    if (!Object.keys(fields).length) return []
    const res = await store.markReportFieldsIfEmpty(caseId, fields)
    if (res?.filled?.length) {
      // Field KEYS only -- never the raw contact text (PII) in the observation.
      await store.appendEvent(caseId, { kind: 'observation', actor: 'system', text: `fields auto-captured: ${res.filled.join(', ')}` })
    }
    // Return the keys we actually newly-filled so the reply path can acknowledge
    // the contact's plainly-stated fact in the very reply that answers it -- the
    // weak model returns no tool_calls (so it never confirms what it heard), and a
    // generic ack reads as a dead-end. Deterministic capture drives the reply.
    return res?.filled || []
  } catch (e) { log?.warn?.('[casey] auto-capture failed', { caseId, error: e.message }); return [] }
}

// Bind a free-text inbound to the field memobot just asked for, when the
// deterministic extractor has no regex for it (e.g. present_person, owner_contact,
// how_to_find -- a worker's free-text answer like "boyi son of the owner"). Without
// this an asked-but-unextractable field is never recorded and intake re-asks the
// same question forever. Guards: only when there IS a pending ask whose field is
// still empty; only when nothing real was captured this turn (the inbound was the
// answer, not a new fact); never a fixed-intent message (help/status/stop/human/
// thanks/greeting); the value is trimmed and length-capped (PII is stored like any
// contact text and HTML-escaped at render). Returns the bound key or null.
async function bindPendingAsk(store, caseId, text, justCaptured, log) {
  try {
    if (Array.isArray(justCaptured) && justCaptured.length) return null   // a real fact, not an answer
    const t = (text || '').trim()
    if (!t) return null
    if (detectContactIntent(t)) return null                              // a fixed-intent message
    const events = await store.listEvents(caseId)
    const c = await store.getCase(caseId)
    // Never bind an ENQUIRY or a NEW-CASE statement as a field value: "any cases near
    // margate" is a query, not the answer to "where are the animals"; a differing
    // species/location is a new-case signal. detectEnquiryIntent carries the
    // REPORT_VETO so a genuine report answer is NOT falsely rejected.
    if (detectEnquiryIntent(t)) return null
    if (detectNewCaseConflict(t, c?.report).length) return null
    const key = pendingAskKey(events, c?.report)
    if (!key) return null
    const value = t.slice(0, 200)
    const res = await store.markReportFieldsIfEmpty(caseId, { [key]: value })
    if (res?.filled?.length) {
      await store.appendEvent(caseId, { kind: 'observation', actor: 'system', text: `pending-ask answer bound to ${key}` })
      return key
    }
    return null
  } catch (e) { log?.warn?.('[casey] pending-ask bind failed', { caseId, error: e.message }); return null }
}

// Escape route for a returning contact who starts a CLEARLY NEW situation on a
// case that already holds a different report. markReportFieldsIfEmpty is fill-if-
// empty, so a conflicting species/location is silently dropped and intake would
// keep urging the OLD case's missing fields forever. This detects the conflict
// deterministically: a freshly-extracted species OR location that is present in
// the running report AND differs from it. We do NOT auto-split (a fuzzy signal
// must not fragment one outbreak); we flag the case for an operator to split,
// once, via a durable observation + a needs-split tag. Same outbreak continuing
// (same or unstated species/location) never trips it.
export function detectNewCaseConflict(inboundText, reportRaw) {
  const ex = extractFields(inboundText || '')
  const r = parseReportSafe(reportRaw)
  const conflicts = []
  for (const k of ['species', 'location']) {
    const had = r[k] != null && String(r[k]).trim() !== ''
    const now = ex[k] != null && String(ex[k]).trim() !== ''
    if (had && now && String(ex[k]).trim().toLowerCase() !== String(r[k]).trim().toLowerCase()) {
      conflicts.push(k)
    }
  }
  return conflicts
}

const CHANNEL_DEFAULT = { whatsapp: 'whatsapp', discord: 'discord', sim: 'sim' }

// Build the system context the agent sees for a given case + recent timeline.
//
// The contact may be elderly, may not read well, and may not speak English as a
// first language. So the prompt does two jobs: it keeps a private structured
// record for the agent's own reasoning (status/priority/timeline, never shown to
// the contact), and it spells out plain-language REPLY rules -- mirror the
// contact's language, short warm sentences, one question, no jargon, greet+give
// the reference on first contact, and reassure when a human is requested.
function caseSystemPrompt(caseRow, events, contact, { closingCapture = null } = {}) {
  const recent = events.slice(-20).map(e =>
    `- [${e.created_at}] ${e.kind}/${e.actor}: ${truncate(e.text, 280)}`).join('\n')
  const firstMessage = events.filter(e => e.kind === 'inbound').length <= 1
  let reportObj = null
  try { reportObj = caseRow.report ? JSON.parse(caseRow.report) : null } catch { reportObj = null }
  // != null (not falsy) so a recorded 0 -- e.g. affected_count: 0, "no animals
  // affected" -- is shown to the agent as known, matching reportMissingVisitCritical
  // and mostImportantMissingField, which both use the null check.
  const haveFields = reportObj ? Object.keys(reportObj).filter(k => reportObj[k] != null) : []
  const reportLine = haveFields.length ? haveFields.map(k => `${k}=${truncate(String(reportObj[k]), 80)}`).join('; ') : '(nothing recorded yet)'
  return [
    // --- Private structured context (for the agent's reasoning ONLY) ---
    `You are casey, the friendly first point of contact for an animal-disease`,
    `reporting service in rural South Africa. The person messaging you is USUALLY a`,
    `field worker out on a visit, reporting a farmer's sick or dead livestock (for`,
    `example cattle, sheep, goats, or pigs) that they have just come to see -- they`,
    `may be standing with the farmer, or with a relative or herder, often out in the`,
    `bush with patchy signal and limited information. They may not own the animals or`,
    `have seen the problem start, so ask only what they can SEE for themselves or`,
    `RELAY from the person there -- never assume they are the owner or witnessed it.`,
    `Your job is to make it easy for them to tell you what they are seeing, and to`,
    `quietly gather as complete a report as the situation allows for the team who`,
    `will follow up -- WITHOUT interrogating the person.`,
    `The block below is private background for your own reasoning. NEVER repeat it,`,
    `quote it, or use its words when you reply. The person must never see internal`,
    `terms like case, ticket, triage, workflow, autonomy, transition, status, or`,
    `priority. You may quietly keep records current with the case_* tools, but how`,
    `you handle records has nothing to do with how you talk to the person.`,
    `Respect the handling mode "${caseRow.autonomy}":`,
    ` - auto -- act and move things along freely behind the scenes.`,
    ` - assisted -- act, but leave anything risky for a human to confirm.`,
    ` - observe -- do not change records; only reply and note what you observe.`,
    ``,
    // Tell the model the ENQUIRY path exists -- a structural instruction, no copyable
    // sample reply (prompt-echo invariant). This is the first place case_intent is
    // named; it turns the model's only enquiry hook from discover-it-yourself into an
    // instruction, so "any cases in kzn" gets listed instead of deflected.
    `Sometimes the worker is not reporting a new animal but ASKING about existing`,
    `reports -- what is on today, their own reports, open work they could help with,`,
    `any reports in a place (a town or a province such as KwaZulu-Natal/kzn), how many`,
    `reports are open, where the busiest areas or suspected outbreaks are, an overall`,
    `picture of how things are going, or what is overdue for a reply. When the latest`,
    `message is such an ask, call case_intent with kind "enquiry" and the matching`,
    `enquiry_kind (today / mine / open / near / count / geo / outbreaks / overview /`,
    `overdue), putting any town or province in place; casey works out the numbers and`,
    `lists the reports for you, so do not answer from memory. Leave a fresh animal`,
    `report to your normal tools.`,
    ``,
    // The "CURRENT CASE <ref> (id=<id>)" token is parsed by tooling/tests; keep it.
    `CURRENT CASE ${caseRow.ref} (id=${caseRow.id})  [private -- do not mention to the person]`,
    `  status: ${caseRow.status}   priority: ${caseRow.priority}   assignee: ${caseRow.assignee}`,
    `  subject: ${caseRow.subject || '(none yet)'}`,
    `  contact: ${contact?.display_name || caseRow.channel}`,
    `  summary: ${caseRow.summary || '(none yet)'}`,
    `  tags: ${caseRow.tags || '(none)'}`,
    `  first message from this person? ${firstMessage ? 'YES (brand new)' : 'no'}`,
    `  report so far (private): ${reportLine}`,
    ``,
    `RECENT TIMELINE (private):`,
    recent || '  (no prior events)',
    ``,
    // --- What to quietly COLLECT (records, not the reply) ---
    `WHAT TO QUIETLY GATHER (private, for the team -- NEVER read this list to the`,
    `person, never let them feel they are filling in a form or being assessed):`,
    `As the person tells their story, quietly record what you learn with the`,
    `case_report tool -- one or two fields at a time, only what they actually said.`,
    `Lead with what the WORKER can see for themselves right now: which animals; what`,
    `can be seen in them (drooling, blisters, lameness, sudden death); how many are`,
    `sick or have died; where the animals are and how to find the place; a photo.`,
    `Then the PEOPLE on site: who is there with the animals and how they are linked`,
    `to the owner (owner, relative, herder, neighbour) -- this matters when the owner`,
    `is away but someone else is present; the owner's name and a number to reach them.`,
    `Then what only the farmer/person there can say, recorded AS their account, not`,
    `the worker's: how long the animals have been like this; any disease they name;`,
    `recent movement (auctions, new animals, shared grazing); how to identify the`,
    `animals. Record present_person, present_person_relation, owner_name, and`,
    `owner_contact as their own fields when you learn them, distinct from the worker.`,
    `Also record the language: as soon as you can tell which language the person is`,
    `writing in, record language_detected as a plain English name (e.g. 'English',`,
    `'Afrikaans', 'isiZulu', 'isiXhosa', 'Sesotho', 'Setswana'). One word, once,`,
    `on the first turn -- do not update it again unless it is clearly wrong.`,
    `Also record the language: as soon as you can tell which language the person is`,
    `writing in, record language_detected as a plain English name (e.g. 'English',`,
    `'Afrikaans', 'isiZulu', 'isiXhosa', 'Sesotho', 'Setswana'). One word, once,`,
    `on the first turn -- do not update it again unless it is clearly wrong.`,
    `This recording is INVISIBLE to the person. They must never sense that you are`,
    `working through a checklist or that gathering details is your job -- it must`,
    `feel like a kind person who simply cares and is listening. Do this on your own,`,
    `every turn, without anyone telling you to and without it changing your warm tone.`,
    ``,
    `KEEP THE RECORD WELL ORGANISED FOR THE TEAM. Each turn, as you learn more, also`,
    `keep the case_update summary a short, clear, scannable picture of the situation`,
    `so an operator can grasp the whole report at a glance -- the animals, the signs,`,
    `the place, how many, and anything a field visit would need. Make it progressively`,
    `richer and better structured as the conversation goes; this is purely behind the`,
    `scenes and never appears in what you say to the person.`,
    ``,
    `THIS IS USUALLY YOUR ONE CHANCE. The worker will soon move on from this place`,
    `and be hard to reach, so facts that can only be got on site matter most.`,
    `PRIORITY ORDER for what to ask if one thing is missing and you must gently`,
    `prompt -- worker-observable facts FIRST: (1) WHERE are the animals -- farm name,`,
    `town, or GPS; (2) WHICH animals -- species (cattle, sheep, etc.); (3) WHAT signs`,
    `can be seen (drooling, blisters, sudden death); (4) HOW to find the place (road,`,
    `landmark); (5) WHO is there with the animals and how they are linked to the owner`,
    `(owner, relative, herder) and a number to reach the owner; (6) anything the`,
    `person there can say about how long it has been or what it might be. Frame the`,
    `later ones as the worker relaying the person there, never as the worker's own`,
    `knowledge ("what does the person there say it could be?", not "what do YOU think").`,
    `If one of these on-site facts is still missing and the person seems to be`,
    `wrapping up, you may gently ask for the single most important one -- once --`,
    `before they go. Otherwise still NEVER interrogate: no list of questions, no`,
    `demands, never re-ask something already in "report so far" above. Most facts`,
    `come out on their own as they talk. Ask at most one gentle question per message,`,
    `and it is fine to ask nothing and simply reassure them.`,
    // If the deterministically-capturable core (where/which/what) is recorded and
    // photos not yet mentioned, a gentle photo ask. Gated on the core three rather
    // than all six VISIT_CRITICAL: how_to_find/farmer_available/contact_fallback are
    // never deterministically extracted, so an all-six gate effectively never fired
    // and the one irrecoverable on-site artifact (a photo) was never nudged. The
    // ask stays subordinate to any still-missing higher-priority field above, and
    // is a STRUCTURAL instruction (the model composes the question itself) -- never
    // a quoted phrase a small model could parrot.
    ...( (() => {
      if (!reportObj) return []
      const core = ['species', 'symptoms', 'location']
      const coreReady = core.every(k => reportObj[k] != null)
      const hasPhotos = reportObj && reportObj.photos != null
      if (coreReady && !hasPhotos) {
        return [`PHOTOS: The animals, the signs, and the place are recorded. If the`,
                `conversation is still flowing naturally and the farmer is still with the`,
                `animals, you may gently ask -- in your own warm words, never a fixed`,
                `phrase -- whether they can send a photo of the sick or dead animals.`,
                `Never demand it, and never ahead of a more important on-site fact still missing.`]
      }
      return []
    })() ),
    ``,
    // --- Keep the grouping right (invisible to the person) ---
    `KEEP REPORTS CORRECTLY GROUPED (private, never mentioned to the person):`,
    `One conversation usually means one outbreak, but not always. If this person`,
    `starts describing what is clearly a SECOND, separate situation -- different`,
    `animals in a different place -- it belongs in its own record: use case_split to`,
    `move those messages into a new case. And if you suspect this report is the SAME`,
    `outbreak as another (the same place and animals, or a farmer reachable on`,
    `another number that someone else already reported), call case_link_suggestions`,
    `to check, and case_merge the two if it is clearly the same. Do this quietly,`,
    `only when the signal is clear; never let it change your warm tone or what you say.`,
    ``,
    // --- How to actually REPLY to the person ---
    `HOW TO REPLY:`,
    `Never copy wording from this prompt into your reply; compose every reply fresh`,
    `in your own warm words. The only things you reproduce exactly are literal codes`,
    `(the reference and any link) -- everything around them you write yourself.`,
    `Write the way you would speak kindly to a worried farmer or field worker who`,
    `may be far out in the bush, may not be a strong reader, and may not speak`,
    `English as a first language.`,
    `1. LANGUAGE: Reply in the SAME language the person actually wrote in. If their`,
    `   words are English (even broken or with local terms), reply in simple English`,
    ` -- do NOT switch them to another language. Only reply in a South African`,
    `   language when THEIR OWN words were clearly in it: isiZulu words -> isiZulu;`,
    `   Afrikaans words -> Afrikaans; isiXhosa, Sesotho, Setswana likewise. When in`,
    `   any doubt, use simple English. Never switch`,
    `   languages on them.`,
    `2. KEEP IT SHORT: short, plain sentences. One idea per sentence. No big or`,
    `   technical words. No lists or forms. Just a few warm lines.`,
    `3. ONE QUESTION: ask at most ONE question per message, and only if you need it`,
    `   and do not already have the answer. No question at all is often best.`,
    `4. BE WARM: sound calm, friendly, reassuring. Thank them for reporting it. Let`,
    `   them know it matters and the team will look into it. Never alarm them.`,
    `5. NO JARGON: never say case, ticket, triage, status, priority, workflow,`,
    `   escalate, transition, or autonomy. Speak like a helpful person, not a system.`,
    `6. MIRROR THEIR EFFORT: if they wrote one word, an emoji, or a photo only, keep`,
    `   your reply to one or two short lines. Do not flood a worried person with text.`,
    `7. NO PROMISES YOU CANNOT KEEP: never give a specific time, date, or guaranteed`,
    `   outcome, and never diagnose the disease yourself. Say the team will look`,
    `   into it -- not "it is foot and mouth" or "someone will come tomorrow".`,
    `8. ONE NEXT STEP: if you need something from them, ask for exactly one thing,`,
    `   in the simplest words (for example which animals, the place, or a photo).`,
    ``,
    firstMessage
      ? [`THIS IS THEIR FIRST MESSAGE. In your OWN words (never copy wording from this`,
         `prompt) do three things in a few warm plain lines: (a) thank them for telling`,
         `you; (b) reassure them the team will look into it; (c) give them their`,
         `reference so they can remind you later -- the reference is exactly`,
         `${caseRow.ref} (reproduce that code exactly, but write the sentence around it`,
         `yourself). Cap the acknowledgement at two short sentences. Only after that,`,
         `and only if it genuinely helps, MAY you add ONE gentle question about what`,
         `they are seeing or where the animals are -- on a first reply it is usually`,
         `better to ask nothing. Vary your phrasing; never sound like a form letter.`,
         ...( process.env.CASEY_PUBLIC_URL
           ? [`If it fits naturally after the reference, you may add one short plain line`,
              `offering the web form. The link is exactly`,
              `${process.env.CASEY_PUBLIC_URL}/report?ref=${caseRow.ref} -- reproduce the URL`,
              `exactly but phrase the offer in your own words; skip it entirely if there`,
              `is no natural place for it. Never interrupt warmth for a URL.`]
           : [] )].join('\n')
      : `Continue gently from the earlier messages above. Pick up where things left off.`,
    ``,
    closingCapture
      ? [`THEY SEEM TO BE WRAPPING UP, and this is likely your last chance before they`,
         `leave the animals. One important thing for the team is still missing:`,
         `${closingCapture}. First warmly acknowledge their thanks, then -- in the same`,
         `short message -- gently ask for just that one thing, in simple words. Ask`,
         `only this once; if they do not give it, let them go kindly. Keep it warm and`,
         `brief, never pushy, and do not list other questions.`].join('\n')
      : '',
    ``,
    `IF THEY ASK FOR A PERSON (in any language or phrasing -- "talk to someone", "I`,
    `want a person", "real human", "is anyone there"): do NOT argue or stall. Warmly`,
    `reassure them that a real person will help, and that their message has been`,
    `passed on. Stay kind and calm.`,
    ``,
    `Your final message is exactly what the person receives on ${caseRow.channel}, so`,
    `make sure it is only the warm, simple reply -- nothing else.`,
  ].join('\n')
}

// Returns an async (platform, msg) handler suitable to assign to
// gateway.handleInbound. `store` is a CaseStore; opts.callLLM optional;
// opts.autoRespond=false to track-only (no agent turn / reply).
const FALLBACK_REPLY = 'Thank you for letting us know. We have your message and the team will look into it.'

// Guard against the small model parroting the system-prompt examples verbatim.
// The first-message guidance describes an acknowledgement + reference; a weak
// model sometimes copies a canned exemplar instead of composing fresh. We reject
// the reply (treat as a failed turn -> fallback + observation) when it matches
// the historical exemplar phrasing that no human-composed warm reply would echo.
// Match is on a normalised copy (lowercased, whitespace-collapsed) so spacing or
// case does not slip an echo through. ASCII only.
const ECHO_MARKERS = [
  'if you need to remind us, your reference is',
  'our team will look into this. if you need to remind us',
  'you can also fill in details at:',
]
function isPromptEcho(text) {
  if (!text) return false
  const norm = String(text).toLowerCase().replace(/\s+/g, ' ').trim()
  return ECHO_MARKERS.some(m => norm.includes(m))
}

// A reference number is a real datum -- the only token in a reply the contact may
// quote back to find their case. A weak model recites a memorized stock reply that
// carries a STALE or HALLUCINATED ref (witnessed live: a reply said
// "CASE-1034-0sckh" for a case whose real ref was CASE-1073-iyniv, and that case
// number never existed). So before any reply is sent OR held as a draft, every
// case-ref-shaped token that is not this case's real ref is rewritten to the real
// ref. Deterministic, ASCII, no model in the loop -- the contact can never be
// handed a fabricated reference. Returns { text, corrected:[wrong refs] }.
const CASE_REF_RE = /CASE-\d+-[a-z0-9]+/gi
// Report-shaped content: a symptom or an animal word. One source of truth for "is
// this an animal report?" used by the status-by-ref guard and the fresh-report
// branch, so the two cannot drift.
const REPORT_SHAPED_RE = /\b(sick|ill|dead|dying|died|drool|blood|bleed|limp|lame|blister|cough|swollen|cattle|cow|cows|calf|sheep|lamb|goat|goats|pig|pigs|herd|livestock|animal|animals)\b/i
// A worker asking the STATUS of a case by reference: a full "CASE-1089-dgpgd" OR a
// bare partial "CASE-1089". Matched on the RAW inbound (normalizeIntentText strips
// the hyphens). Anchored to the CASE- token so a number alone never trips it.
// Tolerant case-ref match: "CASE-1089", "case 1089", "case1089", "CASE 1089-ab".
// A separator (space/hyphen) OR none between CASE and the digits, so a worker who
// drops the hyphen still gets a status lookup. resolveRefForStatus normalises it.
const REF_STATUS_RE = /\bcase[\s-]?\d+(?:-[a-z0-9]+)?\b/i
// Resolve a status-lookup target from the message: an exact ref via getCaseByRef,
// else a bare partial ("CASE-1089") via a UNIQUE prefix scan over a recency slice
// (>1 or 0 matches -> null, so an ambiguous partial does not answer the wrong case).
// Returns the case row or null.
export async function resolveRefForStatus(store, text) {
  const m = REF_STATUS_RE.exec(String(text || ''))
  if (!m) return null
  // Normalise to canonical 'CASE-<digits>' / 'CASE-<digits>-<suffix>' (uppercase,
  // a single hyphen for the space/no-sep forms) before lookup.
  const ref = m[0].toUpperCase().replace(/^CASE[\s-]?/, 'CASE-').replace(/(\d)[\s-]([a-z0-9]+)$/i, '$1-$2')
  // Full ref (CASE-<digits>-<suffix>): exact equality lookup.
  if (/CASE-\d+-[a-z0-9]+/i.test(ref)) {
    try { const c = await store.getCaseByRef(ref); if (c) return c } catch { /* fall through to prefix */ }
  }
  // Bare partial (CASE-<digits>): unique prefix match, else null.
  try {
    const rows = await store.listCases({}, { limit: 500 })
    const hits = rows.filter(r => String(r.ref || '').toUpperCase().startsWith(ref + '-') || String(r.ref || '').toUpperCase() === ref)
    return hits.length === 1 ? hits[0] : null
  } catch { return null }
}

export function sanitizeOutboundRef(text, realRef) {
  if (!text || !realRef) return { text, corrected: [] }
  const corrected = []
  const fixed = String(text).replace(CASE_REF_RE, (tok) => {
    if (tok.toLowerCase() === String(realRef).toLowerCase()) return tok
    corrected.push(tok)
    return realRef
  })
  return { text: fixed, corrected }
}

// The stock holding line ("thank you for letting us know ... your reference is
// <ref>") carries no case-specific content beyond the ref. A reply that is
// substantively only this line is a memorized/parroted turn -- it does not advance
// intake. Detected on a ref-stripped, normalised copy so the (now-correct) ref
// does not mask the parrot. Distinct from isPromptEcho: that catches the
// first-contact exemplar; this catches the bare stock ack the weak model recites
// on EVERY later turn (witnessed live: a 2nd identical-shape reply shipped a bad
// ref because only the exemplar phrasing was guarded). ASCII only.
const STOCK_ACK_SHAPES = [
  'thank you for letting us know. we have your message and the team will look into it.',
  'thank you for letting us know. our team will look into this.',
]
export function isStockAck(text) {
  if (!text) return false
  const norm = String(text).toLowerCase().replace(CASE_REF_RE, '').replace(/your reference is\s*\.?/g, '').replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim()
  return STOCK_ACK_SHAPES.some(m => {
    const mn = m.toLowerCase().replace(/your reference is\s*\.?/g, '').replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim()
    return norm === mn
  })
}

// Pre-send jargon guard. casey's design rule is plain, warm language to the
// contact: never internal jargon (case/triage/workflow/status/priority). A weak
// model occasionally leaks one of these words into a reply. This is a
// deterministic word-BOUNDARY scan (so "in case" the conjunction, "status quo",
// or "workflow" inside a contact-quoted phrase are matched as whole words only,
// and substrings like "staircase"/"workflows" of a different word do not false-
// positive) over the OUTBOUND reply just before it leaves. On a hit the reply is
// NOT sent: it is held as a draft for a human, exactly like assisted mode, with
// the offending words recorded. This is a JARGON gate only -- it deliberately does
// NOT inspect language/non-English (that is a separate concern and not in scope).
// Returns the list of banned words found (empty = clean). ASCII only.
const JARGON_WORDS = ['case', 'triage', 'workflow', 'status', 'priority']
const JARGON_RE = new RegExp('\\b(' + JARGON_WORDS.join('|') + ')\\b', 'gi')
export function jargonHits(text) {
  if (!text) return []
  // Strip the case-reference token first: a real ref is "CASE-1073-iyniv", whose
  // "CASE" prefix would otherwise trip \bcase\b on EVERY reply that quotes the
  // reference (the contact-facing ref is required, not jargon). The ref is the one
  // legitimate place "CASE" appears in an outbound; scan the rest.
  const scrubbed = String(text).replace(CASE_REF_RE, ' ')
  const found = new Set()
  const m = scrubbed.match(JARGON_RE)
  if (m) for (const w of m) found.add(w.toLowerCase())
  return [...found]
}

// Holding message in the contact's own language, for the worst-case path: the
// LLM turn errored, timed out, or returned nothing. A low-literacy contact who
// wrote in Spanish must NOT get an English wall of text back (P9 worst-case +
// P12 human value) -- the degraded reply mirrors their language too. Keyed by a
// lightweight cue detector over the languages casey already claims to support;
// when no cue matches we keep the plain-English default. `ref` is appended when
// known so even the fallback hands the contact their reference number.
// Holding messages in the languages common to rural South Africa. The live model
// handles any language; these are only the offline/degraded path, so we cover the
// SA languages a farmer is likely to write in -- not Latin-American Spanish. Tone
// fits a disease report: "we have your message, the team will look into it".
// Offline holding messages cover en + af/zu/xh consistently (every one of these
// languages also has full INTENT/STATUS tables below). Sesotho/Setswana and any
// other SA language are handled by the live model, not hand-translated tables --
// keeping the offline set to languages we cover end-to-end avoids the half-built
// state where guessLang returns a language the status/intent replies cannot speak.
const FALLBACK_BY_LANG = {
  af: 'Dankie dat u laat weet het. Ons het u boodskap en die span sal hierna kyk.',
  zu: 'Siyabonga ngokusazisa. Siwutholile umlayezo wakho futhi ithimba lizokubheka lokhu.',
  xh: 'Enkosi ngokusazisa. Siwufumene umyalezo wakho kwaye iqela liza kukujonga oku.',
}

// Cheap, accent-stripped cue match. A wrong guess that flips a contact's language
// is worse than defaulting to English (P6: make the wrong outcome hard), so cues
// are DISTINCTIVE -- tokens one SA language uses that its neighbours do not. We
// score every language by how many of its distinctive cues appear and pick the
// clear winner; ties or no hits fall back to English. (Sotho/Tswana are close,
// so their cues are chosen to separate them; on a tie we fall back to English.)
const LANG_CUES = {
  af: [' dankie ', ' asseblief ', ' hallo ', ' goeie ', ' siek ', ' beeste ', ' het nie ', ' gekom ', ' ek ', ' vrek ', ' diere ', ' hou op ', ' los my ', ' genoeg ', ' mens '],
  zu: [' sawubona ', ' ngiyabonga ', ' usizo ', ' siza ', ' yami ', ' ngicela ', ' izinkomo ', ' iyagula ', ' ngi ', ' yeka ', ' hambani ', ' umuntu '],
  xh: [' molo ', ' enkosi ', ' nceda ', ' yam ', ' iinkomo ', ' iyagula ', ' ndi ', ' kwaye ', ' umntu ', ' hamba '],
}

export function guessLang(text) {
  const t = ` ${normalizeIntentText(text)} `
  if (!t.trim()) return 'en'
  if (/[؀-ۿ]/.test(text || '')) return 'ar'
  if (/[ऀ-ॿ]/.test(text || '')) return 'hi'
  let best = 'en', bestScore = 0, tie = false
  for (const [lang, cues] of Object.entries(LANG_CUES)) {
    const score = cues.reduce((n, c) => n + (t.includes(c) ? 1 : 0), 0)
    if (score > bestScore) { best = lang; bestScore = score; tie = false }
    else if (score === bestScore && score > 0) tie = true
  }
  // A genuine tie between two non-English languages is ambiguous: English is
  // the safe default (it never claims to speak a language it might have wrong).
  return tie ? 'en' : best
}

// Localised "your reference is X" tail, kept short. Exposed on its own so a reply
// that already leads with a specific captured-field acknowledgement can append
// just the reference without a second, redundant "thank you" preamble.
export function refTail(contactText, caseRow) {
  const ref = caseRow?.ref
  if (!ref) return ''
  const lang = guessLang(contactText)
  return {
    af: ` U verwysingsnommer is ${ref}.`,
    zu: ` Inombolo yakho yereferensi ngu-${ref}.`,
    xh: ` Inombolo yakho yesalathiso ngu-${ref}.`,
  }[lang] || ` Your reference is ${ref}.`
}

// An ENQUIRY is a worker asking ABOUT their work -- "what's on the itinerary
// today", "my cases", "what am I working on", "anything I can help with" -- as
// opposed to REPORTING an animal (the intake content). The weak production model
// never calls the freddie enquiry tools (case_today/case_mine/...), so an enquiry
// question fell through to intake and -- on a complete case -- got the
// complete-report exit ("we have the full report ... your reference is X"). This
// deterministic detector recognises the question and routes it to a real itinerary
// answer, mirroring how detectContactIntent short-circuits status/help.
//
// Returns 'today' | 'mine' | 'open' | null. The today-enquiry is matched
// STRUCTURALLY, not by a fixed phrase list: a worker checks in with whatever
// colloquial shape comes naturally ("hi there whats up today", "whats up", "anything
// today", "hows today", "what is happening today"), often behind a greeting. A fixed
// list missed all of these (the witnessed regression). So a today-enquiry is a
// "checking-in" question shape -- optionally paired with a today/now signal -- and
// the explicit itinerary words still match too. The REPORT_VETO is checked FIRST so
// a report that merely mentions "today" ("2 cows died today") is never swallowed.
//
// EXPLICIT today/itinerary words: always a today-enquiry on their own.
const ENQUIRY_TODAY_WORDS = ['itinerary', 'itenerary', 'agenda', 'schedule', 'on today', 'on for today',
  'todays list', 'today list', 'on the go today', 'my day', 'my list today', 'plan for today',
  'rooster', 'vandag se lys']   // af: vandag = today
// A "checking-in" question shape -- how a worker casually asks what is going on.
// On its own this is a today-enquiry (a worker checking in); with a today signal it
// is unambiguous. Kept deliberately broad and colloquial.
const CHECKIN_SHAPES = ['whats up', 'what is up', 'whats on', 'what is on', 'whats happening',
  'what is happening', 'whats going on', 'what is going on', 'whats new', 'what is new', 'hows it going',
  'hows it', 'hows today', 'how is today', 'anything for me', 'what do i have', 'what have i got',
  'what is there', 'whats there', 'anything today', 'anything for today']
// A today/now signal: pairs with a checking-in shape, but a bare checking-in shape
// already counts (see below).
const TODAY_SIGNAL = ['today', 'vandag', 'right now', 'on the go', 'going on']
const ENQUIRY_MINE = ['my cases', 'my case', 'my reports', 'what am i working on', 'what i am working on',
  'assigned to me', 'on my plate', 'my work', 'my visits', 'whats mine', 'my jobs', 'my list']
const ENQUIRY_OPEN = ['anything i can help', 'what can i help', 'open cases', 'open work',
  'available work', 'anything open', 'whats open', 'what is open', 'jobs available', 'help with anything']
// A report-content veto: if the message reads like someone describing animals, it is
// intake, not an enquiry, even if it happens to contain a question or a "today".
const REPORT_VETO = ['sick', 'dead', 'dying', 'died', 'die', 'blood', 'bleeding', 'drooling', 'limping',
  'lame', 'blisters', 'cough', 'collaps', 'swollen', 'not eating', 'cattle are', 'cow is', 'goats are',
  'sheep are', 'pigs are', 'animals are', 'is sick', 'are sick']

function hasKey(t, keys) {
  const padded = ` ${t} `
  const words = t.split(' ')
  return keys.some(k => padded.includes(` ${k} `) || (!k.includes(' ') && words.includes(k)))
}

export function detectEnquiryIntent(text) {
  const t = normalizeIntentText(text)
  if (!t) return null
  // A clear report description is never an enquiry, however it is phrased -- checked
  // FIRST so "2 cows died today" stays a report despite the "today" signal.
  if (hasKey(t, REPORT_VETO)) return null
  if (hasKey(t, ENQUIRY_OPEN)) return 'open'
  if (hasKey(t, ENQUIRY_MINE)) return 'mine'
  if (hasKey(t, ENQUIRY_TODAY_WORDS)) return 'today'
  // Structural today-enquiry: a colloquial checking-in shape (with or without an
  // explicit today/now signal) is a worker asking what is on for them. The shape
  // itself carries the intent, so a bare "whats up" / "anything today" both match.
  if (hasKey(t, CHECKIN_SHAPES)) return 'today'
  return null
}

// One PII-free itinerary line per case: reference, plain status, subject, and when
// it was last active in SAST. projectCase strips external_id/contact_id, so a phone
// number can never reach a worker's list.
function itineraryLine(row, lang) {
  const p = projectCase(row, DEFAULT_PROJECTION)
  // CONTENT-FIRST + terse: show the REPORT subject (species/location from the report
  // JSON, not a column), NOT the verbose plainStatus sentence (which read like a
  // holding reply in a list). Status is demoted to a short parenthetical label. No
  // trailing comma. PII-free via projectCase.
  const rep = parseReportSafe(row.report)
  const clean = (s) => String(s || '').replace(/\s*,\s*/g, ' ').replace(/\s+/g, ' ').trim()
  const species = clean(rep.species), location = clean(rep.location)
  let subject = (species && location) ? `${species} near ${location}` : species || location || clean(p.subject) || 'a report'
  subject = subject.slice(0, 60).replace(/[\s,]+$/, '')
  const when = p.last_event_at ? fmtTimeSAST(p.last_event_at) : ''
  const meta = `${shortStatus(p.status, lang)}${when ? `, last active ${when}` : ''}`
  return `- ${p.ref} -- ${subject} (${meta})`
}

// Hydrate the per-case event log for the aggregators that need it (overview, sla).
// Sequential by design but capped by the caller's slice so a latency-sensitive chat
// turn never fans out unboundedly. Returns the Map<caseId, events[]> shape
// buildOverview/buildSLAReport expect (they call evData internally on raw events).
async function hydrateEvents(store, cases) {
  const m = new Map()
  for (const c of cases) m.set(c.id, await store.listEvents(c.id).catch(() => []))
  return m
}

// Answer a FLEET-AGGREGATE enquiry -- the same reach the dashboard GUI has -- by
// calling the existing pure aggregators over the case store and rendering a warm,
// plain-language, PII-FREE summary. NEVER a per-case row, ref, external_id, phone, or
// operator identity reaches a field worker here: counts and place/species tokens
// only. Never a dead-end -- every branch invites a fresh report. The whole body is in
// one try with the same warm catch as renderItinerary, so a store hiccup degrades
// gracefully.
async function renderAggregate(store, kind, author, inboundText, now = Date.now(), place = '', status = '') {
  try {
    const CAP = 500
    // UNSCOPED fleet read -- deliberately NO user:author. thatcher row_access is
    // {scope:assigned, field:assignee} (thatcher.config.yml), and the chat author is
    // the field-worker REPORTER, never an assignee -- so a scoped pull returns ~0
    // rows and every fleet answer became a reassuring-when-wrong false-safe ("0 open
    // reports" on a busy store). The fleet aggregates emit ONLY PII-free scalars and
    // projected place/species tokens (no per-case row, ref, external_id, phone, or
    // operator identity), so reading the whole fleet is worker-safe. Row-access
    // scoping stays ONLY on the per-worker "mine" itinerary, where assignee-scoping
    // is the intent.
    const all = await store.listCases({}, { limit: CAP })
    const open = all.filter(c => c.status !== 'closed')
    const tail = ' Tell me about an animal and I will start a report.'
    if (kind === 'count') {
      // Per-status breakdown ("how many waiting/new/resolved"): count cases in that
      // status over the whole fleet (open is the non-closed slice; a closed/resolved
      // ask counts over `all`). Plain worker-facing sentence, count only.
      if (status) {
        const want = String(status).toLowerCase()
        const pool = (want === 'closed' || want === 'resolved' || want === 'done' || want === 'finished') ? all : open
        const n = pool.filter(c => String(c.status || '').toLowerCase() === want).length
        const label = want.replace(/_/g, ' ')
        return `There are ${n} reports ${label}.` + tail
      }
      // Place-scoped count ("how many open in limpopo"): filter open by the resolved
      // region terms over the hydrated report, then COUNT (never list rows). Framed as
      // a FLOOR because the CAP=500 recency slice can under-count a very busy area.
      const rp = place ? resolvePlace(place) : null
      if (rp) {
        const inPlace = open.filter(c => {
          const rep = parseReportSafe(c.report)
          const hay = `${rep.location || ''} ${c.subject || ''}`.toLowerCase()
          return rp.terms.some(term => containsTerm(hay, term))
        }).length
        return `There are at least ${inPlace} open reports in ${placeRegionLabel(rp.regions)}.` + tail
      }
      const todayCut = new Date(now); todayCut.setHours(0, 0, 0, 0)
      // last_event_at/created_at are ISO strings -- Date.parse, not Number().
      const today = open.filter(c => Date.parse(c.last_event_at || c.created_at) >= todayCut.getTime()).length
      const mine = author ? open.filter(c => c.assignee === author).length : 0
      let body = `Right now there are ${open.length} open reports. ${today} had activity today.`
      if (author) body += ` ${mine} are on your list.`
      // Animal-bearing count -> a per-species tally over the open reports (reported
      // head is a lower bound -- only what workers entered).
      if (/\b(cattle|cow|cows|calf|calves|ox|oxen|sheep|lamb|goat|goats|pig|pigs|chicken|chickens|poultry|herd|livestock|animal|animals)\b/.test((inboundText || '').toLowerCase())) {
        const bySpecies = {}
        for (const c of open) {
          const sp = String(parseReportSafe(c.report).species || '').toLowerCase().trim()
          if (sp) bySpecies[sp] = (bySpecies[sp] || 0) + 1
        }
        const lines = Object.entries(bySpecies).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([sp, n]) => `- ${sp}: ${n} reports`)
        if (lines.length) body += `\nBy what workers entered:\n${lines.join('\n')}`
      }
      return body + tail
    }
    if (kind === 'geo') {
      const places = buildGeo(open).filter(p => p.place && p.place !== 'unknown').slice(0, 3)
      if (!places.length) return 'No reports have a place on them yet.' + tail
      return `The busiest areas right now:\n${places.map(p => `- ${p.place}: ${p.count}`).join('\n')}` + tail
    }
    if (kind === 'outbreaks') {
      // Tokenized merged-tag filter (matches the dashboard), then surface ONLY the
      // aggregate count/species/location -- NEVER iterate cl.members (they carry
      // id/subject = contact-supplied free text, a PII path).
      const pool = open.filter(c => !String(c.tags || '').split(',').map(s => s.trim()).includes('merged'))
      const cl = buildClusters(pool).slice(0, 3)
      if (!cl.length) return 'No groups of linked reports stand out yet.' + tail
      return `Possible linked report groups:\n${cl.map(c => `- ${c.count} reports${c.species && c.species[0] ? ` of ${c.species[0]}` : ''} around ${(c.location && c.location[0]) || 'an area'}`).join('\n')}` + tail
    }
    if (kind === 'overview') {
      const ev = await hydrateEvents(store, all.slice(0, 200))
      const o = buildOverview(all, ev, now)
      const closed = all.filter(c => c.status === 'closed').length
      const med = o.first_response_ms?.median
      const speed = med == null ? 'no reply speed measured yet' : `usually replying in about ${Math.round(med / 60000)} min`
      return `Here is the picture: ${open.length} open and ${closed} closed, ${speed}.` + tail
    }
    if (kind === 'overdue') {
      const ev = await hydrateEvents(store, all.slice(0, 200))
      const th = store.resolveThresholds ? await store.resolveThresholds() : null
      const target = Number.isFinite(th?.handoffMs) ? th.handoffMs : 30 * 60 * 1000
      const sla = buildSLAReport(all, ev, target, now)
      const late = sla.breached_count
      return (late ? `${late} report(s) are waiting longer than they should for a reply. The team has been flagged.` : 'Good news -- nothing is overdue right now.') + tail
    }
    return 'Your list is empty for now.' + tail
  } catch {
    return 'I could not pull that up just now. Please try again in a moment, or tell me about an animal and I will start a report.'
  }
}

// Render a warm, plain-language itinerary answer for a worker enquiry. Pulls the
// rows via the store's enquiry queries (the same listCases the freddie enquiry
// tools use), projects each PII-free, and never dead-ends: an empty list invites
// the worker to start a report rather than leaving them with nothing. `kind` is the
// enquiry_kind (today|mine|open|near); `place` is set for a near-enquiry.
async function renderItinerary(store, kind, author, inboundText, now = Date.now(), place = '', status = '') {
  const lang = guessLang(inboundText)
  // Resolve the place to a SA region (province + its towns) once, up front, so both
  // the row match and the reply copy can use it. null when the place names no known
  // region (then we fall back to a raw substring match on the place text).
  const resolvedPlace = place ? resolvePlace(place) : null
  let rows = []
  // FLEET-AGGREGATE kinds (count/geo/outbreaks/overview/overdue) reach the dashboard
  // aggregators rather than listing per-case rows -- they answer "how many open",
  // "where are the hotspots/outbreaks", "how are we doing", "whats overdue". They
  // never touch itineraryLine (no per-case rows) so no PII path is involved.
  const AGGREGATE = new Set(['count', 'geo', 'outbreaks', 'overview', 'overdue'])
  if (AGGREGATE.has(kind)) return await renderAggregate(store, kind, author, inboundText, now, place, status)
  try {
    if (kind === 'mine') {
      rows = await store.listCases({ assignee: author }, { limit: 20 })
    } else if (kind === 'open') {
      rows = await store.listCases({ status: { $in: ['new', 'triaging', 'in_progress', 'waiting'] } }, { limit: 20 })
      rows = rows.filter(r => !r.assignee || r.assignee === 'agent')
    } else if (kind === 'near') {
      // lat/lon is optional on a case and there is no geocoder, so a place/region
      // enquiry matches on the free-text location TEXT, not a lat/lon box. The place
      // is resolved through the SA province vocabulary (resolvePlace), so "kzn"
      // expands to every KZN town and a case in Durban/Margate matches "any cases in
      // kzn". A case's location lives in the report JSON (NOT a column), so we hydrate
      // the report and match location + subject + species. Word-boundary matching
      // (containsTerm) keeps a 2-char alias from substring-hitting unrelated prose.
      const all = await store.listCases({}, { limit: 200 })
      const p = String(place || '').toLowerCase().trim()
      const terms = resolvedPlace ? resolvedPlace.terms : (p ? [p] : [])
      // The EXACT named town (not the whole resolved region) for "closest" ordering.
      const exactTerm = p || null
      rows = terms.length
        ? all.filter(r => {
          const rep = parseReportSafe(r.report)
          const hay = `${rep.location || ''} ${r.subject || ''} ${rep.species || ''}`.toLowerCase()
          return terms.some(term => containsTerm(hay, term))
        })
          // Closest-first: a case whose location names the EXACT town the worker asked
          // about ranks above other towns in the same region (no geocoder, so an exact
          // place-name match is the proxy for proximity); recency breaks ties.
          .map(r => {
            const rep = parseReportSafe(r.report)
            const hay = `${rep.location || ''} ${r.subject || ''}`.toLowerCase()
            const exact = exactTerm && containsTerm(hay, exactTerm) ? 0 : 1
            return { r, exact, recency: Date.parse(r.last_event_at || r.created_at) || 0 }
          })
          .sort((a, b) => a.exact - b.exact || b.recency - a.recency)
          .slice(0, 20)
          .map(x => x.r)
        : []
    } else { // 'today'
      const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0)
      const since = String(Math.floor(dayStart.getTime() / 1000))   // case timestamps are unix seconds
      const where = { last_event_at: { $gte: since } }
      if (author) where.assignee = author
      rows = await store.listCases(where, { limit: 20 })
    }
  } catch {
    // Never leak a store error to a worker; a warm holding line keeps the channel safe.
    return 'I could not pull up the list just now. Please try again in a moment, or tell me about an animal and I will start a report.'
  }
  // For a resolved region the copy reads as a province-wide query ("reports in
  // KwaZulu-Natal"); for an unresolved raw place it stays the proximity wording.
  const regionLabel = resolvedPlace ? placeRegionLabel(resolvedPlace.regions) : ''
  const placeLabel = regionLabel ? ` ${regionLabel}` : (place ? ` ${place}` : '')
  const nearIntro = resolvedPlace ? `Here are the reports in${placeLabel}:` : `Here are the closest reports to${placeLabel}:`
  const intro = {
    today: 'Here is what is on the go today:',
    mine: 'Here are the reports on your list:',
    open: 'Here is open work you could help with:',
    near: nearIntro,
  }[kind] || 'Here is your list:'
  if (!rows.length) {
    const nearEmpty = resolvedPlace ? `I could not find a report in${placeLabel} yet.` : `I could not find a report near${placeLabel || ' there'} yet.`
    const empty = {
      today: 'Nothing is on your list for today yet.',
      mine: 'You have no reports on your list yet.',
      open: 'There is no open work waiting right now.',
      near: nearEmpty,
    }[kind] || 'Your list is empty for now.'
    return `${empty} If you are seeing a sick or dead animal, just tell me about it and I will start a report.`
  }
  const lines = rows.map(r => itineraryLine(r, lang)).join('\n')
  return `${intro}\n${lines}`
}

// The most recent model-declared intent (case_intent -> INTENT-DECLARED observation)
// that is FRESH: recorded after the last outbound, so a declaration from an earlier
// answered message is never reused. Returns a normalized intent {source:'model'} or
// null. This is how the in-loop model's reading governs routing without reordering
// the turn -- the model declares, the next inbound honors it.
async function latestModelIntent(store, caseId) {
  try {
    const events = await store.listEvents(caseId)
    let lastOutboundIdx = -1
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].kind === 'outbound') { lastOutboundIdx = i; break }
    }
    for (let i = events.length - 1; i > lastOutboundIdx; i--) {
      const e = events[i]
      if (e.kind !== 'observation') continue
      const m = /INTENT-DECLARED\s+(\{.*\})/.exec(e.text || '')
      if (!m) continue
      let payload = null
      try { payload = JSON.parse(m[1]) } catch { payload = null }
      const norm = normalizeIntent(payload, 'model')
      if (norm) return norm
    }
  } catch { /* fall back to the deterministic classifier */ }
  return null
}

// A general QUESTION that is not a report and not a known enquiry. The cardinal rule:
// never the complete-report exit. Acknowledge the question warmly, say the team can
// help, and keep the channel open -- a worker who asks something we cannot answer
// deterministically is handed to the team, never closed out.
// A general question that resolvePlace + the enquiry classifier did NOT turn into a
// store lookup. Rather than the old bare deflection ("I do not have that to hand"),
// name what casey CAN do -- pull up today's list, the worker's own reports, open
// work, or reports in a place -- so the reply is a productive door back in, never a
// dead-end. Still hands a genuinely out-of-scope ask to the team.
function answerQuestion(inboundText, caseRow) {
  const base = 'I cannot answer that one myself, but the team can -- I have noted it for them. I can also pull up reports for you: what is on today, your own list, open work, or reports in a place (for example any cases in KwaZulu-Natal). Or tell me about an animal and I will start a report.'
  return base + refTail(inboundText, caseRow)
}

export function fallbackReply(contactText, caseRow) {
  const lang = guessLang(contactText)
  const base = FALLBACK_BY_LANG[lang] || FALLBACK_REPLY
  const ref = caseRow?.ref
  if (!ref) return base
  return base + refTail(contactText, caseRow)
}

// A bare greeting is the OPENING of a report, not chit-chat to deflect: memobot's
// job is to gather the case while someone is on-site, so even "hi" must DRIVE
// collection -- a warm opener PLUS the first needed fact (warmConversationalReply
// below). Replying to "hi" with the holding ack ("Thank you for letting us
// know ... your reference is X") is the witnessed nonsense (it parrots a case
// acknowledgement before the person has said anything); a no-ask pleasantry is the
// other dead-end (it collects nothing). The right reply greets briefly and asks.
//
// Strip channel mention/markup tokens that a chat platform injects when a
// contact addresses the bot. On Discord, "@memobot hello" arrives as msg.content
// "<@BOTID> hello"; the numeric snowflake id inside the mention was being
// captured by extractFields as a livestock COUNT, so a bare greeting stopped
// reading as content-free and got the case-ack with a fabricated affected_count.
// We strip Discord-style user/role/channel mentions (<@id>, <@!id>, <@&id>,
// <#id>), Discord custom-emoji tokens (<:name:id> / <a:name:id>), and a leading
// bare "@name" handle, for the text used to drive capture/intent/replies. The
// raw inbound is still recorded verbatim in the event log for audit -- only the
// reasoning copy is cleaned. Returns the trimmed, collapsed remainder.
export function stripChannelMarkup(text) {
  return (text || '')
    .replace(/<a?:\w+:\d+>/g, ' ')        // custom emoji <:name:id> / <a:name:id>
    .replace(/<[@#][!&]?\d+>/g, ' ')      // <@id> <@!id> <@&id> <#id>
    .replace(/^\s*@[\w.-]+\b/, ' ')       // a leading bare @handle (e.g. "@memobot")
    .replace(/\s+/g, ' ')
    .trim()
}

// framed as "if you need it" rather than "we have your message". ASCII only.
// Short orienting opener -- the most-important-fact ask (appended below) carries
// the substance, so this stays brief to keep the whole reply under the 240-char
// cap once the ask and reference are added.
const WARM_GREETING_BY_LANG = {
  en: 'Hi! I am here to help with any animals that are sick or have died.',
  af: 'Hallo! Ek help met enige diere wat siek is of gevrek het.',
  zu: 'Sawubona! Ngisiza ngezilwane ezigulayo noma ezifile.',
  xh: 'Molo! Ndinceda ngezilwanyana ezigulayo okanye ezifileyo.',
}
// A warm RE-OPENER for a greeting / chit-chat on a case with nothing left to ask
// (e.g. a finished report). The cardinal rule: NEVER the complete-report exit -- a
// worker who just says "hi there" must get a friendly door back in, not "we have the
// full report ... your reference is X" (the witnessed dead-end). It invites a fresh
// report OR offers to pull up today's list, so the conversation continues.
const CHITCHAT_REOPEN_BY_LANG = {
  en: 'Hi! Good to hear from you. If you are seeing a sick or dead animal, just tell me about it and I will start a report -- or say "what is on today" to see your list.',
  af: 'Hallo! Lekker om van u te hoor. As u \'n siek of dooie dier sien, vertel my net en ek begin \'n verslag -- of se "wat is vandag aan die gang" om u lys te sien.',
  zu: 'Sawubona! Kuhle ukuzwa kuwe. Uma ubona isilwane esigulayo noma esifile, ngitshele nje ngizoqala umbiko -- noma uthi "yini ekhona namuhla" ukuze ubone uhlu lwakho.',
  xh: 'Molo! Kuhle ukuva kuwe. Ukuba ubona isilwanyana esigulayo okanye esifileyo, ndixelele ndiza kuqala ingxelo -- okanye uthi "yintoni ekhoyo namhlanje" ukubona uluhlu lwakho.',
}
// A warm conversational re-opener for a greeting / chit-chat turn. Mirrors language
// and carries the reference, but NEVER recites the complete-report exit -- this is
// the reply that keeps a "hi there" from dead-ending on a finished case.
export function chitchatReply(contactText, caseRow) {
  const lang = guessLang(contactText)
  const base = CHITCHAT_REOPEN_BY_LANG[lang] || CHITCHAT_REOPEN_BY_LANG.en
  return base + refTail(contactText, caseRow)
}
// A greeting/content-light turn must DRIVE collection, not deflect with a
// pleasantry: memobot's job is to gather the report while someone is on-site, so
// even a bare "hi" opens warmly AND asks for the single most-important still-
// missing fact (on a brand-new case that is "where the animals are"). Never a
// no-ask pleasantry, never the "Thank you for letting us know" case-ack. The warm
// opener orients a brand-new contact; the appended ask starts the collection.
export function warmConversationalReply(contactText, caseRow, hintOverride) {
  const lang = guessLang(contactText)
  const base = WARM_GREETING_BY_LANG[lang] || WARM_GREETING_BY_LANG.en
  // Drive forward: the caller's chosen next ask (nextAsk, skipping already-asked
  // fields) when given, else the most-important missing visit-critical fact or a
  // value-add ask -- never a no-ask greeting.
  const hint = hintOverride || mostImportantMissingField(caseRow?.report) || nextValueAddAsk(caseRow?.report)
  // Complete report: a greeting on a finished case must NOT recite the complete-
  // report exit ("we have the full report ...") -- the witnessed dead-end where
  // "hi there" reads as a closed-out non-answer. Give the warm re-opener instead: a
  // friendly door back in that invites a fresh report or offers today's list.
  if (!hint) return chitchatReply(contactText, caseRow)
  const ask = ` ${askCarrier(lang, hint)}`
  const ref = caseRow?.ref
  if (!ref) return base + ask
  const tail = {
    af: ` U verwysingsnommer is ${ref}.`,
    zu: ` Inombolo yakho yereferensi ngu-${ref}.`,
    xh: ` Inombolo yakho yesalathiso ngu-${ref}.`,
  }[lang] || ` Your reference is ${ref}.`
  return base + ask + tail
}

// True when this inbound turn carried NO livestock-report content: nothing was
// deterministically captured this turn AND the running report has no field
// recorded at all. Such a turn is conversational (a greeting, a "help", chit-chat)
// rather than intake-in-progress, so the intake-drive / holding-ack paths must not
// fire on it. A real report ("my sheep are sick" -> species+symptoms) or a
// symptom-only message ("blue eyes" -> symptoms) captures a field, so this is
// false for them and intake proceeds exactly as before. Deterministic, no model.
export function isContentFreeTurn(justCaptured, reportRaw) {
  if (Array.isArray(justCaptured) && justCaptured.length) return false
  const r = parseReportSafe(reportRaw)
  return !Object.keys(r).some(k => r[k] != null && String(r[k]).trim() !== '')
}

// A single gentle "could you tell me <fact>?" carrier per language. The asked-fact
// phrase itself stays English plain-language (the canonical VISIT_CRITICAL_ASK
// hints); the carrier sentence mirrors the contact's language. This is the
// offline/degraded one-shot path -- the live model handles full localisation; here
// honest degradation beats a dead-end ack.
function askCarrier(lang, fact) {
  const c = {
    af: `Kan u my asseblief vertel ${fact}?`,
    zu: `Ungangitshela ${fact}?`,
    xh: `Ungandixelela ${fact}?`,
  }[lang]
  return c || `Could you tell me ${fact}?`
}

// A short language-mirrored opener that DRIVES collection instead of acknowledging
// receipt. memobot's job is to gather the report while someone is on-site, so an
// intake turn must read as "warmly asking for the next thing", never as the
// "Thank you for letting us know ... we have your message" holding-ack (which
// reads as a dead-end even when an ask is appended). When a fact was just captured
// we lead by naming it ("Thank you -- I have noted X"); otherwise a one-word warm
// opener. The ask for the next needed fact follows, then a short ref tail.
const INTAKE_OPENER_BY_LANG = {
  en: 'Thank you.', af: 'Dankie.', zu: 'Ngiyabonga.', xh: 'Enkosi.',
}
function intakeOpener(lang) { return INTAKE_OPENER_BY_LANG[lang] || INTAKE_OPENER_BY_LANG.en }

// The reply when a report is COMPLETE (every field captured): confirm it is on
// record and the team will follow up, AND give an EXIT -- invite a fresh report for
// any OTHER animal or place -- so a finished case is never a bare "Thank you. + ref"
// dead-end the worker is stuck on. A new substantive message then branches a new
// case (detectNewCaseConflict / find-or-create). Language-mirrored, <=240 with ref.
const COMPLETE_REPLY_BY_LANG = {
  en: 'Thank you -- we have the full report and the team will follow up. If you are seeing another animal or a different place, just tell me and I will start a fresh report.',
  af: 'Dankie -- ons het die volledige verslag en die span sal opvolg. As u nog \'n dier of \'n ander plek sien, vertel my net en ek begin \'n nuwe verslag.',
  zu: 'Ngiyabonga -- sinawo wonke umbiko futhi ithimba lizolandela. Uma ubona esinye isilwane noma enye indawo, ngitshele nje ngizoqala umbiko omusha.',
  xh: 'Enkosi -- sinayo yonke ingxelo kwaye iqela liza kulandela. Ukuba ubona esinye isilwanyana okanye enye indawo, ndixelele ndiza kuqala ingxelo entsha.',
}
function completeReply(contactText, caseRow) {
  const lang = guessLang(contactText)
  const base = COMPLETE_REPLY_BY_LANG[lang] || COMPLETE_REPLY_BY_LANG.en
  return base + refTail(contactText, caseRow)
}

// Value-add facts to ask for once every visit-critical field is captured -- so a
// reply is NEVER a bare "Thank you. Your reference is X" dead-end. These strengthen
// the report when the critical six are already in: a photo (the most useful on-site
// artifact a field visit cannot recreate), how many animals, when it started, a
// follow-up number. Priority-ordered; each is a plain-language hint like the
// visit-critical ones. Returns a hint for the first still-missing value-add, or
// null only when even these are all captured.
// Once the visit-critical facts are in, ask for what STRENGTHENS the report. The
// reporter is a field worker relaying a farmer's animals, so these ask what the
// worker can observe NOW (a photo, how many) FIRST, then the people facts (who is
// there and their link to the owner -- vital when the owner is away but a relative
// or herder is), then the farmer-dependent history framed as "what the person
// says", never "when YOU first noticed it" (the worker did not witness onset).
const VALUE_ADD_ASK = [
  ['photos', 'if a photo of the animals can be sent'],
  ['affected_count', 'how many animals are affected'],
  ['present_person', 'who is there with the animals and how they are linked to the owner'],
  ['owner_contact', 'the owner\'s name and a number to reach them'],
  ['onset', 'how long the animals have been like this, from what the person says'],
  ['suspected_disease', 'whether the person there has any idea what it might be'],
]
function nextValueAddAsk(reportRaw) {
  const r = parseReportSafe(reportRaw)
  const hit = VALUE_ADD_ASK.find(([k]) => r[k] == null || String(r[k]).trim() === '')
  return hit ? hit[1] : null
}

// THE single source of truth for "what to ask next": the first still-missing field
// (visit-critical first, then value-add) that has NOT already been asked. Returns
// [key, hint] or null when every askable field is filled-or-asked. askedKeys is the
// set reconstructed from the durable ASK markers, so a field is never asked twice
// across turns -- the loop where the same question repeats because its answer could
// not be captured is structurally impossible (the field is marked asked once and
// skipped thereafter; the next inbound is bound to it by the pending-ask binder).
function nextAsk(reportRaw, askedKeys = new Set()) {
  const r = parseReportSafe(reportRaw)
  const missing = ([k]) => (r[k] == null || String(r[k]).trim() === '') && !askedKeys.has(k)
  return VISIT_CRITICAL_ASK.find(missing) || VALUE_ADD_ASK.find(missing) || null
}

// Reconstruct the set of fields already asked from the durable ASK markers
// (FALLBACK-ASK + ASKED), so the next ask skips them and the pending-ask binder
// knows which field the last question was for.
function askedKeysFromEvents(events) {
  const asked = new Set()
  for (const e of events) {
    if (e.kind !== 'observation') continue
    const m = /(?:FALLBACK-ASK|ASKED):(\w+)/.exec(e.text || '')
    if (m) asked.add(m[1])
  }
  return asked
}

// The most recent field memobot asked for and that is STILL empty in the report --
// the field a free-text answer this turn should be bound to. Scans the event log
// newest-first for an ASK marker whose field has not since been filled.
function pendingAskKey(events, reportRaw) {
  const r = parseReportSafe(reportRaw)
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.kind !== 'observation') continue
    const m = /(?:FALLBACK-ASK|ASKED):(\w+)/.exec(e.text || '')
    if (m) {
      const k = m[1]
      const filled = r[k] != null && String(r[k]).trim() !== ''
      return filled ? null : k
    }
  }
  return null
}

// Build the intake-driving reply: [ack of a just-captured fact OR a warm opener] +
// the ask for the next fact + a short reference tail. This REPLACES the holding-ack
// preamble so every intake turn urges the next fact rather than parroting a case
// acknowledgement. `fact` is a VISIT_CRITICAL_ASK hint; when it is null (every
// visit-critical fact is captured) we DRIVE FORWARD with a value-add ask rather
// than degrade to a bare "Thank you. + ref" -- a content-free acknowledgement is
// the dead-end memobot must never send. Only when even the value-add facts are all
// in does the reply become a brief warm confirming line.
function intakeAdvanceReply(contactText, caseRow, justFilled, fact) {
  const lang = guessLang(contactText)
  const ack = ackCapturedFields(justFilled)          // '' when nothing captured this turn
  const hint = fact || nextValueAddAsk(caseRow?.report)
  // Report complete (nothing left to ask) AND nothing new captured this turn: this
  // is a finished case, so confirm + invite a fresh report rather than dead-ending
  // on a bare "Thank you. + ref". When a fact WAS just captured we still lead with
  // its acknowledgement (the completing answer) before the confirm-and-exit.
  if (!hint) {
    // Defence-in-depth: completeReply (the "we have the full report" EXIT) fires only
    // on a GENUINE completion arc -- the report is complete AND either a fact was
    // captured this turn (the completing answer) OR this inbound introduces no
    // differing species/location (a real wrap-up/thanks). A fresh-content turn on a
    // complete case is handled by the branch in handleInbound; if it ever reaches here
    // (the model-error fallback), we do NOT exit -- we fall through to drive the most
    // important missing field rather than dead-end. (An animal word alone, e.g.
    // "thanks, the cattle are fine now", does NOT block the exit -- only a DIFFERING
    // species/location does.)
    if (isCompletionArc(justFilled, caseRow?.report, contactText)) {
      const close = completeReply(contactText, caseRow)
      return ack ? `${ack} ${close}` : close
    }
    const drive = mostImportantMissingField(caseRow?.report)
    const lead0 = ack || intakeOpener(lang)
    return drive ? `${lead0} ${askCarrier(lang, drive)}${refTail(contactText, caseRow)}` : completeReply(contactText, caseRow)
  }
  const lead = ack || intakeOpener(lang)
  return `${lead} ${askCarrier(lang, hint)}${refTail(contactText, caseRow)}`
}

// completeReply (the complete-report EXIT) may fire ONLY on a genuine completion arc:
// the report is complete (nextAsk null) AND either a fact was captured this turn (the
// completing answer) OR the inbound names no differing species/location (a real
// wrap-up). A fresh-content turn that names a different species/location is NOT a
// completion -- it must not dead-end on the exit.
function isCompletionArc(justCaptured, reportRaw, inboundText) {
  if (nextAsk(reportRaw) !== null) return false
  if (Array.isArray(justCaptured) && justCaptured.length) return true
  return detectNewCaseConflict(inboundText || '', reportRaw).length === 0
}

// The degraded reply that does NOT dead-end: when the model errored/echoed/emptied
// but the case still needs a visit-critical fact, an intake-driving opener is
// followed by ONE gentle question for the single most important missing fact, so
// the intake advances even on the fallback path. When nothing is missing, it is a
// brief warm confirming close (never the holding-ack preamble). Caller guards
// once-only via an observation marker so a contact is not re-asked the same fact.
export function advancingFallback(contactText, caseRow) {
  const fact = mostImportantMissingField(caseRow?.report)
  return intakeAdvanceReply(contactText, caseRow, [], fact)
}

export function makeCaseHandler(store, { callLLM = null, llmStatus = null, autoRespond = true, log = console, notifyHandoff = null } = {}) {
  // Per-contact in-flight guard: if a prior agent turn is still running for this
  // contact, we drop the new message rather than race two concurrent LLM calls
  // against the same case. The contact's inbound is still recorded (above), so
  // nothing is lost -- the next turn will pick up the full conversation including
  // this message. The guard is keyed on external_id (the canonical contact key).
  const inFlight = new Set()
  return async function handleInbound(platform, msg) {
    const channel = CHANNEL_DEFAULT[platform] || platform || 'other'
    const external_id = conversationKey(msg)   // per-contact case IDENTITY
    const replyTo = replyTarget(msg)           // channel/chat DELIVERY target
    const adapter = this?.platforms?.get?.(platform)
    if (!store) {
      log?.error?.('[casey] store not initialized')
      const warmText = FALLBACK_REPLY + ' We are experiencing a brief interruption. Please try again shortly.'
      // The gateway discards this handler's return value (freddie run.js calls
      // handleInbound only for its side effects), so a warm holding reply reaches
      // the contact ONLY if we send it ourselves. Target external_id (channel id
      // on Discord, phone on WhatsApp) -- msg.from is the author id and would 404.
      if (adapter?.send) {
        try { await adapter.send({ to: replyTo, text: warmText, platform }) }
        catch (e) { log?.error?.('[casey] store-not-ready holding send failed', { channel, error: e.message }) }
      }
      return { to: replyTo, text: warmText, platform, error: 'store_not_ready' }
    }
    const msgId = messageId(msg)

    let caseRow, created
    try {
      ;({ case: caseRow, created } = await store.findOrCreateCase({
        channel, external_id,
        contact: { display_name: msg.raw?.author?.username, handle: msg.raw?.author?.username },
      }))
    } catch (e) {
      // Do NOT log external_id -- it is the contact's phone number (PII). Channel
      // plus the error is enough to diagnose without writing PII to the log sink.
      log.error?.('[casey] findOrCreateCase failed', { channel, error: e.message })
      // Send a warm holding message rather than empty text so the contact knows
      // their message arrived and the team will follow up. The gateway ignores
      // this return value, so deliver it ourselves to external_id (the channel id
      // on Discord, the phone on WhatsApp); msg.from is the author id and 404s.
      const storeDownText = fallbackReply(msg.text || '', null)
      if (adapter?.send) {
        try { await adapter.send({ to: replyTo, text: storeDownText, platform }) }
        catch (sendErr) { log.error?.('[casey] store-down holding send failed', { channel, error: sendErr.message }) }
      }
      return { to: replyTo, text: storeDownText, platform, error: e.message }
    }

    // Dedup: a redelivered platform message (webhook retry, gateway replay, or
    // the same message duplicated in one tick) is recorded and answered exactly
    // once. recordInbound runs on the per-conversation lock so the dedup check
    // and the append are atomic -- duplicates are structurally unrepresentable,
    // not merely improbable.
    // Strip channel mention markup (e.g. Discord's "<@BOTID> hello" for an
    // "@memobot hello") so it never reaches capture/intent: the mention's numeric
    // id was being read as a livestock count, flipping a bare greeting out of the
    // content-free path into the case-ack. The raw msg.text is still recorded by
    // recordInbound below for audit; only the reasoning copy is cleaned.
    const inboundText = stripChannelMarkup(msg.text || '')
    const media = describeMedia(msg)
    const inboundEvent = await store.recordInbound(caseRow, {
      channel,
      text: inboundText || (media ? `[${media}]` : '[empty message]'),
      data: {}, msg_id: msgId,
    })
    // A resume re-drive (msg.resume) intentionally carries the ORIGINAL msg_id of
    // an inbound already recorded -- recordInbound correctly returns null. That is
    // the expected path here, not a duplicate to drop: the boot resume sweep is
    // re-running the turn for a message whose inbound persisted but whose reply
    // never went out. Fall through to the agent turn instead of short-circuiting.
    if (!inboundEvent && !msg.resume) {
      log.info?.('[casey] duplicate inbound dropped', { caseId: caseRow.id, msgId })
      return { to: replyTo, text: '', platform, caseId: caseRow.id, duplicate: true }
    }
    // A fresh inbound supersedes any pending assisted draft: the contact has said
    // more, so a draft composed against the old conversation is stale. Clear the
    // draft-pending tag (the agent turn below re-drafts against the full thread)
    // and record the supersession so the timeline shows why the old draft lapsed.
    // needs-human is left in place -- the case still wants an operator.
    if ((caseRow.tags || '').split(',').map(s => s.trim()).includes('draft-pending')) {
      try {
        await store.updateCase(caseRow.id, { tags: (caseRow.tags || '').split(',').map(s => s.trim()).filter(t => t && t !== 'draft-pending').join(',') })
        await store.appendEvent(caseRow.id, { kind: 'observation', actor: 'system', text: 'DRAFT SUPERSEDED: a new message arrived; the pending draft reply was set aside for a fresh one.' })
      } catch (e) { log.warn?.('[casey] draft supersede failed', { caseId: caseRow.id, error: e.message }) }
    }
    // One-shot: a received animal photo is recorded as explicit case state right
    // here, deterministically, so the operator always sees that a picture exists
    // -- never relying on the agent turn to notice it (it may not, on a media-only
    // message). Fill-if-empty so we never clobber a richer description the agent
    // records later. Skipped in observe mode (the store guards it) and harmless on
    // a malformed report. A failure here must never block the reply path.
    const photoNote = inboundImageNote(msg)
    if (photoNote) {
      try {
        const r = await store.markReportFieldsIfEmpty(caseRow.id, { photos: photoNote })
        if (r?.filled?.length) {
          await store.appendEvent(caseRow.id, { kind: 'observation', actor: 'system', text: `PHOTO RECEIVED: ${photoNote} (recorded for the field team).` })
        }
      } catch (e) { log.warn?.('[casey] photo mark failed', { caseId: caseRow.id, error: e.message }) }
    }
    // Same one-shot discipline for a voice note: record it as explicit state so an
    // operator always sees a voice message arrived, even on an audio-only message
    // the agent turn might not narrate. Fill-if-empty; never blocks the reply.
    const audioNote = inboundAudioNote(msg)
    if (audioNote) {
      try {
        const r = await store.markReportFieldsIfEmpty(caseRow.id, { audio: audioNote })
        if (r?.filled?.length) {
          await store.appendEvent(caseRow.id, { kind: 'observation', actor: 'system', text: `AUDIO RECEIVED: ${audioNote}.` })
        }
      } catch (e) { log.warn?.('[casey] audio mark failed', { caseId: caseRow.id, error: e.message }) }
    }
    if (created) {
      if (!caseRow.subject) {
        const subj = truncate(inboundText || media || 'New conversation', 80)
        try { await store.updateCase(caseRow.id, { subject: subj }) } catch (e) { log.warn?.('[casey] seed subject failed', { error: e.message }) }
      }
      // Tag intake source so the dashboard can filter and compare AI vs manual.
      try {
        const tags = String(caseRow.tags || '').split(',').map(t => t.trim()).filter(Boolean)
        if (!tags.includes('intake_mode:channel')) {
          await store.updateCase(caseRow.id, { tags: [...tags, 'intake_mode:channel'].join(',') })
        }
      } catch (e) { log.warn?.('[casey] intake_mode tag failed', { error: e.message }) }
      await store.appendEvent(caseRow.id, { kind: 'note', actor: 'system', text: `Case opened from ${channel}` })
    }

    if (!autoRespond) return { to: replyTo, text: '', platform, caseId: caseRow.id }

    let fresh = await store.getCase(caseRow.id)

    // observe-mode: the agent does not act or reply automatically; a human
    // drives the case. We still recorded the inbound above.
    if (fresh.autonomy === 'observe') {
      await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'autonomy=observe: awaiting operator (no auto-reply)' })
      // Observe mode means a human drives, but the case must still SURFACE for one
      // -- otherwise an observe-mode contact waits silently with nothing in the
      // triage inbox. Flag needs-human (the observable handoff signal) and notify
      // once on first flag, exactly like an explicit human request. Do NOT raise
      // priority: casey surfaces the request; the operator decides urgency.
      const alreadyFlagged = (fresh.tags || '').split(',').map(s => s.trim()).includes('needs-human')
      try {
        await store.updateCase(fresh.id, { tags: mergeTag(fresh.tags, 'needs-human') })
        if (notifyHandoff && !alreadyFlagged) {
          try { await notifyHandoff({ case: fresh, channel, from: msg.from }) }
          catch (e) { log.warn?.('[casey] observe handoff notify failed', { caseId: fresh.id, error: e.message }) }
        }
      } catch (e) { log.warn?.('[casey] observe needs-human flag failed', { caseId: fresh.id, error: e.message }) }
      return { to: replyTo, text: '', platform, caseId: fresh.id, observed: true }
    }

    // Deterministic field capture FIRST -- before any reply path (intent shortcut,
    // agent turn, or fallback). This guarantees the contact's plainly-stated facts
    // are recorded even when the model drives nothing, so a case is never an empty
    // shell. Runs only outside observe mode (returned above). Re-read fresh after so
    // downstream report-aware decisions see what was just captured.
    let justCaptured = []
    if (inboundText) {
      // The LLM extraction floor runs ONLY on a genuine intake message -- never an
      // enquiry ("any cases near margate"), a fixed intent (help/status/stop/human),
      // or a content-free greeting -- so a query place is never written as a field.
      // The deterministic regex always runs; callLLM is passed only when the message
      // is intake-shaped. pendingKey = the field last asked, so the model can bind the
      // answer to it.
      const isIntakeShaped = !detectContactIntent(inboundText) && !detectEnquiryIntent(inboundText)
      const pend = isIntakeShaped ? pendingAskKey(await store.listEvents(fresh.id), fresh.report) : null
      justCaptured = await captureFieldsFromText(store, fresh.id, inboundText, log, isIntakeShaped ? callLLM : null, pend)
      fresh = await store.getCase(fresh.id)
      // Bind a free-text answer to the field memobot just asked for, when the
      // extractor had no regex for it (e.g. "boyi son of the owner" -> present_person).
      // Without this an asked-but-unextractable field is never recorded and intake
      // re-asks the same question forever. The bound key counts as captured this turn
      // so the reply acknowledges it and advances to the next field.
      const boundKey = await bindPendingAsk(store, fresh.id, inboundText, justCaptured, log)
      if (boundKey) { justCaptured = [...justCaptured, boundKey]; fresh = await store.getCase(fresh.id) }
      // Keep the operator-facing subject/summary populated from the captured
      // fields when the model never set them (additive only -- never clobbers a
      // model/human value). Same captured-field projection that drives the
      // contact-facing acknowledgement, so a fully-degraded conversation still
      // gives an operator a real one-line picture instead of '(none yet)'.
      if (justCaptured.length) {
        const wrote = await syncSummaryFromCaptured(store, fresh, log)
        if (wrote) fresh = await store.getCase(fresh.id)
      }
      // A returning worker who states a clearly NEW situation (a species/location that
      // conflicts with the recorded report). Two cases, by whether the bound case is
      // already complete:
      const conflicts = detectNewCaseConflict(inboundText, fresh.report)
      // FRESH-REPORT BRANCH: the bound case is COMPLETE (nextAsk null), the message is
      // report-shaped, names a DIFFERENT species/location, and is not a fixed intent or
      // a ref-status ask -> the worker is STARTING a new report. Open a fresh case on
      // the same conversation, rebind it active, replay the inbound onto the empty case
      // so the new facts land there, and drive intake from it -- instead of the
      // complete-report exit (the witnessed "amapondos near the main road" -> "we have
      // the full report ... CASE-1089" dead-end). The continuation guard is structural:
      // detectNewCaseConflict needs a PRESENT-AND-DIFFERENT key, so a same/unstated
      // follow-up returns [] and never branches; an INCOMPLETE case has nextAsk != null
      // and takes the needs-split path below, never this branch.
      // A worker is starting a FRESH report on a complete case when the case is
      // complete, the message is report-shaped/intent-free, AND it carries report
      // content that the complete case cannot absorb -- either a DIFFERING key
      // (conflicts) OR report fields that NO-OP'd because the complete report already
      // holds them (the witnessed trap: 'close to amapondos'/'2 cows' on a complete
      // CASE-1089 -- same place/species, no conflict, but the worker is re-reporting
      // a NEW incident and their facts land nowhere). carriesReportContent: the
      // deterministic extractor found a report field in this message (so it is intake
      // content, not a bare greeting/ack) yet nothing was newly captured -> the
      // complete case swallowed it as a no-op.
      const extractedNow = extractFields(inboundText || '')
      const carriesReportContent = Object.keys(extractedNow).some(k => CAPTURE_KEYS.has(k))
      const completeNoOp = carriesReportContent && justCaptured.length === 0
      const startsFreshReport = (conflicts.length > 0 || completeNoOp)
        && nextAsk(fresh.report) === null
        && REPORT_SHAPED_RE.test(inboundText || '')
        && detectContactIntent(inboundText) == null
        && !detectEnquiryIntent(inboundText)
        && !REF_STATUS_RE.test(inboundText || '')
      if (startsFreshReport) {
        try {
          const oldRef = fresh.ref
          const branched = await store.branchCase({ channel, external_id, contact_id: fresh.contact_id })
          await store.setActiveCase(msg.from || external_id, branched.id)
          const why = conflicts.length ? `different ${conflicts.join(' and ')}` : 'new report facts a complete case could not absorb'
          await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `NEW-CASE-BRANCHED:${oldRef}->${branched.ref} worker started a fresh report (${why}) on a complete case.` })
          await store.appendEvent(branched.id, { kind: 'observation', actor: 'system', text: `NEW-CASE-BRANCHED:${oldRef}->${branched.ref} opened for a fresh report.` })
          try { await store.updateCase(fresh.id, { tags: mergeTag(fresh.tags, 'branched-from-lineage') }) } catch { /* best effort */ }
          fresh = branched
          // Replay the inbound onto the empty new case so the dropped facts (location,
          // how_to_find, ...) land on the FRESH report, then drive intake from there.
          justCaptured = await captureFieldsFromText(store, fresh.id, inboundText, log)
          fresh = await store.getCase(fresh.id)
          const bk = await bindPendingAsk(store, fresh.id, inboundText, justCaptured, log)
          if (bk) { justCaptured = [...justCaptured, bk]; fresh = await store.getCase(fresh.id) }
          if (justCaptured.length) { const w = await syncSummaryFromCaptured(store, fresh, log); if (w) fresh = await store.getCase(fresh.id) }
        } catch (e) { log.warn?.('[casey] fresh-report branch failed', { caseId: fresh.id, error: e.message }) }
      } else if (conflicts.length && !(fresh.tags || '').split(',').map(s => s.trim()).includes('needs-split')) {
        // INCOMPLETE conflicting case: flag for an operator to split (the old
        // behaviour) -- do not auto-branch a half-done report on a fuzzy signal.
        await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `NEW-CASE-SIGNAL: contact stated a different ${conflicts.join(' and ')} than the recorded report -- may be a new situation; flagged for an operator to split.` })
        try {
          await store.updateCase(fresh.id, { tags: mergeTag(fresh.tags, 'needs-split') })
          if (notifyHandoff) {
            try { await notifyHandoff({ case: fresh, channel, from: msg.from, reason: 'possible new case' }) }
            catch (e) { log.warn?.('[casey] new-case notify failed', { caseId: fresh.id, error: e.message }) }
          }
        } catch (e) { log.warn?.('[casey] needs-split flag failed', { caseId: fresh.id, error: e.message }) }
        fresh = await store.getCase(fresh.id)
      }
    }

    // Deterministic intent shortcuts. For a few universal intents a low-literacy
    // contact is likely to send, a fixed, correct reply beats a generated one --
    // so we answer without an LLM turn. This runs only when auto-responding and
    // not in observe mode (handled above). Empty/media messages normalize to no
    // intent and fall through to the agent turn unchanged.
    const isFirstMessage = (await store.listEvents(fresh.id)).filter(e => e.kind === 'inbound').length <= 1
    const optedOut = (fresh.tags || '').split(',').map(s => s.trim()).includes('opted-out')
    let intent = detectContactIntent(inboundText)
    // STATUS-BY-REF: a worker naming a case ref ("status of CASE-1089-dgpgd",
    // "how is CASE-1089 going", bare "CASE-1089?") -- or asking after their own
    // report with the active-case binding -- gets THAT case's plain status. Gated so a
    // ref mentioned INSIDE a report ("2 cows died, see CASE-1042") never hijacks
    // intake: only when the message is not report-shaped (the intent classifier reads
    // it as a question/enquiry/chitchat, not a report) AND a ref resolves. PII-free:
    // ref + plain status sentence only, never external_id/phone.
    {
      const namesRef = REF_STATUS_RE.test(inboundText || '')
      // Block only on a GENUINE report (animal/symptom content), not the classifier's
      // catch-all report default -- "status of CASE-1089" names no animal and must
      // look up the status, while "CASE-1089 my cow is sick" is intake.
      const reportShaped = REPORT_SHAPED_RE.test(inboundText || '')
      if (namesRef && !reportShaped) {
        const target = await resolveRefForStatus(store, inboundText)
        if (target) {
          const text = intentReply('status', target, guessLang(inboundText))
          await store.appendEvent(target.id, { kind: 'outbound', actor: 'system', channel, text, data: { to: replyTo, intent: 'status-by-ref' } })
          const reply = { to: replyTo, text, platform, caseId: target.id, intent: 'status-by-ref' }
          if (adapter?.send) {
            try { await adapter.send(reply) }
            catch (e) { log.error?.('[casey] adapter.send failed', { caseId: target.id, platform, error: e.message }); await store.appendEvent(target.id, { kind: 'observation', actor: 'system', text: `send failed on ${channel}: ${e.message}` }) }
          }
          return reply
        }
        // A ref that does not resolve (unknown/garbled) and no other intent: a warm
        // non-dead-end line, never another case's status, never the complete exit.
        if (!intent) {
          const text = `I could not find that reference. If you can, send the full reference like CASE-1234-ab, or tell me about the animal and I will help.` + refTail(inboundText, fresh)
          await store.appendEvent(fresh.id, { kind: 'outbound', actor: 'system', channel, text, data: { to: replyTo, intent: 'status-noref' } })
          const reply = { to: replyTo, text, platform, caseId: fresh.id, intent: 'status-noref' }
          if (adapter?.send) { try { await adapter.send(reply) } catch (e) { log.error?.('[casey] adapter.send failed', { caseId: fresh.id, platform, error: e.message }) } }
          return reply
        }
      }
    }
    // On a brand-new contact, greeting/help deserve the agent's warm intro +
    // reference, not a canned line -- so defer them to the agent on message one.
    // (status/human/stop/thanks still answered deterministically.)
    if (['help', 'greeting'].includes(intent) && isFirstMessage) intent = null
    // ALSO defer a LATER greeting on a still-incomplete case: a canned re-greeting
    // on every "hi" stalls the intake (the witnessed "blue eyes" -> greeting loop).
    // While visit-critical facts are still missing, let the agent (and the per-field
    // fallback) keep advancing rather than re-greeting. Once the report is
    // visit-ready, a later greeting is answered deterministically again. HELP is
    // EXCLUDED: the HELP keyword must always short-circuit to its menu instantly
    // (fixed-keyword invariant) -- only a bare greeting defers.
    if (intent === 'greeting' && reportMissingVisitCritical(fresh.report)) intent = null
    // One-shot closing capture: a "thanks" is usually the farmer wrapping up, and
    // after this they leave the site and are hard to reach. If a visit-critical
    // on-site fact is still missing AND we have not already made one closing ask,
    // do NOT take the canned thanks-shortcut -- defer to the agent so it can ask
    // for the single most important missing fact, once, before they go. Once we
    // have asked (closing-nudged tag) or the report is visit-ready, thanks is
    // answered deterministically as before (no nagging, never block a goodbye).
    if (intent === 'thanks' && !optedOut && isWrapUpThanks(inboundText)) {
      // "already nudged" is tracked via a durable observation marker, NOT a tag --
      // the agent's own case_update can rewrite tags mid-turn and would clobber a
      // tag set here. The observation is append-only, so the once-only guarantee
      // holds regardless of what the agent does to the case fields.
      const prior = await store.listEvents(fresh.id)
      const alreadyNudged = prior.some(e => e.kind === 'observation' && /CLOSING-NUDGE/.test(e.text || ''))
      if (!alreadyNudged && reportMissingVisitCritical(fresh.report)) {
        await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'CLOSING-NUDGE: deferred a closing thanks to gather one missing on-site fact (one-shot).' })
        intent = null   // let the agent turn run the gentle one-shot ask
      }
    }
    // Respect a prior opt-out: once someone said STOP, do not auto-reply again
    // unless they explicitly ask for help or a human.
    if (optedOut && intent !== 'help' && intent !== 'human') {
      await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'contact previously opted out; no auto-reply' })
      return { to: replyTo, text: '', platform, caseId: fresh.id, optedOut: true }
    }
    if (intent) {
      if (intent === 'human') {
        await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'HANDOFF REQUESTED: contact asked for a human. Needs an operator.' })
        // detectContactIntent returns 'human' for EVERY message with a human
        // keyword, so the notify must fire only on the FIRST handoff for this
        // case -- otherwise a contact repeating "person?" re-pings every time.
        // mergeTag is idempotent; the notify is not.
        const alreadyFlagged = (fresh.tags || '').split(',').map(s => s.trim()).includes('needs-human')
        try {
          // Flag needs-human as an OBSERVABLE signal; do NOT auto-raise priority.
          // casey amplifies the organisers' intent, it does not impose escalation
          // -- the operator decides urgency. The tag surfaces the request in the
          // triage inbox; priority stays where the people set it.
          const patch = { tags: mergeTag(fresh.tags, 'needs-human') }
          await store.updateCase(fresh.id, patch)
          if (notifyHandoff && !alreadyFlagged) {
            try { await notifyHandoff({ case: fresh, channel, from: msg.from }) }
            catch (e) { log.warn?.('[casey] handoff notify failed', { caseId: fresh.id, error: e.message }) }
          }
        } catch (e) { log.warn?.('[casey] handoff flag failed', { caseId: fresh.id, error: e.message }) }
      } else if (intent === 'stop') {
        await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'OPT-OUT: contact asked to stop messaging.' })
        try { await store.updateCase(fresh.id, { tags: mergeTag(fresh.tags, 'opted-out') }) }
        catch (e) { log.warn?.('[casey] opt-out flag failed', { caseId: fresh.id, error: e.message }) }
      }
      const text = intentReply(intent, fresh, guessLang(inboundText))
      await store.appendEvent(fresh.id, {
        kind: 'outbound', actor: 'system', channel,
        text, data: { to: replyTo, intent, deterministic: true },
      })
      // Reply target is external_id (the conversation key), NOT msg.from. On
      // Discord, freddie's adapter POSTs to /channels/{to}/messages, so `to` must
      // be the channel id (conversationKey), not the author id -- sending to the
      // author id silently fails (Discord 404, swallowed by .then(json)) and the
      // contact never sees a reply. external_id is correct for WhatsApp too, where
      // conversationKey falls back to msg.from (the phone number).
      const reply = { to: replyTo, text, platform, caseId: fresh.id, intent }
      if (adapter?.send) {
        try { await adapter.send(reply) }
        catch (e) {
          log.error?.('[casey] adapter.send failed', { caseId: fresh.id, platform, error: e.message })
          await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `send failed on ${channel}: ${e.message}` })
        }
      }
      return reply
    }

    // SOFT-STATE intent route. casey no longer hard-routes by keyword lists (the
    // whack-a-mole that let "whats the nearest case to margate" fall through to the
    // complete-report exit). Instead the message is INTERPRETED into a structured
    // intent and the conversation FSM (adaptogen, soft enforcement) decides the route:
    // an enquiry is answered from the PII-free surface, a general question is answered
    // (never closed out), and a report/chitchat falls through to the agent turn. The
    // soft transition means a question or enquiry from a "complete" case moves freely
    // out of that state -- the dead-end is structurally impossible.
    //
    // The interpreter is the in-loop agent model when it declares a case_intent; here
    // at the pre-turn gate we use the deterministic SOFT fallback (a small shape
    // classifier, not a phrase maze) so a weak model that declares nothing still
    // routes. The report-content veto inside the classifier keeps a real report
    // ("my cattle are sick", "2 cows died today") from ever being read as an enquiry.
    // Prefer a model DECLARATION (case_intent) recorded since the last inbound was
    // routed, over the deterministic fallback: a capable model that read the message
    // wins; a weak model that declared nothing falls back to the shape classifier.
    // We only consider a declaration newer than the most recent prior outbound (so a
    // stale declaration from an earlier message is not reused). The declaration is an
    // append-only observation written by the case_intent handler.
    const declared = await latestModelIntent(store, fresh.id)
    const turnIntent = declared || classifyIntentFallback(inboundText)
    const conv = await advanceConversation(turnIntent, { fsmFromState: reportMissingVisitCritical(fresh.report) ? 'gathering' : 'complete' })
    // Record the soft decision (intent + FSM trace) as an observation -- observable to
    // operators, never shown to the contact. This is the guardrail INFORMING, not
    // interfering.
    try {
      await store.appendEvent(fresh.id, {
        kind: 'observation', actor: 'system',
        text: `INTENT ${turnIntent.kind}${turnIntent.enquiry_kind ? '/' + turnIntent.enquiry_kind : ''} -> ${conv.route} (fsm ${conv.trace?.from || '?'}->${conv.trace?.to || '?'}${conv.trace?.degraded ? ', no-fsm' : ''}${conv.trace?.soft?.length ? ', soft:' + conv.trace.soft.join(',') : ''})`,
        data: { intent: turnIntent, route: conv.route, fsm: conv.trace },
      })
    } catch (e) { log.warn?.('[casey] intent observation failed', { caseId: fresh.id, error: e.message }) }
    // STATUS-OF-MINE: the worker asked the progress of THEIR report ("where are we at",
    // "any update", "did the vet come"). Answer with this case's plain status -- fresh
    // IS the per-contact active/most-recent case -- via intentReply, so the same
    // PII-free reply (a plain status sentence + ref, no external_id) the deterministic
    // STATUS keyword path gives. Never the generic question deflection.
    if (turnIntent.kind === 'status') {
      const text = intentReply('status', fresh, guessLang(inboundText))
      await store.appendEvent(fresh.id, { kind: 'outbound', actor: 'system', channel, text, data: { to: replyTo, intent: 'status', deterministic: true } })
      const reply = { to: replyTo, text, platform, caseId: fresh.id, intent: 'status' }
      if (adapter?.send) {
        try { await adapter.send(reply) }
        catch (e) { log.error?.('[casey] adapter.send failed', { caseId: fresh.id, platform, error: e.message }); await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `send failed on ${channel}: ${e.message}` }) }
      }
      return reply
    }
    // Enquiry and question routes answer here and return -- read-only, worker-facing,
    // safe in every autonomy mode (they do not mutate the case). author is the
    // per-author identity so a multi-author channel answers FOR the asking worker.
    // Chit-chat ("hi there") on a case that is NOT brand-new is handled
    // deterministically too -- otherwise it falls through to the agent turn, which on
    // a COMPLETE case empties and hits the completeReply dead-end (the witnessed
    // "hi there" -> "we have the full report ... CASE-1089"). warmConversationalReply
    // drives intake when visit-critical facts are still missing, and gives the warm
    // RE-OPENER (never the complete-report exit) when nothing is left to ask. A
    // first-message greeting on a brand-new empty case is LEFT to the agent turn (its
    // warm intro + reference is better than a canned line), matching the existing
    // isFirstMessage deferral -- so we only short-circuit chit-chat once the case has
    // some history (not the very first turn).
    const chitchatDeterministic = conv.route === 'chitchat' && !isFirstMessage
    if (conv.route === 'enquiry' || conv.route === 'answer' || chitchatDeterministic) {
      const author = msg.from || external_id
      const text = conv.route === 'enquiry'
        ? await renderItinerary(store, turnIntent.enquiry_kind || 'today', author, inboundText, Date.now(), turnIntent.place || '', turnIntent.status || '')
        : conv.route === 'answer'
          ? answerQuestion(inboundText, fresh)
          : warmConversationalReply(inboundText, fresh, mostImportantMissingField(fresh.report))
      await store.appendEvent(fresh.id, {
        kind: 'outbound', actor: 'system', channel,
        text, data: { to: replyTo, route: conv.route, intent: turnIntent.kind },
      })
      const reply = { to: replyTo, text, platform, caseId: fresh.id, route: conv.route }
      if (adapter?.send) {
        try { await adapter.send(reply) }
        catch (e) {
          log.error?.('[casey] adapter.send failed', { caseId: fresh.id, platform, error: e.message })
          await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `send failed on ${channel}: ${e.message}` })
        }
      }
      return reply
    }

    const contact = fresh.contact_id ? await store.getContact(fresh.contact_id).catch(() => null) : null
    const events = await store.listEvents(fresh.id)
    const prompt = inboundText || (media ? `The contact sent ${media} with no text. Acknowledge and ask how you can help.` : 'The contact sent an empty message. Acknowledge politely.')

    // If we deferred a closing "thanks" because an unrecoverable on-site fact is
    // still missing, hand the agent an explicit one-shot directive so it reliably
    // makes the single gentle ask (rather than hoping it infers it). We name the
    // most important missing fact so the ask is concrete.
    const closingCapture = isWrapUpThanks(inboundText) && reportMissingVisitCritical(fresh.report)
      ? mostImportantMissingField(fresh.report)
      : null

    // LLM-DOWN QUEUE GATE. With no deterministic fallback classification, a message
    // that arrives while the backend is down cannot be understood now -- so QUEUE it
    // and re-drive when the provider recovers (drainQueuedTurns on the down->up edge).
    // The inbound is already recorded above; here we append a durable QUEUED-FOR-AGENT
    // marker (the queue), send exactly ONE warm holding ack, and return WITHOUT a
    // TURN-START (so the resume sweep does not also claim it). The ack is recorded as
    // an OBSERVATION, never an outbound -- an outbound would positionally "complete"
    // the queued turn and suppress the retry. Guarded once per msgId. STOP/HUMAN are
    // handled by the deterministic short-circuit ABOVE this gate, so an opt-out during
    // an outage still fires synchronously and is never queued.
    if (typeof llmStatus === 'function' && !msg.resume) {
      let down = false
      try { const st = await llmStatus(); down = st && st.ok === false } catch { down = false }
      if (down) {
        const already = events.some(e => e.kind === 'observation' && typeof e.text === 'string' && e.text === `QUEUED-FOR-AGENT:${msgId}`)
        if (!already) {
          try {
            await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `QUEUED-FOR-AGENT:${msgId}` })
            const holdText = fallbackReply(inboundText, fresh)
            await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `HOLDING-ACK-SENT:${msgId}` })
            const holdReply = { to: replyTo, text: holdText, platform, caseId: fresh.id, queued: true }
            if (adapter?.send) {
              try { await adapter.send(holdReply) }
              catch (e) { log.warn?.('[casey] holding-ack send failed', { caseId: fresh.id, error: e.message }) }
            }
            log.info?.('[casey] queued inbound (LLM down)', { caseId: fresh.id, msgId })
            return holdReply
          } catch (e) {
            log.warn?.('[casey] queue-gate append failed; falling through to live turn', { caseId: fresh.id, error: e.message })
          }
        } else {
          // Already queued this msgId (a duplicate delivery during the outage) -- do
          // not re-ack, just acknowledge receipt without a second holding line.
          return { to: replyTo, text: '', platform, caseId: fresh.id, queued: true, deduped: true }
        }
      }
    }

    // Per-contact concurrency gate: a second message from the same contact while
    // the first turn is still in the LLM is held off until next poll / retry.
    if (inFlight.has(external_id)) {
      log.info?.('[casey] skipping concurrent LLM turn', { caseId: fresh.id })
      await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'concurrent turn skipped: prior LLM turn still in-flight for this contact' })
      return { to: replyTo, text: '', platform, caseId: fresh.id, skipped: true }
    }
    inFlight.add(external_id)
    // Durable turn-lifecycle marker: record that an agent turn STARTED for this
    // inbound (keyed by msgId) as an append-only observation, BEFORE the LLM call.
    // If the process crashes/reloads between here and the outbound below, the boot
    // resume sweep (resumePendingTurns) finds an inbound with a TURN-START but no
    // following outbound/draft and re-drives it exactly once -- so a contact whose
    // message arrived mid-crash still gets a reply instead of waiting forever.
    // Completion is detected positionally (a later outbound/draft), so no separate
    // TURN-DONE marker is needed; the outbound IS the completion witness.
    try { await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `TURN-START:${msgId}` }) }
    catch (e) { log.warn?.('[casey] turn-start marker failed', { caseId: fresh.id, error: e.message }) }
    let result, errored = false
    try {
      result = await runTurn({
        prompt,
        messages: [{ role: 'system', content: caseSystemPrompt(fresh, events, contact, { closingCapture }) }],
        sessionKey: `case:${fresh.id}`,
        callLLM,
        enabledToolsets: ['cases', 'core'],
        // Identity for the case/enquiry tools: WHO is asking (the message author),
        // the live store, the role for row-scoped enquiries, and the active case.
        // The freddie case toolset reads these from toolCtx rather than a global, so
        // "my cases"/"near me"/"today" answer FOR this worker and writes target the
        // bound case. author = msg.from (the per-author identity); the channel author
        // is the worker (no login). principal feeds thatcher row-access scoping.
        toolCtx: {
          author: msg.from || external_id,
          channel,
          // The channel inbound is a WORKER (no login; the operator is the dashboard).
          // role:'worker' makes the freddie case tools return the PII-free enquiryRow
          // projection on reads (case_get/case_list) -- a worker asking status can
          // never be handed a case body carrying external_id/contact_id/phone. Only
          // the dashboard read path is role:'operator'.
          role: 'worker',
          store,
          principal: { id: msg.from || external_id, role: 'worker' },
          activeCaseRef: fresh.ref,
          activeCaseId: fresh.id,
          now: Date.now(),
        },
        // freddie's runTurn defaults to 30s, which is too tight for a COLD first
        // turn (host boot + first provider probe) against the real bridge -- the
        // crucible run timed out there and the contact got a degraded reply. The
        // lead providers answer in well under a second once warm, so this bound
        // protects the cold start without abandoning a live contact for minutes.
        // CASEY_LLM_TURN_TIMEOUT_MS overrides for slow links / dead-provider walks.
        timeoutMs: Number(process.env.CASEY_LLM_TURN_TIMEOUT_MS) || 120000,
      })
    } catch (e) {
      errored = true
      log.error?.('[casey] agent turn failed', { caseId: fresh.id, error: e.message })
      await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `agent turn error: ${e.message}` })
      result = {}
    } finally {
      inFlight.delete(external_id)
    }
    // Re-read the case after the agent turn: the agent may have completed intake via
    // case_report (or moved the stage) during the turn. Report-aware decisions below
    // -- the precedence gate, the fallback intake-advance, the jargon hold -- must see
    // what the agent just wrote, not the pre-turn snapshot. Without this, an agent
    // that completed intake this turn is still overridden by a deterministic intake
    // question, and a now-complete case never lets trusted model prose through.
    fresh = await store.getCase(fresh.id).catch(() => fresh)

    // Never send a raw error string or an empty message to the contact. On
    // error/empty, send a safe fallback and keep the case recoverable.
    let text = (result?.result || '').toString().trim()
    // Reject a reply that parrots the system-prompt example verbatim: record it
    // as a failed turn and fall through to the safe fallback rather than leak a
    // canned, robotic message to the contact.
    if (text && isPromptEcho(text)) {
      await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'model echoed prompt example; replaced with fallback' })
      text = ''
    }
    // The weak model recites the bare stock ack on later turns too (not just the
    // first-contact exemplar isPromptEcho catches). A reply that is substantively
    // only "thank you ... your reference is X" advances nothing -- treat it as a
    // failed turn so the degraded path below asks the one most-important missing
    // on-site fact instead of parroting an ack a third time.
    if (text && isStockAck(text)) {
      await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'model recited stock ack (no case-specific content); replaced with advancing fallback' })
      text = ''
    }
    // Set when the empty-model degraded branch has ALREADY produced the
    // deterministic capture-driven reply (and recorded its FALLBACK-ASK). The
    // precedence gate below must then NOT re-drive: a second drive re-reads the
    // event log, sees the just-written FALLBACK-ASK for field A, asks field B
    // instead, and overwrites the reply -- recording field A as asked-once while
    // its question is never delivered, burning the field forever.
    let droveIntake = false
    // The FALLBACK-ASK:<key> marker that records a field as asked-once MUST be
    // written only after the question is actually delivered. Recording it before
    // adapter.send means a transient send failure burns the field forever (the
    // once-per-field guard skips it next turn though the contact never received
    // it). So the intake branches set this pending key and the marker is appended
    // only after a confirmed-delivered outbound (and skipped in the send catch and
    // the assisted/jargon draft-hold early returns).
    let pendingFallbackAsk = null
    if (!text) {
      if (!errored && result?.error) {
        log.warn?.('[casey] agent returned error result', { caseId: fresh.id, error: result.error })
        await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `agent result error: ${result.error}` })
      }
      // Never a dead-end: when the model fails (error/timeout/empty/prompt-echo)
      // but the case still needs visit-critical facts, the holding ack is followed
      // by ONE gentle question -- for the next still-missing fact NOT yet asked via
      // this degraded path. This advances the intake field-by-field across turns
      // (where -> which animals -> signs -> ...) instead of asking one thing then
      // repeating a greeting forever (the witnessed "blue eyes" -> re-greeting loop).
      // Each asked field is recorded as a durable FALLBACK-ASK:<key> observation
      // (append-only, so the agent's own case_update cannot clobber the once-per-
      // field guarantee). Only once every visit-critical field has been asked once
      // does the degraded reply become the plain holding ack and the operator takes
      // over -- never a re-greet, never the same question twice.
      // Content-free turn (a bare greeting / "help" with nothing captured and an
      // empty report): memobot must still DRIVE collection -- a warm opener PLUS the
      // first needed fact (which animals / where), never a no-ask pleasantry and
      // never the "Thank you for letting us know ... reference X" case-ack. The
      // empty report means warmConversationalReply asks the most-important first
      // field, starting intake on turn one.
      if (isContentFreeTurn(justCaptured, fresh.report)) {
        // Pick the next field to ask, skipping any already asked, and DURABLY record
        // it (ASKED:<key>) so the next inbound is bound to it by the pending-ask
        // binder and the same field is never asked twice in a row.
        const gAsked = askedKeysFromEvents(await store.listEvents(fresh.id))
        const gNext = nextAsk(fresh.report, gAsked)
        await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'GREETING-DRIVE: greeting answered with a warm opener + the next needed fact, driving intake (not the case-ack, not a no-ask pleasantry).' })
        if (gNext) await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `ASKED:${gNext[0]} greeting-drive asked this field (once per field).` })
        text = warmConversationalReply(inboundText, fresh, gNext ? gNext[1] : null)
      } else {
      const askedKeys = askedKeysFromEvents(await store.listEvents(fresh.id))
      // The next still-missing, not-yet-asked field (visit-critical first, then
      // value-add). On a genuine wrap-up (closingCapture set), instead ask the single
      // MOST IMPORTANT still-missing fact -- the one-shot closing ask. Either way the
      // chosen field is recorded once (FALLBACK-ASK) so it is never re-asked and the
      // next inbound binds to it.
      let next = nextAsk(fresh.report, askedKeys)
      if (closingCapture != null) {
        const mostKey = VISIT_CRITICAL_ASK.find(([, hint]) => hint === closingCapture)
        if (mostKey && !askedKeys.has(mostKey[0])) next = mostKey
      }
      // Capture-driven: lead with an acknowledgement of what the contact just told
      // us this turn (so 'I see blue eyes' is heard, not swallowed into a generic
      // ack), then ask the next still-missing fact. When nothing new was captured and
      // nothing is left to ask, this is a brief warm confirming line.
      const advancing = captureDrivenReply(inboundText, fresh, justCaptured, next ? next[1] : null)
      if (next) pendingFallbackAsk = { key: next[0], via: 'degraded reply' }
      text = advancing
      droveIntake = true
      }
    }
    // PRECEDENCE GATE (the live fix): while visit-critical intake is INCOMPLETE,
    // the deterministic capture-driven reply REPLACES the model output -- even when
    // the model produced non-empty prose. The production model is small: it never
    // calls case_report (so it captures nothing) and returns plausible chatter that
    // ignores the contact's plainly-stated facts and carries no reference. That
    // chatter passes the echo/stock-ack guards above (it is neither), so without
    // this gate it would be sent raw -- the witnessed dead-end where 'I see blue
    // eyes' is met with a generic greeting that never acknowledges the symptom,
    // never asks the next on-site fact, and never quotes the ref. So: until the
    // case has the facts a visit needs, intake is driven deterministically and the
    // model output is treated as decorative. Once intake is complete, model prose
    // is trusted (the guards above still apply). The override is an observable,
    // audited branch; the once-per-field FALLBACK-ASK guard still prevents repeats.
    // A content-free conversational turn is exempt: there is no report to drive,
    // and the warm reply above must not be overridden by a holding ack. The gate
    // only applies once the contact has actually started a report (a captured
    // field this turn or an existing report field), which isContentFreeTurn guards.
    // !droveIntake: when the empty-model branch already produced the deterministic
    // capture-driven reply this turn, re-driving here would clobber the asked field
    // (see droveIntake note above). The gate's job is only to override non-empty
    // MODEL prose during incomplete intake; it has nothing to override when the
    // degraded branch already drove intake.
    // closingTurn: a genuine wrap-up where the model was given the closingCapture
    // directive (warm thanks + the single most-important ask). The gate must NOT
    // override that warm reply with the holding-ack parrot -- the whole point of
    // the closing nudge is a kind goodbye plus one gentle ask, which the model
    // composed. The echo/stock-ack/jargon guards above still blank a genuinely
    // degraded closing reply and route it to the !text branch, so a closing turn
    // is never a dead-end.
    const closingTurn = closingCapture != null
    if (reportMissingVisitCritical(fresh.report) && !isContentFreeTurn(justCaptured, fresh.report) && !droveIntake && !closingTurn) {
      const askedKeys = askedKeysFromEvents(await store.listEvents(fresh.id))
      const next = nextAsk(fresh.report, askedKeys)
      // Only override the model when the deterministic path has something to add:
      // a next field to ask OR a freshly-captured fact to acknowledge. Once every
      // askable field is exhausted (next is null) AND nothing was captured this
      // turn, the capture-driven reply would just be the bare stock holding-ack --
      // strictly worse than the model's contextual (already echo/stock-ack/jargon-
      // guarded) prose, and a repeating content-free dead-end if forced every turn.
      // Three of the six VISIT_CRITICAL fields are never deterministically
      // extractable, so reportMissingVisitCritical stays true for the life of a
      // content-only conversation; without this guard the gate would parrot the
      // holding ack forever.
      if (next || justCaptured.length) {
        const driven = captureDrivenReply(inboundText, fresh, justCaptured, next ? next[1] : null)
        if (driven && driven !== text) {
          await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'INTAKE-DRIVE: deterministic capture-driven reply used over model output (intake incomplete).' })
          if (next) pendingFallbackAsk = { key: next[0], via: 'intake-drive' }
          text = driven
        }
      }
    }
    // A reply is a (degraded) fallback if it is empty, begins with the holding ack
    // base, or CONTAINS it -- the capture-driven reply leads with an acknowledgement
    // clause before the holding ack, so a plain startsWith would miss it. includes()
    // covers the plain ack, every per-field advancing variant, and the ack-prefixed
    // capture-driven reply.
    const fallbackBase = fallbackReply(inboundText, fresh)
    const isFallback = !text || text === fallbackBase || text.startsWith(fallbackBase) || text.includes(fallbackBase)

    // TOTAL ASKED-MARKER: when the MODEL's own prose carries the turn (non-fallback,
    // not overridden by the deterministic intake-drive) and the report still wants a
    // visit-critical fact, record which field the next turn should expect an answer
    // for. Without this, a model-prompted "where are the animals?" leaves NO ASKED
    // marker, so the worker's next free-text answer ("a small holding near amapondos")
    // has no pending key to bind to and the field is re-asked. The marker names the
    // deterministic most-wanted field (not necessarily the exact field the prose
    // asked); a bounded one-field divergence self-corrects next turn. Stamped only
    // after a confirmed-delivered reply (the existing FALLBACK-ASK writer below), so a
    // send failure never burns the field. Guarded so the gate/degraded paths (which
    // already set pendingFallbackAsk) are never double-stamped.
    if (!pendingFallbackAsk && !isFallback && reportMissingVisitCritical(fresh.report)
        && !isContentFreeTurn(justCaptured, fresh.report) && !droveIntake && !closingTurn) {
      const mAsked = askedKeysFromEvents(await store.listEvents(fresh.id))
      const mNext = nextAsk(fresh.report, mAsked)
      if (mNext) pendingFallbackAsk = { key: mNext[0], via: 'model-prompted' }
    }

    // Final guard before the reply leaves (send OR assisted draft): correct any
    // fabricated/stale case reference to this case's real ref. A weak model recites
    // a memorized stock reply carrying the wrong ref; the contact must never be
    // handed a reference that does not resolve to their case.
    {
      const { text: safeText, corrected } = sanitizeOutboundRef(text, fresh.ref)
      if (corrected.length) {
        text = safeText
        await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `REF-CORRECTED: model emitted ${corrected.join(', ')}; rewrote to real ref ${fresh.ref}.` })
      }
    }

    // PRE-SEND JARGON GUARD: if the composed reply leaked internal jargon
    // (case/triage/workflow/status/priority as whole words), do NOT send it. Hold
    // it as a draft for a human exactly like assisted mode -- the contact must never
    // receive a jargon-laden reply, and a person rewrites it plainly. This fires in
    // ANY autonomy mode (the leak is a content defect, not a mode choice) and runs
    // before the assisted-mode branch so a jargon hit holds even in auto mode. The
    // offending words are recorded as an observation for the operator. Reuses the
    // assisted draft-hold mechanics (draft event + draft-pending + needs-human +
    // notify-once).
    const jHits = jargonHits(text)
    if (jHits.length) {
      await store.appendEvent(fresh.id, {
        kind: 'observation', actor: 'system',
        text: `JARGON-HELD: reply withheld -- contained internal jargon (${jHits.join(', ')}); held for a human to reword plainly.`,
      })
      await store.appendEvent(fresh.id, {
        kind: 'draft', actor: 'agent', channel,
        text, data: { to: replyTo, fallback: isFallback, draft: true, jargon: jHits },
      })
      const alreadyFlagged = (fresh.tags || '').split(',').map(s => s.trim()).includes('needs-human')
      try {
        await store.updateCase(fresh.id, { tags: mergeTag(mergeTag(fresh.tags, 'draft-pending'), 'needs-human') })
        if (notifyHandoff && !alreadyFlagged) {
          try { await notifyHandoff({ case: fresh, channel, from: msg.from }) }
          catch (e) { log.warn?.('[casey] jargon-held notify failed', { caseId: fresh.id, error: e.message }) }
        }
      } catch (e) { log.warn?.('[casey] jargon-held flag failed', { caseId: fresh.id, error: e.message }) }
      return { to: replyTo, text: '', platform, caseId: fresh.id, drafted: true, jargonHeld: jHits }
    }

    // ASSISTED mode: the agent composed a reply, but a human must approve before
    // anything reaches the contact. Hold it as a draft event (never sent), flag
    // the case for an operator, and notify once -- mirroring the human-handoff
    // path. The dashboard surfaces the draft for one-click approve/discard.
    if (canAgentAct(fresh, 'reply') === 'draft') {
      await store.appendEvent(fresh.id, {
        kind: 'draft', actor: 'agent', channel,
        text, data: { to: replyTo, fallback: isFallback, draft: true },
      })
      const alreadyFlagged = (fresh.tags || '').split(',').map(s => s.trim()).includes('needs-human')
      try {
        await store.updateCase(fresh.id, { tags: mergeTag(mergeTag(fresh.tags, 'draft-pending'), 'needs-human') })
        if (notifyHandoff && !alreadyFlagged) {
          try { await notifyHandoff({ case: fresh, channel, from: msg.from }) }
          catch (e) { log.warn?.('[casey] assisted draft notify failed', { caseId: fresh.id, error: e.message }) }
        }
      } catch (e) { log.warn?.('[casey] assisted draft flag failed', { caseId: fresh.id, error: e.message }) }
      // Nothing is sent in assisted mode -- return empty text so the gateway sends
      // nothing and the contact waits on a human-approved reply.
      return { to: replyTo, text: '', platform, caseId: fresh.id, drafted: true }
    }

    // Deterministic intake advance: a substantive inbound on a brand-new case
    // means the case is observably past "new" -- a real report has landed and a
    // reply is going out. The agent turn is SUPPOSED to call case_transition, but
    // the production model is content-only (it rarely emits tool calls) and even
    // the stub can leave the move uncommitted, so relying on the LLM makes the
    // first stage change flaky. We move new->triaging here, deterministically,
    // BEFORE recording the outbound. It is a no-op if the agent already moved the
    // case (transition() returns early on an equal stage) and is skipped for the
    // content-free social/empty turns (those never reach a substantive reply with
    // a recorded report). Best-effort: a transition failure must never block the
    // reply. Observe mode returned far above, so acting here is always permitted.
    {
      const latest = await store.getCase(fresh.id).catch(() => fresh)
      if (latest && latest.status === 'new' && (inboundText || media)) {
        try { await store.transition(fresh.id, 'triaging', { reason: 'first report received (auto)' }) }
        catch (e) { log.warn?.('[casey] intake auto-transition failed', { caseId: fresh.id, error: e.message }) }
      }
    }

    // AI-offline queue: when the agent turn ITSELF failed (model error/timeout, or
    // the store/host threw) the contact still got a safe degraded reply above, but a
    // human should verify it was adequate -- the model could not reason about this
    // case. Tag the case 'ai-offline' so it surfaces in the operator's offline queue
    // (GET /api/unreplied) and on the case list. The next operator reply clears it
    // (claim-on-reply untags it), and a later successful agent turn does too. The tag
    // is set only on a genuine turn failure, never on a normal fallback (an empty/
    // media-only social turn is not a model outage). Best-effort: a tag failure must
    // never block the reply.
    if (errored) {
      try { await store.updateCase(fresh.id, { tags: mergeTag(fresh.tags, 'ai-offline') }) }
      catch (e) { log.warn?.('[casey] ai-offline tag failed', { caseId: fresh.id, error: e.message }) }
    } else if ((fresh.tags || '').split(',').map(s => s.trim()).includes('ai-offline')) {
      // A successful turn clears a stale offline flag from a prior failed turn.
      try { await store.updateCase(fresh.id, { tags: dropTag(fresh.tags, 'ai-offline') }) }
      catch (e) { log.warn?.('[casey] ai-offline clear failed', { caseId: fresh.id, error: e.message }) }
    }

    await store.appendEvent(fresh.id, {
      kind: 'outbound', actor: 'agent', channel,
      text, data: { to: replyTo, fallback: isFallback },
    })

    // Reply target is external_id (conversationKey), NOT msg.from -- see the note
    // at the deterministic-intent reply above. On Discord, freddie POSTs to
    // /channels/{to}/messages, so `to` must be the channel id; on WhatsApp,
    // conversationKey falls back to the phone number. msg.from (author id) silently
    // 404s on Discord and the contact never sees the reply.
    const reply = { to: replyTo, text, platform, caseId: fresh.id }
    let delivered = true
    if (adapter?.send) {
      try { await adapter.send(reply) }
      catch (e) {
        delivered = false
        log.error?.('[casey] adapter.send failed', { caseId: fresh.id, platform, error: e.message })
        await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `send failed on ${channel}: ${e.message}` })
      }
    }
    // Record the once-per-field marker ONLY now that the question was actually
    // delivered. A transient send failure leaves the field unmarked so it is
    // re-asked next turn rather than silently burned. Best-effort: a marker append
    // failure must never mask the reply that already went out.
    if (delivered && pendingFallbackAsk) {
      try {
        await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `FALLBACK-ASK:${pendingFallbackAsk.key} ${pendingFallbackAsk.via} asked the next still-missing on-site fact (once per field).` })
      } catch (e) { log.warn?.('[casey] FALLBACK-ASK marker append failed', { caseId: fresh.id, error: e.message }) }
    }
    return reply
  }
}

// The conversation/case IDENTITY -- per CONTACT, not per channel. A Discord server
// channel carries many authors; keying on the channel alone made everyone in it
// share ONE case (a second worker's "hello" landed on the first worker's case). So
// when the container (channel/chat) and the author differ -- a multi-person channel
// -- the key is "container:author". A 1:1 chat (WhatsApp, where the chat id IS the
// person, or there is no separate container) stays the single id. This is identity
// only; the reply DELIVERY target is replyTarget() below (the channel), because
// Discord posts to the channel, not the author.
export function conversationKey(msg) {
  const container = msg.raw?.channel_id || msg.raw?.chatId || msg.chatId || ''
  const author = msg.from || ''
  if (container && author && container !== author) return `${container}:${author}`
  return container || author || 'unknown'
}

// Where a reply is DELIVERED: the channel/chat container (Discord posts to
// /channels/{channel}/messages; an author id 404s). Falls back to the sender for a
// 1:1 chat. Distinct from conversationKey, which is the per-contact case identity.
export function replyTarget(msg) {
  return msg.raw?.channel_id || msg.raw?.chatId || msg.chatId || msg.from || 'unknown'
}

// Platform message id for dedup: Discord/WhatsApp put it on raw.id; fall back to
// an explicit msg.id.
function messageId(msg) {
  return msg.raw?.id || msg.id || ''
}

// Short description of any non-text content so media-only messages are not lost.
function describeMedia(msg) {
  const r = msg.raw || {}
  if (Array.isArray(r.attachments) && r.attachments.length) return `${r.attachments.length} attachment(s)`
  if (r.type && r.type !== 'text') return `${/^[aeiou]/i.test(r.type) ? 'an' : 'a'} ${r.type} message`
  if (r.image) return 'an image'
  if (r.audio) return 'an audio message'
  if (r.sticker_items) return 'a sticker'
  return ''
}

// A photo of a sick or dead animal is the single most valuable on-site artifact,
// and on the one-shot path it cannot be recovered once the worker leaves. So a
// received image is recorded as explicit case state (report.photos) at ingress,
// deterministically -- never left to the agent turn to notice and record, which
// it may not on a media-only message. Returns a short note when THIS message
// carries a real image (not a sticker, not audio, not a generic attachment of
// unknown type), else ''. WhatsApp/Twilio surface images as raw.image, type
// 'image', or attachments with an image/* content type; we match all three.
function inboundImageNote(msg) {
  const r = msg.raw || {}
  if (r.image || r.type === 'image') return 'farmer sent a photo'
  const atts = Array.isArray(r.attachments) ? r.attachments : []
  const imgs = atts.filter(a => typeof (a?.content_type || a?.contentType || a?.mimetype) === 'string'
    && /^image\//i.test(a.content_type || a.contentType || a.mimetype))
  if (imgs.length) return imgs.length === 1 ? 'farmer sent a photo' : `farmer sent ${imgs.length} photos`
  return ''
}

// A voice note is, for a low-literacy farmer, often the MAIN report -- they speak
// rather than type. Like the photo, it is one-shot and easy to lose if it is only
// described into the agent's context and never recorded as explicit case state.
// So we capture it the same way: detect a real audio/voice message (not a sticker,
// not an image) and record a note at ingress, fill-if-empty. casey does not
// transcribe here (no heavy dependency, P2); the operator listens and can fill the
// richer detail -- an honest degradation rung, not a silent drop. Returns '' when
// THIS message carries no audio.
function inboundAudioNote(msg) {
  const r = msg.raw || {}
  if (r.audio || r.voice || r.type === 'audio' || r.type === 'voice') return 'farmer sent a voice note (listen and record what it says)'
  const atts = Array.isArray(r.attachments) ? r.attachments : []
  const auds = atts.filter(a => typeof (a?.content_type || a?.contentType || a?.mimetype) === 'string'
    && /^audio\//i.test(a.content_type || a.contentType || a.mimetype))
  if (auds.length) return 'farmer sent a voice note (listen and record what it says)'
  return ''
}

function truncate(s, n) { s = s || ''; return s.length > n ? s.slice(0, n - 1) + '...' : s }

// Returns true when at least one visit-critical fact is still absent -- the
// signal to let the agent make a single gentle closing ask instead of taking
// the canned thanks-shortcut. Tolerates a missing/malformed report.
// VISIT_CRITICAL is imported from case-health.js (canonical source).
function parseReportSafe(raw) {
  try { return raw ? JSON.parse(raw) : {} } catch { return {} }
}

export function reportMissingVisitCritical(reportRaw) {
  const r = parseReportSafe(reportRaw)
  return VISIT_CRITICAL.some(k => r[k] == null || String(r[k]).trim() === '')
}

// The single most important still-missing on-site fact, in priority order, with a
// plain-language hint the agent can ask about. The reporter is usually a field
// worker relaying a farmer's animals they are standing with, so the hints ask what
// the worker can SEE or RELAY -- never assuming they own or witnessed the animals.
// Worker-observable facts lead (where, which animals, the signs, how to find the
// place); the people facts (who is there, how to reach the owner) follow.
const VISIT_CRITICAL_ASK = [
  ['location', 'where the animals are (the farm, nearest town, or area)'],
  ['species', 'which animals are affected'],
  ['symptoms', 'what can be seen in the animals'],
  ['how_to_find', 'how to find the place (a road, landmark, or directions)'],
  ['farmer_available', 'whether the owner or someone is there at the animals'],
  ['contact_fallback', 'a number to reach the owner or the person there'],
]
function mostImportantMissingField(reportRaw) {
  const r = parseReportSafe(reportRaw)
  const hit = VISIT_CRITICAL_ASK.find(([k]) => r[k] == null || String(r[k]).trim() === '')
  return hit ? hit[1] : null
}

// Plain contact-facing label for a captured field, used to acknowledge what the
// contact just told us IN THE REPLY -- never internal jargon, never the raw value
// (the value is the contact's own words, already on the record; we only name the
// KIND of thing understood, so a re-render is always HTML-safe and PII-light).
const CAPTURED_ACK = {
  species: 'which animals',
  symptoms: 'what can be seen',
  location: 'where the animals are',
  dead_count: 'that some have died',
  affected_count: 'how many are affected',
  onset: 'how long it has been',
  how_to_find: 'how to find the place',
  suspected_disease: 'what it may be',
  present_person: 'who is there with the animals',
  owner_contact: 'how to reach the owner',
}
// Build a short warm clause acknowledging the most important field we just
// captured this turn (priority-ordered so we confirm the most useful fact, not a
// random one). Returns '' when nothing notable was captured. Deterministic: this
// is what makes 'I see blue eyes' come back as 'Thank you -- I have noted what you
// are seeing' instead of vanishing into a generic ack.
function ackCapturedFields(justFilled) {
  if (!Array.isArray(justFilled) || !justFilled.length) return ''
  const order = ['location', 'species', 'symptoms', 'dead_count', 'affected_count', 'onset', 'how_to_find', 'suspected_disease']
  const pick = order.find(k => justFilled.includes(k)) || justFilled.find(k => CAPTURED_ACK[k])
  const label = pick && CAPTURED_ACK[pick]
  return label ? `Thank you -- I have noted ${label}.` : ''
}

// Operator-facing one-line summary projected from the deterministically-captured
// report fields. The weak model returns no tool_calls (so it never sets a subject
// or summary), which left an operator staring at '(none yet)' on a real report --
// this synthesises a short scannable picture from what the contact plainly stated
// so the inbox shows the animals, the signs, how many, and where, even on a fully
// model-degraded conversation. Plain words only (no internal jargon); the captured
// VALUES are the contact's own text and are HTML-escaped at render like all contact
// text. Returns '' when nothing useful is captured yet (caller then writes nothing).
function summaryFromReport(reportRaw) {
  const r = parseReportSafe(reportRaw)
  const val = k => (r[k] == null ? '' : String(r[k]).trim())
  const parts = []
  const species = val('species')
  const symptoms = val('symptoms')
  const dead = val('dead_count')
  const affected = val('affected_count')
  const location = val('location')
  const onset = val('onset')
  // Lead with the animals + what is wrong: "cattle, blue eye" / "sheep, sick".
  const head = [species, symptoms].filter(Boolean).join(', ')
  if (head) parts.push(head)
  else if (symptoms) parts.push(symptoms)
  if (dead) parts.push(`${dead} dead`)
  if (affected && !dead) parts.push(`${affected} affected`)
  if (location) parts.push(`at ${location}`)
  if (onset) parts.push(`since ${onset}`)
  return parts.join(' - ')
}

// A short subject (title) from the same projection: animals + sign, or the sign
// alone, capped so the inbox row stays scannable. Returns '' when nothing yet.
function subjectFromReport(reportRaw) {
  const r = parseReportSafe(reportRaw)
  const val = k => (r[k] == null ? '' : String(r[k]).trim())
  const species = val('species')
  const symptoms = val('symptoms')
  const title = [species, symptoms].filter(Boolean).join(' - ') || symptoms || val('location')
  return title ? truncate(title, 60) : ''
}

// Keep subject/summary populated from captured fields WITHOUT ever clobbering a
// model- or human-authored value. A summary set by the agent (case_update) or an
// operator is real working memory; we only fill the gap when the field is still
// empty or the default placeholder. Quiet update (does not touch last_event_at):
// this is a derived projection of facts already recorded this turn, not new
// contact activity. Returns true when it wrote something.
async function syncSummaryFromCaptured(store, caseRow, log) {
  try {
    const isBlank = v => v == null || String(v).trim() === '' || String(v).trim() === '(none yet)'
    const patch = {}
    if (isBlank(caseRow.summary)) {
      const s = summaryFromReport(caseRow.report)
      if (s) patch.summary = s
    }
    if (isBlank(caseRow.subject)) {
      const sub = subjectFromReport(caseRow.report)
      if (sub) patch.subject = sub
    }
    if (!Object.keys(patch).length) return false
    await store.updateCaseQuiet(caseRow.id, patch)
    // Field KEYS only -- never the raw captured values (contact PII) in the log line.
    await store.appendEvent(caseRow.id, { kind: 'observation', actor: 'system', touch: false, text: `summary auto-filled from captured fields: ${Object.keys(patch).join(', ')}` })
    return true
  } catch (e) { log?.warn?.('[casey] summary auto-fill failed', { caseId: caseRow.id, error: e.message }); return false }
}

// The full deterministic capture-driven reply: acknowledge what was just captured,
// then ask the single most-important still-missing on-site fact, carrying the
// reference once. This is the reply we send when the model produces nothing usable
// (empty/error/echo/stock-ack -- the common case on the weak local model), so the
// contact is always heard and the intake always advances by one real field.
function captureDrivenReply(contactText, caseRow, justFilled, nextHint) {
  // Drive collection: lead with the just-captured-fact acknowledgement (or a brief
  // warm opener when nothing was captured this turn), then ask the next needed
  // fact, then the reference. Never the "Thank you for letting us know ... we have
  // your message" holding-ack preamble -- that read as a dead-end case-ack even
  // with an ask appended (the witnessed "@memobot hi -> Thank you for letting us
  // know ..." on an existing case). When nothing is left to ask (nextHint null),
  // this is a brief warm confirming line, not the holding-ack.
  return intakeAdvanceReply(contactText, caseRow, justFilled, nextHint)
}

// Per-field advancing: the highest-priority on-site fact that is BOTH still
// missing AND not already asked once via the degraded fallback (askedKeys). This
// is what makes the degraded path advance field-by-field across turns instead of
// asking the same thing then repeating a greeting -- each degraded turn moves to
// the next genuinely-missing field. Returns [key, hint] or null when every
// visit-critical field is either filled or already asked once.
function nextUnaskedMissingField(reportRaw, askedKeys) {
  const r = parseReportSafe(reportRaw)
  const hit = VISIT_CRITICAL_ASK.find(([k]) =>
    (r[k] == null || String(r[k]).trim() === '') && !askedKeys.has(k))
  return hit || null
}

// Holding ack + one gentle question for a specific missing fact's hint. The
// per-field counterpart to advancingFallback (which always asks the single most
// important). Caller picks the field via nextUnaskedMissingField.
export function advancingFallbackForHint(contactText, caseRow, hint) {
  const base = fallbackReply(contactText, caseRow)
  if (!hint) return base
  return `${base} ${askCarrier(guessLang(contactText), hint)}`
}

// Contact intent detection -- low-literacy / multilingual handlers
//
// Low-literacy / multilingual contacts often send one word, an emoji, or a
// phrase in their own language. Before spending an LLM turn we check for a few
// universal intents and answer deterministically where a fixed, correct reply
// beats a generated one. Matching is forgiving: lowercased, accent-stripped,
// substring/keyword across several widely-spoken languages.
//
// Returns 'help' | 'status' | 'human' | 'stop' | null. Order matters: STOP and
// HUMAN win over STATUS/HELP when more than one could match.
export function detectContactIntent(text) {
  const t = normalizeIntentText(text)
  if (!t) return null
  const words = t.split(' ')
  const wordSet = new Set(words)
  const padded = ` ${t} `

  // Forgiving match for the READ-ONLY intents (status/help/thanks/greeting):
  // a whole-word/phrase hit, OR a key that appears as a substring of a token so
  // inflected forms still match ("ayuda" inside "ayudame", "thank" inside
  // "thanks"). Safe here because these intents never mutate the case; the
  // irreversible STOP/HUMAN use the strict negation-guarded matcher below.
  // Very short keys (<=3 chars: "ty", "yo", "hi", "?") match as whole tokens
  // only, so they do not fire inside unrelated words ("ty" in "party"). Longer
  // single-word keys also match as a substring of a token to catch inflections.
  const hit = (keys) => keys.some(k =>
    k.includes(' ') ? padded.includes(` ${k} `)
      : k.length <= 3 ? wordSet.has(k)
      : (wordSet.has(k) || words.some(w => w.includes(k))))

  // A negator immediately before a key blanks that key, so "dont stop",
  // "no human", "not now" cannot trip the irreversible intents.
  const NEGATORS = new Set(['no', 'not', 'dont', 'never', 'nao', 'nicht', 'pas', 'cha'])
  const guarded = new Set()
  for (let i = 1; i < words.length; i++) if (NEGATORS.has(words[i - 1])) guarded.add(i)
  const liveWords = new Set(words.filter((_, i) => !guarded.has(i)))
  // A key is "live" when it appears unguarded. Single-word keys: the token is not
  // negated. Multi-word keys: the phrase occurs as consecutive tokens AND none of
  // those token POSITIONS is guarded -- so "please dont leave me alone" does not
  // match "leave me alone" (the negator guards the first phrase word). We scan
  // positions rather than indexOf so a repeated word cannot be matched at the
  // wrong (guarded) occurrence.
  const phraseLive = (keyWords) => {
    for (let i = 0; i + keyWords.length <= words.length; i++) {
      let ok = true
      for (let j = 0; j < keyWords.length; j++) {
        if (words[i + j] !== keyWords[j] || guarded.has(i + j)) { ok = false; break }
      }
      if (ok) return true
    }
    return false
  }
  const live = (keys) => keys.some(k =>
    k.includes(' ') ? phraseLive(k.split(' ')) : liveWords.has(k))

  // STOP / HUMAN drive irreversible actions (opt-out, handoff): each is guarded by
  // its own exclude list of false-positive phrases -- STOP_EXCLUDE catches negated
  // forms ("dont stop", "bus stop"); HUMAN_EXCLUDE catches reported speech
  // ("a person told me", "in person"). We do not suppress a STOP that pairs an
  // exclude word with a real opt-out: losing a genuine opt-out is worse than an
  // occasional false one.
  if (live(STOP_KEYS)  && !STOP_EXCLUDE.some(p => padded.includes(` ${p} `)))  return 'stop'
  if (live(HUMAN_KEYS) && !HUMAN_EXCLUDE.some(p => padded.includes(` ${p} `))) return 'human'

  // STATUS is whole-word matched (live), not substring (hit): otherwise "update"
  // matches "updated" in "nothing updated since the sickness started", firing a
  // canned status reply on a real report that must reach the agent. STATUS is
  // read-only so it needs no negation guard, but live() handles both correctly.
  if (live(STATUS_KEYS)) return 'status'
  // A run of '?' ("?", "???", "????") from a confused contact is a help signal;
  // normalize collapses it to a single '?' token (see normalizeIntentText).
  if (hit(HELP_KEYS)) return 'help'

  // Short, content-free social turns get a warm canned nudge instead of an LLM
  // turn -- but ONLY greeting and thanks. We deliberately do NOT classify
  // yes/no or bare numbers: those are almost always answers to a question the
  // agent just asked, so they must fall through to the agent with full context.
  if (words.length <= 3) {
    if (hit(THANKS_KEYS))   return 'thanks'
    if (hit(GREETING_KEYS)) return 'greeting'
  }

  return null
}

// A genuine wrap-up "thanks" vs an engaged "thanks, what next?". The closing
// nudge spends a one-shot CLOSING-NUDGE marker for the whole case, so it must
// only fire when the contact is actually leaving -- a thanks that also carries a
// forward-looking word ("next", "now", "what") is someone still in the
// conversation, not someone going. Intent stays 'thanks' (so the warm canned
// reply still fires, never a dead-end); only the wrap-up deferral is suppressed.
const WRAPUP_BLOCK = new Set(['next', 'now', 'when', 'what', 'then', 'after', 'how'])
function isWrapUpThanks(text) {
  if (detectContactIntent(text) !== 'thanks') return false
  const t = normalizeIntentText(text)
  return !t.split(' ').some(w => WRAPUP_BLOCK.has(w))
}

// Keyword tables. Single-word keys match as whole tokens; multi-word keys as
// space-bounded phrases. Accent-stripped, lowercase (see normalizeIntentText).
// Languages: en, es, pt, it, fr, de, zu (Zulu), xh (Xhosa), ar (transliterated),
// hi (transliterated).
const STOP_KEYS = [
  'stop', 'unsubscribe', 'cancel', 'quit', 'leave me alone', 'go away',
  'no more', 'remove me', 'opt out', 'optout', 'enough',
  'stop msgs', 'stop sending', 'stop pls', 'i want stop',
  'hou op', 'los my', 'genoeg',                      // af
  'yeka', 'hambani', 'ngeke', 'yima', 'misa',        // zu
  'yeka oku', 'hamba',                               // xh
]
const STOP_EXCLUDE = [
  'no stop', 'dont stop', 'do not stop', 'please dont stop', 'never stop',
  'bus stop',
]

const HUMAN_KEYS = [
  'human', 'person', 'someone', 'somebody', 'real person', 'operator',
  'representative', 'staff', 'manager', 'speak to', 'talk to', 'call me',
  'real human', 'agent',
  'mens', 'persoon', 'iemand', 'regte persoon',      // af
  'umuntu', 'umsebenzi',                             // zu
  'umntu',                                           // xh
]
const HUMAN_EXCLUDE = [
  'a person told me', 'person told me', 'someone told me', 'another person',
  'in person', 'no person', 'wrong person',
  'someone come', 'someone came', 'anyone coming', 'did someone',
]

// Keyword lists focus on English + the SA languages a farmer is likely to type.
// The live model handles anything else; these only drive the deterministic,
// no-LLM shortcuts, so they cover en/af/zu/xh/st/tn rather than es/pt/fr/de.
const STATUS_KEYS = [
  'status', 'statu', 'staus', 'stats', 'update', 'progress', 'how long', 'any news', 'news', 'eta',
  'whats happening', 'what is happening', 'still waiting', 'where is',
  'feedback', 'any feedback', 'being looked', 'looked at', 'how far',
  'hows it going', 'any reply', 'reply yet', 'did you get', 'did u get',
  'get my report', 'received', 'sorted', 'done yet', 'fixed yet', 'came yet',
  'any answer',
  'enige nuus', 'hoe lank', 'wat gebeur',            // af
  'izindaba', 'kuphi', 'isimo', 'kunjani', 'sekwenzekani', 'sekuhanjwe', 'nuus', 'kuthiwani', // zu
  'iindaba', 'kuphi na',                             // xh
]

const HELP_KEYS = [
  'help', 'menu', 'options', 'what can', 'how do', 'confused', 'lost',
  'dont understand', 'do not understand', 'huh', '?', 'hlp', 'help me', 'can u help',
  'hulp', 'verdwaal',                                // af
  'usizo', 'ngidukile', 'siza', 'siza mina', 'ngicela usizo', 'ngicela', // zu
  'uncedo', 'ndilahlekile', 'ncedani', 'ndicela uncedo', // xh
  'thusa',                                           // st/tn
]

const THANKS_KEYS = [
  // NB: no bare 'thank' key -- it would substring-match any token containing it
  // ("thankfully it rained" -> false 'thanks'). 'thanks'/'thank you'/'thx'/'ty'
  // already cover every real thanks; the lone 'thank' only ever mis-fired.
  'thanks', 'thank you', 'thx', 'thnx', 'thank u', 'ta', 'ty', 'cheers', 'appreciate',
  'dankie', 'baie dankie',                           // af
  'ngiyabonga', 'siyabonga',                         // zu
  'enkosi', 'enkosi kakhulu',                        // xh
  'kea leboha', 'ke a leboga',                       // st/tn
]

const GREETING_KEYS = [
  'hi', 'hello', 'hey', 'hallo', 'hiya', 'yo', 'good morning',
  'good afternoon', 'good evening', 'greetings', 'morning', 'gud morning', 'heita', 'aweh',
  'goeie more', 'goeie middag', 'goeie naand',       // af
  'sawubona', 'molo', 'dumela', 'dumelang', 'molweni', 'sanibonani', 'unjani', 'ninjani', // zu/xh/st/tn
]

// Lowercase, strip diacritics/emoji/punctuation, COLLAPSE any run of '?' to a
// single '?' token (so "???" is a help signal, not an unmatchable "???" token),
// collapse whitespace.
function normalizeIntentText(text) {
  return (text || '')
    .toString()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9?\s]/g, ' ')
    .replace(/\?+/g, ' ? ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Add a tag to a comma-separated tag string without duplicating it.
function mergeTag(tags, tag) {
  const list = (tags || '').split(',').map(s => s.trim()).filter(Boolean)
  if (!list.includes(tag)) list.push(tag)
  return list.join(',')
}

// Inverse of mergeTag: remove a tag, leaving the rest intact and order-stable.
function dropTag(tags, tag) {
  return (tags || '').split(',').map(s => s.trim()).filter(Boolean).filter(t => t !== tag).join(',')
}

// Single source of truth for what the agent may do, per case autonomy mode.
// 'observe'  -- the agent neither computes a reply nor sends; a human drives.
// 'assisted' -- the agent COMPUTES a reply but it is held as a draft for an
//               operator to approve; nothing is auto-sent.
// 'auto'     -- the agent computes and sends automatically.
// Returns 'send' (compute and send), 'draft' (compute, hold), or 'none'.
export function canAgentAct(caseRow, action = 'reply') {
  const mode = caseRow?.autonomy || 'auto'
  if (mode === 'observe') return 'none'
  if (mode === 'assisted') return 'draft'
  return 'send'
}

// Plain-language, contact-safe description of where a request stands. Never
// exposes the internal stage name.
// Plain-language status, framed for a disease report: the team/field worker is
// looking into it, not "your order". en + the SA languages guessLang can return.
const STATUS_STRINGS = {
  en: {
    new: 'We have your report and the team will look at it very soon.', triaging: 'The team is looking at your report now.',
    in_progress: 'Someone from the team is working on this now.',
    waiting: 'The team has started and is waiting on one step. We will keep you posted.',
    resolved: 'This has been dealt with. If anything is still wrong with the animals, just tell us.',
    closed: 'This report is closed. Message any time if you see something new.',
    _: 'The team is looking into your report.',
  },
  af: {
    new: 'Ons het u verslag en die span sal baie gou daarna kyk.', triaging: 'Die span kyk nou na u verslag.',
    in_progress: 'Iemand van die span werk nou hieraan.',
    waiting: 'Die span het begin en wag op een stap. Ons sal u op hoogte hou.',
    resolved: 'Dit is hanteer. As iets nog steeds fout is met die diere, se net vir ons.',
    closed: 'Hierdie verslag is gesluit. Stuur enige tyd n boodskap as u iets nuuts sien.',
    _: 'Die span kyk na u verslag.',
  },
  zu: {
    new: 'Siwutholile umbiko wakho futhi ithimba lizowubheka maduzane.', triaging: 'Ithimba libheka umbiko wakho manje.',
    in_progress: 'Othile ethimbeni usebenza kulokhu manje.',
    waiting: 'Ithimba seliqalile futhi lilinde isinyathelo esisodwa. Sizokwazisa.',
    resolved: 'Lokhu sekulungisiwe. Uma kukhona okusako ngezilwane, sitshele nje.',
    closed: 'Lo mbiko uvaliwe. Thumela umlayezo noma nini uma ubona okuthile okusha.',
    _: 'Ithimba libheka umbiko wakho.',
  },
  xh: {
    new: 'Siwufumene umbiko wakho kwaye iqela liza kuwujonga kungekudala.', triaging: 'Iqela lijonga umbiko wakho ngoku.',
    in_progress: 'Umntu weqela usebenza koku ngoku.',
    waiting: 'Iqela seliqalile kwaye lilinde inyathelo elinye. Siza kukwazisa.',
    resolved: 'Oku kulungisiwe. Ukuba kukho into engalunganga ngezilwanyana, sixelele nje.',
    closed: 'Lo mbiko uvaliwe. Thumela umyalezo nanini na ukuba ubona into entsha.',
    _: 'Iqela lijonga umbiko wakho.',
  },
}

function plainStatus(status, lang = 'en') {
  const S = STATUS_STRINGS[lang] || STATUS_STRINGS.en
  return S[status] || S._
}

// Short status LABELS for a list context (an enquiry itinerary line), distinct from
// the verbose plainStatus SENTENCES (which read like a holding reply in a list).
const STATUS_LABELS = {
  en: { new: 'new', triaging: 'being looked at', in_progress: 'in progress', waiting: 'waiting', resolved: 'sorted', closed: 'closed', _: 'open' },
  af: { new: 'nuut', triaging: 'word bekyk', in_progress: 'aan die gang', waiting: 'wag', resolved: 'reggemaak', closed: 'gesluit', _: 'oop' },
  zu: { new: 'okusha', triaging: 'kuyabhekwa', in_progress: 'kuyaqhubeka', waiting: 'kulindile', resolved: 'kulungisiwe', closed: 'kuvaliwe', _: 'kuvuliwe' },
  xh: { new: 'entsha', triaging: 'kuyajongwa', in_progress: 'kuyaqhubeka', waiting: 'kulindile', resolved: 'kulungisiwe', closed: 'kuvaliwe', _: 'kuvuliwe' },
}
function shortStatus(status, lang = 'en') {
  const S = STATUS_LABELS[lang] || STATUS_LABELS.en
  return S[status] || S._
}

// Proactive, contact-safe note sent when a request MOVES to a new stage on an
// OPERATOR's action. Warm, no jargon, no dashes-as-punctuation (reads as a bot).
// Internal stages (new, triaging) and closed return '' and are not sent:
// - new/triaging are internal review steps the contact need not hear about.
// - closed is silent because `resolved` already told them it is done; an
//     operator moving resolved->closed seconds later would otherwise double-send.
export function stageNote(status) {
  return ({
    in_progress: 'Good news. Someone is working on your request now.',
    waiting:     'A quick update: your request is in progress and we are waiting on one step. We will be in touch.',
    resolved:    'Good news. Your request is sorted. If anything is still not right, just reply here.',
  })[status] || ''
}

// Build a CaseStore onTransition hook that sends the contact a proactive,
// plain-language note when an OPERATOR moves their request to a stage worth
// announcing. Reuses the dashboard's sendReply(caseRow, text) adapter.
//
// Guards (all must pass to send):
// - agent transitions -- skipped; the agent already replies to the contact
//                           in its own warm, contextual message (no double-send).
// - opted-out tag -- the contact said STOP; stay silent.
// - stageNote empty -- nothing worth announcing for this stage.
// - dedup -- skip if the most recent outbound is this exact note.
// "Only on real stage change" is guaranteed by transition() skipping no-ops.
export function makeTransitionNotifier(store, sendReply, { log = console } = {}) {
  if (!sendReply) return null
  return async function onTransition({ caseRow, to, user }) {
    // Only operator-driven moves notify. Agent self-transitions during a turn
    // would otherwise send a canned note ON TOP of the agent's own reply.
    if (user?.role === 'agent') return
    const tags = (caseRow.tags || '').split(',').map(s => s.trim())
    if (tags.includes('opted-out')) return
    const text = stageNote(to)
    if (!text) return
    try {
      const recent = await store.listEventsPage(caseRow.id, { limit: 8, offset: 0 })
      const lastOut = recent.find(e => e.kind === 'outbound')
      if (lastOut && (lastOut.text || '').trim() === text) return
    } catch (e) { log.warn?.('[casey] transition-note dedup check failed', { caseId: caseRow.id, error: e.message }) }
    try {
      await sendReply(caseRow, text)
      await store.appendEvent(caseRow.id, {
        kind: 'outbound', actor: 'system', channel: caseRow.channel,
        text, data: { to: caseRow.external_id, proactive: 'stage-note', stage: to },
      })
    } catch (e) {
      log.error?.('[casey] transition note send failed', { caseId: caseRow.id, error: e.message })
      await store.appendEvent(caseRow.id, { kind: 'observation', actor: 'system', text: `proactive note send failed: ${e.message}` })
    }
  }
}

// Build a clear, deterministic reply for a recognized intent. Every reply names
// the reference so a low-literacy farmer always has a handle on their report.
// Localised to the SA languages guessLang can return; `lang` comes from
// guessLang(inboundText) at the call site and falls through to English. Framed
// for a disease report (a team will look into it), no order/ticket language.
const INTENT_STRINGS = {
  en: {
    help: 'We are here to help. Reply STATUS to check on your report, HUMAN to talk to a person, or STOP to end messages. Or just tell us what you are seeing with the animals.',
    stop: 'Okay, we will not message you again. Reply HELP any time if you change your mind.',
    human: 'Of course. We are asking a person from the team to help you now. They will reply right here as soon as they can.',
    thanks: "You're welcome. Thank you for reporting it.",
    greeting: 'Hello! Good to hear from you. Tell us what you are seeing with the animals.',
    statusTail: ' Reply HUMAN any time to talk to a person.', refLabel: (r) => ` Your reference is ${r}.`,
  },
  af: {
    help: 'Ons is hier om te help. Antwoord STATUS om u verslag na te gaan, MENS om met n persoon te praat, of STOP om nie meer boodskappe te kry nie. Of se net vir ons wat u by die diere sien.',
    stop: 'Goed, ons sal u nie weer boodskap nie. Antwoord HELP enige tyd as u van plan verander.',
    human: 'Natuurlik. Ons vra nou iemand van die span om u te help. Hulle sal hier antwoord sodra hulle kan.',
    thanks: 'Plesier. Dankie dat u dit aangemeld het.',
    greeting: 'Hallo! Lekker om van u te hoor. Vertel ons wat u by die diere sien.',
    statusTail: ' Antwoord MENS enige tyd om met n persoon te praat.', refLabel: (r) => ` U verwysing is ${r}.`,
  },
  zu: {
    help: 'Silapha ukukusiza. Phendula u-STATUS ukuze ubheke umbiko wakho, u-HUMAN ukuze ukhulume nomuntu, noma u-STOP ukuze umise imilayezo. Noma usitshele nje ukuthi ubonani ezilwaneni.',
    stop: 'Kulungile, ngeke siphinde sikuthumelele. Phendula u-HELP noma nini uma ushintsha umqondo.',
    human: 'Impela. Sicela umuntu wethimba ukuthi akusize manje. Uzophendula lapha ngokushesha angakwazi.',
    thanks: 'Wamukelekile. Siyabonga ngokukubika.',
    greeting: 'Sawubona! Kuhle ukuzwa kuwe. Sitshele ukuthi ubonani ezilwaneni.',
    statusTail: ' Phendula u-HUMAN noma nini ukuze ukhulume nomuntu.', refLabel: (r) => ` Inombolo yakho yereferensi ngu-${r}.`,
  },
  xh: {
    help: 'Silapha ukukunceda. Phendula u-STATUS ukujonga umbiko wakho, u-HUMAN ukuthetha nomntu, okanye u-STOP ukuyeka imiyalezo. Okanye sixelele nje ukuba ubona ntoni kwizilwanyana.',
    stop: 'Kulungile, asisayi kuphinda sikuthumelele. Phendula u-HELP nanini na ukuba uyaguqula ingqondo.',
    human: 'Ewe kakhulu. Sicela umntu weqela ukuba akuncede ngoku. Uya kuphendula apha kamsinya.',
    thanks: 'Wamkelekile. Enkosi ngokuyixela.',
    greeting: 'Molo! Kuhle ukuva kuwe. Sixelele ukuba ubona ntoni kwizilwanyana.',
    statusTail: ' Phendula u-HUMAN nanini na ukuthetha nomntu.', refLabel: (r) => ` Inombolo yakho yesalathiso ngu-${r}.`,
  },
}

export function intentReply(intent, caseRow, lang = 'en') {
  const L = INTENT_STRINGS[lang] || INTENT_STRINGS.en
  const ref = caseRow?.ref ? L.refLabel(caseRow.ref) : ''
  if (intent === 'status') return `${plainStatus(caseRow.status, lang)}${L.statusTail}${ref}`
  const body = L[intent]
  return body ? `${body}${ref}` : ''
}

// Posts a one-line operator alert to a Discord webhook. Returns null if no URL is
// configured, so handoff flagging works with or without Discord wired up.
// allowed_mentions.parse:[] blocks a contact injecting @everyone via the subject.
export function discordHandoffNotifier(webhookUrl = process.env.CASEY_HANDOFF_WEBHOOK, log = null) {
  if (!webhookUrl) return null
  return async ({ case: c, channel, from }) => {
    const content = `A person is needed - case ${c.ref} on ${channel} (${from})`
      + (c.subject ? ` - ${c.subject}` : '')
    // A flaky webhook must never break the handoff itself: the case is already
    // flagged needs-human in the store, so the dashboard surfaces it regardless.
    // Degrade to a warning rather than rejecting the inbound turn (P9).
    await postWebhook(webhookUrl, content, log, 'discord handoff webhook')
  }
}

// Posts a one-line guardrail-breach alert to a Discord webhook. Same transport and
// safety as the handoff notifier (no @-mentions, 5s timeout, degrade-not-throw),
// but driven by the periodic sweep rather than an inbound turn. Returns null with
// no URL so a sweep runs alert-free when nothing is configured.
export function breachNotifier(webhookUrl = process.env.CASEY_ALERT_WEBHOOK || process.env.CASEY_HANDOFF_WEBHOOK, log = null, opts = {}) {
  if (!webhookUrl) return null
  return async (c, breach, detail) => {
    const content = `Case ${c.ref}: ${detail || breach}`
    // Attach a structured, aggregate-only payload (no external_id) so a generic
    // pager can route on case_type/severity while Discord still renders `content`.
    const alert = buildAlertPayload(c, breach, detail, { escalated: !!opts.escalated })
    await postWebhook(webhookUrl, content, log, 'discord breach webhook', alert)
  }
}

// Shared Discord-webhook POST: blocks @-mention injection, aborts after 5s, and
// degrades a failure to a warning so a flaky webhook never breaks the caller. When
// an `alert` object is given it is merged into the body so a non-Discord pager gets
// machine-parseable breach metadata; Discord ignores the extra keys and renders
// `content`. The alert is aggregate-only (no external_id) by construction.
async function postWebhook(webhookUrl, content, log, label, alert = null) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 5000)
  const body = { content, allowed_mentions: { parse: [] } }
  if (alert) body.alert = alert
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: ac.signal,
  }).then(() => clearTimeout(timer), (e) => { clearTimeout(timer); log?.warn?.(`[casey] ${label} failed`, e.message) })
}
