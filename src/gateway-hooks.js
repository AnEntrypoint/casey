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
import { VISIT_CRITICAL } from './case-health.js'

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
    `reporting service in rural South Africa. Farmers and field workers message in`,
    `on ${caseRow.channel} to report sick or dead livestock (for example cattle,`,
    `sheep, goats, or pigs). Your job is to make it easy for them to tell you what`,
    `is happening, and to quietly gather a clear, organised report for the team who`,
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
    `Useful things: which animals; what they are seeing (drooling, blisters,`,
    `lameness, sudden death); how many are sick or have died; when it started; where`,
    `the animals are and how to find the place; any disease they name; recent`,
    `movement (auctions, new animals, shared grazing); photos; how to identify the`,
    `animals; how to reach the place and the farmer; whether the farmer will be there.`,
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
    `THIS IS USUALLY YOUR ONE CHANCE. After this conversation the farmer or worker`,
    `will likely leave the animals and be hard to reach, so facts you cannot get`,
    `later matter most. PRIORITY ORDER for what to ask if one thing is missing and`,
    `you must gently prompt: (1) WHERE are the animals -- farm name, town, or GPS;`,
    `(2) WHICH animals -- species (cattle, sheep, etc.); (3) WHAT are the signs`,
    `(drooling, blisters, sudden death); (4) HOW to find the place (road, landmark);`,
    `(5) Will the FARMER be there on arrival; (6) Any OTHER contact person.`,
    `If one of these on-site facts is still missing and the person seems to be`,
    `wrapping up, you may gently ask for the single most important one -- once --`,
    `before they go. Otherwise still NEVER interrogate: no list of questions, no`,
    `demands, never re-ask something already in "report so far" above. Most facts`,
    `come out on their own as they talk. Ask at most one gentle question per message,`,
    `and it is fine to ask nothing and simply reassure them.`,
    // If most VC fields are filled and photos not yet mentioned, gentle ask
    ...( (() => {
      if (!reportObj) return []
      const vcMissing = VISIT_CRITICAL.filter(k => reportObj[k] == null).length
      const hasPhotos = reportObj && reportObj.photos != null
      if (vcMissing === 0 && !hasPhotos) {
        return [`PHOTOS: Most of the important details are recorded. If the farmer has a`,
                `photo of the sick animals, a gentle "do you have any photos?" is useful`,
                `-- but only if the conversation is still going naturally. Never demand it.`]
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

export function fallbackReply(contactText, caseRow) {
  const lang = guessLang(contactText)
  const base = FALLBACK_BY_LANG[lang] || FALLBACK_REPLY
  const ref = caseRow?.ref
  if (!ref) return base
  // Localised "your reference is X" tail, kept short.
  const tail = {
    af: ` U verwysingsnommer is ${ref}.`,
    zu: ` Inombolo yakho yereferensi ngu-${ref}.`,
    xh: ` Inombolo yakho yesalathiso ngu-${ref}.`,
  }[lang] || ` Your reference is ${ref}.`
  return base + tail
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

// The degraded reply that does NOT dead-end: when the model errored/echoed/emptied
// but the case still needs a visit-critical fact, the holding ack is followed by
// ONE gentle question for the single most important missing fact, so the intake
// advances even on the fallback path. When nothing is missing (or no report yet
// has a clear next ask), it is exactly fallbackReply -- the safe holding ack.
// Caller guards once-only via an observation marker so a contact is not re-asked
// the same fact every degraded turn.
export function advancingFallback(contactText, caseRow) {
  const base = fallbackReply(contactText, caseRow)
  const fact = mostImportantMissingField(caseRow?.report)
  if (!fact) return base
  return `${base} ${askCarrier(guessLang(contactText), fact)}`
}

export function makeCaseHandler(store, { callLLM = null, autoRespond = true, log = console, notifyHandoff = null } = {}) {
  // Per-contact in-flight guard: if a prior agent turn is still running for this
  // contact, we drop the new message rather than race two concurrent LLM calls
  // against the same case. The contact's inbound is still recorded (above), so
  // nothing is lost -- the next turn will pick up the full conversation including
  // this message. The guard is keyed on external_id (the canonical contact key).
  const inFlight = new Set()
  return async function handleInbound(platform, msg) {
    const channel = CHANNEL_DEFAULT[platform] || platform || 'other'
    const external_id = conversationKey(msg)
    const adapter = this?.platforms?.get?.(platform)
    if (!store) {
      log?.error?.('[casey] store not initialized')
      const warmText = FALLBACK_REPLY + ' We are experiencing a brief interruption. Please try again shortly.'
      // The gateway discards this handler's return value (freddie run.js calls
      // handleInbound only for its side effects), so a warm holding reply reaches
      // the contact ONLY if we send it ourselves. Target external_id (channel id
      // on Discord, phone on WhatsApp) -- msg.from is the author id and would 404.
      if (adapter?.send) {
        try { await adapter.send({ to: external_id, text: warmText, platform }) }
        catch (e) { log?.error?.('[casey] store-not-ready holding send failed', { channel, error: e.message }) }
      }
      return { to: external_id, text: warmText, platform, error: 'store_not_ready' }
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
        try { await adapter.send({ to: external_id, text: storeDownText, platform }) }
        catch (sendErr) { log.error?.('[casey] store-down holding send failed', { channel, error: sendErr.message }) }
      }
      return { to: external_id, text: storeDownText, platform, error: e.message }
    }

    // Dedup: a redelivered platform message (webhook retry, gateway replay, or
    // the same message duplicated in one tick) is recorded and answered exactly
    // once. recordInbound runs on the per-conversation lock so the dedup check
    // and the append are atomic -- duplicates are structurally unrepresentable,
    // not merely improbable.
    const inboundText = (msg.text || '').trim()
    const media = describeMedia(msg)
    const inboundEvent = await store.recordInbound(caseRow, {
      channel,
      text: inboundText || (media ? `[${media}]` : '[empty message]'),
      data: {}, msg_id: msgId,
    })
    if (!inboundEvent) {
      log.info?.('[casey] duplicate inbound dropped', { caseId: caseRow.id, msgId })
      return { to: external_id, text: '', platform, caseId: caseRow.id, duplicate: true }
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

    if (!autoRespond) return { to: external_id, text: '', platform, caseId: caseRow.id }

    const fresh = await store.getCase(caseRow.id)

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
      return { to: external_id, text: '', platform, caseId: fresh.id, observed: true }
    }

    // Deterministic intent shortcuts. For a few universal intents a low-literacy
    // contact is likely to send, a fixed, correct reply beats a generated one --
    // so we answer without an LLM turn. This runs only when auto-responding and
    // not in observe mode (handled above). Empty/media messages normalize to no
    // intent and fall through to the agent turn unchanged.
    const isFirstMessage = (await store.listEvents(fresh.id)).filter(e => e.kind === 'inbound').length <= 1
    const optedOut = (fresh.tags || '').split(',').map(s => s.trim()).includes('opted-out')
    let intent = detectContactIntent(inboundText)
    // On a brand-new contact, greeting/help deserve the agent's warm intro +
    // reference, not a canned line -- so defer them to the agent on message one.
    // (status/human/stop/thanks still answered deterministically.)
    if (['help', 'greeting'].includes(intent) && isFirstMessage) intent = null
    // One-shot closing capture: a "thanks" is usually the farmer wrapping up, and
    // after this they leave the site and are hard to reach. If a visit-critical
    // on-site fact is still missing AND we have not already made one closing ask,
    // do NOT take the canned thanks-shortcut -- defer to the agent so it can ask
    // for the single most important missing fact, once, before they go. Once we
    // have asked (closing-nudged tag) or the report is visit-ready, thanks is
    // answered deterministically as before (no nagging, never block a goodbye).
    if (intent === 'thanks' && !optedOut) {
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
      return { to: external_id, text: '', platform, caseId: fresh.id, optedOut: true }
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
        text, data: { to: external_id, intent, deterministic: true },
      })
      // Reply target is external_id (the conversation key), NOT msg.from. On
      // Discord, freddie's adapter POSTs to /channels/{to}/messages, so `to` must
      // be the channel id (conversationKey), not the author id -- sending to the
      // author id silently fails (Discord 404, swallowed by .then(json)) and the
      // contact never sees a reply. external_id is correct for WhatsApp too, where
      // conversationKey falls back to msg.from (the phone number).
      const reply = { to: external_id, text, platform, caseId: fresh.id, intent }
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
    const closingCapture = detectContactIntent(inboundText) === 'thanks' && reportMissingVisitCritical(fresh.report)
      ? mostImportantMissingField(fresh.report)
      : null

    // Per-contact concurrency gate: a second message from the same contact while
    // the first turn is still in the LLM is held off until next poll / retry.
    if (inFlight.has(external_id)) {
      log.info?.('[casey] skipping concurrent LLM turn', { caseId: fresh.id })
      await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'concurrent turn skipped: prior LLM turn still in-flight for this contact' })
      return { to: external_id, text: '', platform, caseId: fresh.id, skipped: true }
    }
    inFlight.add(external_id)
    let result, errored = false
    try {
      result = await runTurn({
        prompt,
        messages: [{ role: 'system', content: caseSystemPrompt(fresh, events, contact, { closingCapture }) }],
        sessionKey: `case:${fresh.id}`,
        callLLM,
        enabledToolsets: ['cases', 'core'],
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
    if (!text) {
      if (!errored && result?.error) {
        log.warn?.('[casey] agent returned error result', { caseId: fresh.id, error: result.error })
        await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `agent result error: ${result.error}` })
      }
      // Never a dead-end: when the model fails (error/timeout/empty/prompt-echo)
      // but the case still needs a visit-critical fact, the holding ack is
      // followed by ONE gentle question for the single most important missing
      // fact, so the conversation advances even on the degraded path. This is the
      // contact's "one chance" -- a bare ack every turn is the live stall the
      // weak model otherwise causes (it echoes -> isPromptEcho -> fallback). We
      // ask via the fallback at most ONCE per case (durable observation marker,
      // append-only so the agent's own case_update cannot clobber it); after that
      // the degraded reply is the plain holding ack and the operator takes over.
      const priorAsk = await store.listEvents(fresh.id)
      const alreadyAskedViaFallback = priorAsk.some(e => e.kind === 'observation' && /FALLBACK-ASK/.test(e.text || ''))
      const advancing = !alreadyAskedViaFallback ? advancingFallback(inboundText, fresh) : fallbackReply(inboundText, fresh)
      if (!alreadyAskedViaFallback && advancing !== fallbackReply(inboundText, fresh)) {
        await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'FALLBACK-ASK: degraded reply advanced intake with one gentle question for the most important missing on-site fact (one-shot).' })
      }
      text = advancing
    }
    const isFallback = !text
      || text === fallbackReply(inboundText, fresh)
      || text === advancingFallback(inboundText, fresh)

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

    // ASSISTED mode: the agent composed a reply, but a human must approve before
    // anything reaches the contact. Hold it as a draft event (never sent), flag
    // the case for an operator, and notify once -- mirroring the human-handoff
    // path. The dashboard surfaces the draft for one-click approve/discard.
    if (canAgentAct(fresh, 'reply') === 'draft') {
      await store.appendEvent(fresh.id, {
        kind: 'draft', actor: 'agent', channel,
        text, data: { to: external_id, fallback: isFallback, draft: true },
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
      return { to: external_id, text: '', platform, caseId: fresh.id, drafted: true }
    }

    await store.appendEvent(fresh.id, {
      kind: 'outbound', actor: 'agent', channel,
      text, data: { to: external_id, fallback: isFallback },
    })

    // Reply target is external_id (conversationKey), NOT msg.from -- see the note
    // at the deterministic-intent reply above. On Discord, freddie POSTs to
    // /channels/{to}/messages, so `to` must be the channel id; on WhatsApp,
    // conversationKey falls back to the phone number. msg.from (author id) silently
    // 404s on Discord and the contact never sees the reply.
    const reply = { to: external_id, text, platform, caseId: fresh.id }
    if (adapter?.send) {
      try { await adapter.send(reply) }
      catch (e) {
        log.error?.('[casey] adapter.send failed', { caseId: fresh.id, platform, error: e.message })
        await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `send failed on ${channel}: ${e.message}` })
      }
    }
    return reply
  }
}

// The conversation identity: prefer an explicit chat/channel id from the raw
// payload (Discord channel id, WhatsApp chat), else the sender.
function conversationKey(msg) {
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
// plain-language hint the agent can ask about. Location-first: without WHERE, a
// field visit cannot happen at all.
const VISIT_CRITICAL_ASK = [
  ['location', 'where the animals are (the farm, nearest town, or area)'],
  ['species', 'which animals are affected'],
  ['symptoms', 'what they are seeing in the animals'],
  ['how_to_find', 'how to find the place'],
  ['farmer_available', 'whether they will be there if someone comes'],
  ['contact_fallback', 'another number to reach them if they are away'],
]
function mostImportantMissingField(reportRaw) {
  const r = parseReportSafe(reportRaw)
  const hit = VISIT_CRITICAL_ASK.find(([k]) => r[k] == null || String(r[k]).trim() === '')
  return hit ? hit[1] : null
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

// Keyword tables. Single-word keys match as whole tokens; multi-word keys as
// space-bounded phrases. Accent-stripped, lowercase (see normalizeIntentText).
// Languages: en, es, pt, it, fr, de, zu (Zulu), xh (Xhosa), ar (transliterated),
// hi (transliterated).
const STOP_KEYS = [
  'stop', 'unsubscribe', 'cancel', 'quit', 'leave me alone', 'go away',
  'no more', 'remove me', 'opt out', 'optout', 'enough',
  'hou op', 'los my', 'genoeg',                      // af
  'yeka', 'hambani', 'ngeke',                        // zu
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
]

// Keyword lists focus on English + the SA languages a farmer is likely to type.
// The live model handles anything else; these only drive the deterministic,
// no-LLM shortcuts, so they cover en/af/zu/xh/st/tn rather than es/pt/fr/de.
const STATUS_KEYS = [
  'status', 'update', 'progress', 'how long', 'any news', 'news', 'eta',
  'whats happening', 'what is happening', 'still waiting', 'where is',
  'enige nuus', 'hoe lank', 'wat gebeur',            // af
  'izindaba', 'kuphi', 'isimo',                      // zu
  'iindaba', 'kuphi na',                             // xh
]

const HELP_KEYS = [
  'help', 'menu', 'options', 'what can', 'how do', 'confused', 'lost',
  'dont understand', 'do not understand', 'huh', '?',
  'hulp', 'verdwaal',                                // af
  'usizo', 'ngidukile',                              // zu
  'uncedo', 'ndilahlekile',                          // xh
  'thusa',                                           // st/tn
]

const THANKS_KEYS = [
  'thanks', 'thank you', 'thank', 'thx', 'ty', 'cheers', 'appreciate',
  'dankie', 'baie dankie',                           // af
  'ngiyabonga', 'siyabonga',                         // zu
  'enkosi', 'enkosi kakhulu',                        // xh
  'kea leboha', 'ke a leboga',                       // st/tn
]

const GREETING_KEYS = [
  'hi', 'hello', 'hey', 'hallo', 'hiya', 'yo', 'good morning',
  'good afternoon', 'good evening', 'greetings',
  'goeie more', 'goeie middag', 'goeie naand',       // af
  'sawubona', 'molo', 'dumela', 'dumelang',          // zu/xh/st/tn
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
export function breachNotifier(webhookUrl = process.env.CASEY_ALERT_WEBHOOK || process.env.CASEY_HANDOFF_WEBHOOK, log = null) {
  if (!webhookUrl) return null
  return async (c, breach, detail) => {
    const content = `Case ${c.ref}: ${detail || breach}`
    await postWebhook(webhookUrl, content, log, 'discord breach webhook')
  }
}

// Shared Discord-webhook POST: blocks @-mention injection, aborts after 5s, and
// degrades a failure to a warning so a flaky webhook never breaks the caller.
async function postWebhook(webhookUrl, content, log, label) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 5000)
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    signal: ac.signal,
  }).then(() => clearTimeout(timer), (e) => { clearTimeout(timer); log?.warn?.(`[casey] ${label} failed`, e.message) })
}
