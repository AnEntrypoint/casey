// hooks/heuristics.js -- pure-text heuristics used by casey's inbound handler.
//
// Split out of gateway-hooks.js (see AGENTS.md's Source map for the file's
// role). These are deliberately pure functions over strings/const tables --
// no I/O, no store access -- so they are independently readable/reviewable
// and safe to unit-reason about in isolation. Behavior is byte-identical to
// the original gateway-hooks.js; only the physical location moved.

// Shared truncate helper -- also used by prompt.js, media.js, and handler.js.
export function truncate(s, n) { s = s || ''; return s.length > n ? s.slice(0, n - 1) + '...' : s }

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
export function isPromptEcho(text) {
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
// Exported so callers (handler.js) can scan OTHER text (e.g. raw tool-call
// results) for the same ref shape without duplicating the pattern.
export const CASE_REF_RE = /CASE-\d+-[a-z0-9]+/gi

// extraAllowedRefs: real refs the agent legitimately learned THIS turn via a
// tool call (case_list/case_mine/case_today/case_get/case_link_suggestions --
// the enquiry surface AGENTS.md documents as answering "my cases"/"any cases
// near X" by citing OTHER cases' real refs). Without this, every genuinely-
// different, tool-returned ref was indistinguishable from a hallucinated one
// and got silently rewritten to THIS case's own ref -- corrupting every
// multi-case enquiry answer into a wrong case number. Case-insensitive, same
// as the realRef comparison already was.
export function sanitizeOutboundRef(text, realRef, extraAllowedRefs = []) {
  if (!text || !realRef) return { text, corrected: [] }
  const allowed = new Set([String(realRef).toLowerCase(), ...extraAllowedRefs.map(r => String(r).toLowerCase())])
  const corrected = []
  const fixed = String(text).replace(CASE_REF_RE, (tok) => {
    if (allowed.has(tok.toLowerCase())) return tok
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

// A forced-tool-call turn (tool_choice:'required') that comes back with no
// tool_calls array is not automatically bad content -- a model can perfectly
// well answer a plain "hi" or a status question in real, on-topic prose
// without touching a tool, and blanking every such reply wastes a genuinely
// good answer the contact was owed. What MUST never reach the contact is the
// specific witnessed failure mode: a self-referential REFUSAL about its own
// tool access ("I don't have the tools/access to assist") -- that is the
// model narrating its own malfunction, not answering the contact at all.
// Detected structurally by matching the model talking ABOUT its own
// tools/capabilities/access, not by the topic of the message (an on-topic
// "cows"/"chickens" report has none of these self-referential phrases).
// ASCII only, matches heuristics.js's existing pattern style.
const TOOL_REFUSAL_MARKERS = [
  "don't have the tools",
  'do not have the tools',
  "don't have access to",
  'do not have access to',
  "don't have the capability",
  'do not have the capability',
  'unable to access the',
  'i cannot call',
  "i can't call",
  'no tool available',
  'lack the necessary tools',
  'as an ai, i',
  'as a language model',
  // Witnessed live: unlike the phrases above (each names the missing TOOL/ACCESS
  // specifically), a weak model sometimes refuses in a vaguer, content-free way
  // that names no reason at all -- "unable to assist with that request" sent in
  // direct reply to an on-topic follow-up (a farewell on an already-open case),
  // which the model had every tool needed to handle. A genuine, GOOD scope
  // decline ("I can only help with reporting sick or dead animals") never
  // matches this exact phrase, so the two are not confused.
  "unable to assist with that",
  'cannot assist with that',
]
export function isToolRefusal(text) {
  if (!text) return false
  const norm = String(text).toLowerCase().replace(/\s+/g, ' ').trim()
  return TOOL_REFUSAL_MARKERS.some(m => norm.includes(m))
}

// Live-witnessed (real Discord traffic, cerebras/gpt-oss-120b -- a reasoning-
// family model): the model's final-turn content was its OWN planning
// narration about how to compose the reply, not the reply itself -- "We
// should reply warmly, short, in English, ask if they have anything to
// report." sent verbatim to the contact instead of an actual warm reply. A
// reasoning-family model sometimes fails to separate its internal plan from
// its final answer when the API gives it no distinct reasoning/thinking
// field. Detected structurally, narrowly: the message OPENS with a
// first-person-plural or self-instructional planning verb ("we should",
// "i should", "i will", "let me") directly followed by "reply"/"respond" --
// and, since a genuine reply can legitimately start "I will reply..." while
// actually addressing the contact next in the SAME sentence, the match only
// fires when that opening is immediately followed by a STYLE/MANNER
// description of the reply (an adverb like "warmly"/"briefly"/"shortly", or
// a THIRD-PERSON reference to the contact -- "ask them"/"tell them") rather
// than real, direct, second-person content. A genuine reply speaks TO the
// contact ("please tell me more", "I need to know where..."); this pattern
// speaks ABOUT the act of speaking to them.
const META_COMMENTARY_RE = /^(we|i)\s+(should|will|need to|must|could|can)\s+(reply|respond)\s*,?\s*(warmly|briefly|shortly|kindly|politely|in\s+\w+\s*,|short\b|to\s+them\b|and\s+ask\s+them\b|ask\s+(if\s+)?them\b)/i
export function isMetaCommentary(text) {
  if (!text) return false
  return META_COMMENTARY_RE.test(String(text).trim())
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
// The ordinary conjunction "in case" (and "in case of", "just in case") uses
// "case" as a connector, not the internal-process noun this gate exists to
// catch -- strip it before scanning so a clean, correct reply is never held.
const IDIOM_IN_CASE_RE = /\bin case(?: of)?\b/gi
export function jargonHits(text) {
  if (!text) return []
  // Strip the case-reference token first: a real ref is "CASE-1073-iyniv", whose
  // "CASE" prefix would otherwise trip \bcase\b on EVERY reply that quotes the
  // reference (the contact-facing ref is required, not jargon). The ref is the one
  // legitimate place "CASE" appears in an outbound; scan the rest.
  const scrubbed = String(text).replace(CASE_REF_RE, ' ').replace(IDIOM_IN_CASE_RE, ' ')
  const found = new Set()
  const m = scrubbed.match(JARGON_RE)
  if (m) for (const w of m) found.add(w.toLowerCase())
  return [...found]
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
  // Sesotho and Setswana: the system prompt already promises to match these two
  // (line ~219) but the deterministic pre-LLM ack layer (STOP/HUMAN/resume, the
  // one layer meant to work correctly with the model down) had no cues for
  // either -- distinctive tokens chosen the same way as af/zu/xh above.
  // 'dumela' is a shared st/tn greeting -- kept only on st so a bare-greeting
  // message doesn't tie 1-1 and fall back to English; tn is distinguished by
  // its own unique cues (rra/mma/a lwala) instead.
  st: [' dumela ', ' kea leboha ', ' ntate ', ' mme ', ' kgomo ', ' dikgomo ', ' lea kula ', ' ke kopa ', ' tjhelete ', ' thusa '],
  tn: [' ke a leboga ', ' rra ', ' mma ', ' kgomo ', ' dikgomo ', ' a lwala ', ' ke kopa ', ' thusa '],
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

// USER DIRECTIVE: no mocks/fallbacks/stubs -- only singular working mechanisms
// and loud errors. A degraded turn (model error/timeout/empty/echo/stock-ack/
// repeat) no longer composes a warm holding reply -- fallbackReply() is
// deliberately gone. The caller sends NOTHING to the contact on a degraded
// turn and logs/records the failure loudly instead (see the degraded-turn
// branch in makeCaseHandler). The reliability fix is upstream: the in-process
// acptoapi bridge (freddie) is the mechanism that must actually work, not a
// scripted apology for when it doesn't.

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

// Contact intent detection -- low-literacy / multilingual handlers
//
// Low-literacy / multilingual contacts often send one word, an emoji, or a
// phrase in their own language. Before spending an LLM turn we check for a few
// universal intents and answer deterministically where a fixed, correct reply
// beats a generated one. Matching is forgiving: lowercased, accent-stripped,
// substring/keyword across several widely-spoken languages.
//
// Returns 'human' | 'stop' | 'help' | null. This is the ONE deterministic safety
// layer the pure-agent reshape KEEPS: STOP (opt-out) and HUMAN (handoff) are
// irreversible service controls that must fire synchronously in any language even
// when the LLM backend is down -- they can never be queued behind a holding ack.
// 'help' (checked AFTER stop/human) exists ONLY so an opted-out contact can opt
// back in ("Reply HELP any time"); for a live contact it falls through to the
// agent turn like any other message. Every other classification (status/greeting/
// thanks/enquiry/report) is the agent's job via the case tools. Negation-guarded
// so "dont stop" / "no human" cannot trip an irreversible action.
export function detectContactIntent(text) {
  const t = normalizeIntentText(text)
  if (!t) return null
  const words = t.split(' ')
  const padded = ` ${t} `

  // A negator immediately before a key blanks that key, so "dont stop",
  // "no human", "not now" cannot trip the irreversible intents.
  const NEGATORS = new Set(['no', 'not', 'dont', 'never', 'nao', 'nicht', 'pas', 'cha', 'aikona', 'hayi'])
  const guarded = new Set()
  for (let i = 1; i < words.length; i++) if (NEGATORS.has(words[i - 1])) guarded.add(i)
  const liveWords = new Set(words.filter((_, i) => !guarded.has(i)))
  // A key is "live" when it appears unguarded. Multi-word keys must occur as
  // consecutive tokens; only a negator OUTSIDE the phrase (immediately before its
  // first word) guards it -- a guard raised by a word INSIDE the phrase (e.g. the
  // 'no' in "no more messages" guarding 'more') must not blank the phrase itself.
  const phraseLive = (keyWords) => {
    for (let i = 0; i + keyWords.length <= words.length; i++) {
      let ok = true
      for (let j = 0; j < keyWords.length; j++) {
        if (words[i + j] !== keyWords[j] || (j === 0 && guarded.has(i))) { ok = false; break }
      }
      if (ok) return true
    }
    return false
  }
  // Ambiguous stop-words ('stop', 'quit', 'hamba', 'go away', ...) occur
  // constantly inside ordinary report sentences and relayed speech -- "she said
  // stop bringing new animals in", "the sores wont go away", "the farmer quit
  // giving the medicine", "uthe hamba uye edamini" (he said go to the dam) --
  // and an exclude list can never enumerate that open-ended space. A GENUINE
  // bare opt-out is a short imperative ("STOP", "stop please", "go away"), so
  // an ambiguous key fires only when the WHOLE normalized message is at most
  // AMBIGUOUS_MAX_WORDS tokens. Unambiguous messaging-object keys
  // (unsubscribe, cancel messages, stop sending, ...) keep firing at any
  // length, so a long explicit opt-out still short-circuits deterministically;
  // a long ambiguous sentence flows to the agent, which reads it and can act
  // via case_stop when it really is an opt-out.
  const shortMsg = words.length <= AMBIGUOUS_MAX_WORDS
  // Every start index where keyWords occurs live (unguarded), for exclude-window
  // scoping below. Single-word keys are just keyWords=[k].
  const liveOccurrences = (keyWords) => {
    const out = []
    for (let i = 0; i + keyWords.length <= words.length; i++) {
      let ok = true
      for (let j = 0; j < keyWords.length; j++) {
        if (words[i + j] !== keyWords[j] || (j === 0 && guarded.has(i))) { ok = false; break }
      }
      if (ok) out.push(i)
    }
    return out
  }
  // Exclude matching is scoped to a window AROUND the specific occurrence of the
  // matched key, not the whole message -- an excluded phrase elsewhere in a long
  // message (e.g. "can i speak to a vet, and also i really need a real human on
  // the phone") must not suppress a genuine, distinct handoff request ("real
  // human") that occurs outside that phrase's own token span.
  const EXCLUDE_WINDOW = 4
  const excludedAt = (excludeList, idx, len) => {
    const lo = Math.max(0, idx - EXCLUDE_WINDOW)
    const hi = Math.min(words.length, idx + len + EXCLUDE_WINDOW)
    const windowText = ` ${words.slice(lo, hi).join(' ')} `
    return excludeList.some(p => windowText.includes(` ${p} `))
  }
  // Fires when at least one live, non-ambiguous-at-this-length occurrence of any
  // key survives its own nearby exclude check.
  const fires = (keys, excludeList) => keys.some(k => {
    if (!shortMsg && (AMBIGUOUS_STOP_KEYS.has(k) || AMBIGUOUS_HUMAN_KEYS.has(k))) return false
    const keyWords = k.includes(' ') ? k.split(' ') : [k]
    return liveOccurrences(keyWords).some(idx => !excludedAt(excludeList, idx, keyWords.length))
  })
  const live = (keys) => keys.some(k => {
    if (!shortMsg && (AMBIGUOUS_STOP_KEYS.has(k) || AMBIGUOUS_HUMAN_KEYS.has(k))) return false
    return k.includes(' ') ? phraseLive(k.split(' ')) : liveWords.has(k)
  })

  // STOP / HUMAN, each guarded by its own exclude list of false-positive phrases:
  // STOP_EXCLUDE catches "dont stop"/"bus stop", HUMAN_EXCLUDE catches "a person
  // told me"/"in person". A genuine opt-out that also contains an exclude word is
  // NOT suppressed -- losing a real opt-out is worse than an occasional false one.
  if (fires(STOP_KEYS, STOP_EXCLUDE))   return 'stop'
  if (fires(HUMAN_KEYS, HUMAN_EXCLUDE)) return 'human'
  // RESUME after opt-out: checked AFTER stop/human so "stop helping me" and "help
  // me reach a person" keep their stronger meanings. Only the opted-out gate acts
  // on 'help'; a live conversation lets it fall through to the agent.
  if (live(HELP_KEYS)) return 'help'

  return null
}

// Keyword tables. Single-word keys match as whole tokens; multi-word keys as
// space-bounded phrases. Accent-stripped, lowercase (see normalizeIntentText).
// Languages actually covered here: en, es, pt, it, fr, de, af (Afrikaans),
// zu (Zulu), xh (Xhosa), st (Sesotho), tn (Setswana), ts (Xitsonga),
// ve (Tshivenda), ss (siSwati), nr (isiNdebele) -- all 11 SA official
// languages plus a few widely-spoken others, so the ONE deterministic safety
// layer (STOP/HUMAN, must work with the LLM down) fires correctly in
// whichever of THESE a field worker writes in. Arabic and Hindi are detected
// only by guessLang's script-range check (below) for REPLY LANGUAGE
// selection -- neither has any transliterated token in STOP_KEYS/HUMAN_KEYS/
// STOP_EXCLUDE/HUMAN_EXCLUDE/HELP_KEYS, so a contact writing a STOP/human
// request in ar/hi transliteration gets no deterministic match; if the LLM
// happens to be down at that exact moment, that message is queued rather
// than acted on immediately (the same outcome as any other language this
// deterministic layer does not cover).
// The bare over-broad tokens ('enough', 'cancel', 'genoeg', 'ngeke', 'yima',
// 'hambani') were removed: each falsely opted a contact out mid-conversation
// ("is that enough information", "how do i cancel the vet visit", Nguni
// pleasantries). Ambiguous words now require an explicit messaging OBJECT
// ("cancel messages", "genoeg boodskappe"); the unambiguous singles stay.
const STOP_KEYS = [
  'stop', 'unsubscribe', 'quit', 'leave me alone', 'go away',
  'remove me', 'opt out', 'optout',
  'stop msgs', 'stop sending', 'stop pls', 'i want stop',
  'cancel messages', 'stop messages', 'no more messages',
  // Unambiguous at any length (same class as 'stop messages' above): a
  // messaging-object phrase, not a bare 'stop' -- 'please stop messaging me'
  // was previously missed because 'stop' alone is ambiguous-gated to short
  // messages and no literal phrase covered the polite 4-word form.
  'stop messaging me', 'stop texting me', 'stop contacting me',
  'hou op', 'los my',                                          // af
  'genoeg boodskappe', 'hou op met boodskappe',                // af (messaging object)
  'yeka', 'misa imilayezo', 'yeka imilayezo',                  // zu
  'yeka oku', 'hamba',                                         // xh
  'khaotsa', 'khaotsa melaetsa', 'tigela melaetsa',            // st (Sesotho): stop / stop messages
  'emisa', 'emisa melaetsa',                                   // tn (Setswana): stop / stop messages
  'yima', 'yima ku rhumela',                                   // ts (Xitsonga): stop / stop sending
  'ima', 'litsha u vhona',                                     // ve (Tshivenda): stop
  'yekela', 'yekela imiyalezo',                                // ss (siSwati): stop / stop messages
  'yekela', 'yekela imilayezo',                                // nr (isiNdebele): stop / stop messages
]
const STOP_EXCLUDE = [
  'no stop', 'dont stop', 'do not stop', 'please dont stop', 'never stop',
  'bus stop',
  // 'stop' as an ordinary verb describing the animals'/disease's own state, not
  // an opt-out instruction: "will stop spreading", "stop this", "cant stop",
  // "stop the truck" all use 'stop' with a following object/continuation, the
  // opposite shape of a genuine "stop messaging me" imperative.
  'will stop', 'to stop', 'cant stop', 'cannot stop', 'could not stop',
  'stop this', 'stop that', 'stop it', 'stop spreading', 'stop the',
  // Nguni farewell pleasantry ("go well") -- 'hamba kahle' is a goodbye, never
  // an opt-out, and at two words it passes the short-message ambiguity gate.
  'hamba kahle',
]

// STOP keys that double as ordinary verbs/farewells in report language. Each
// fires only when the whole normalized message is at most AMBIGUOUS_MAX_WORDS
// tokens (see detectContactIntent) -- a genuine bare opt-out is a short
// imperative, while these words inside a longer sentence are almost always the
// animals'/farmer's story, not an instruction to casey. Unambiguous keys
// (unsubscribe, messaging-object phrases) are deliberately NOT in this set.
const AMBIGUOUS_STOP_KEYS = new Set(['stop', 'quit', 'yeka', 'hamba', 'go away', 'hou op', 'los my',
  'khaotsa', 'emisa', 'yima', 'ima', 'yekela',
  // 'yeka oku' (xh, "stop this") is a bare unqualified phrase, structurally
  // identical to the English 'stop this'/'stop that'/'stop it' that ARE
  // ambiguity-gated -- unlike its sibling messaging-object phrases in
  // STOP_KEYS ('yeka imilayezo' = "stop messages"), it carries no messaging
  // qualifier, so an animal-report sentence ending "...yeka oku" (stop this
  // [symptom/behavior]) would otherwise unconditionally opt the contact out.
  'yeka oku'])
const AMBIGUOUS_MAX_WORDS = 3

// HUMAN keys that double as ordinary report vocabulary ("the human gave it
// water", relaying who did what to the animal) -- 'human' alone is not a
// handoff request unless the whole message is short, same discipline as
// AMBIGUOUS_STOP_KEYS above. Multi-word/unambiguous keys (speak to, real
// person, ...) are deliberately NOT in this set and keep firing at any
// length. The bare SA-language single-word 'person' tokens below carry the
// SAME false-positive risk the bare English 'person' has (an ordinary answer
// to casey's own present_person prompt -- "umuntu ukhona nezinkomo", "a
// person is with the cattle" -- naming who is on-site), but unlike English
// 'person' (which has an 18-entry HUMAN_EXCLUDE guard, see below) these had
// ZERO exclude coverage: any report mentioning who is present in these
// languages unconditionally fired a handoff. Gating them here (short-message-
// only, same as 'human') is the safety-preserving fix -- the safety-critical
// concord-prefixed WHOLE forms this file's own header comment protects
// ('ngicela ukukhuluma nomuntu' etc.) are multi-word and untouched by this
// gate, so a genuine handoff request in any of these languages still fires
// at any length.
const AMBIGUOUS_HUMAN_KEYS = new Set(['human',
  'umuntu', 'umntu', 'umuntfu',          // zu/xh/ss bare 'person'
  'motho', 'mongwe',                     // st/tn bare 'person'/'someone'
  'munhu', 'muthu',                      // ts/ve bare 'person'
])

// Bare single-word tokens like 'someone'/'staff'/'manager'/'operator'/'agent' were
// removed: casey's own system prompt asks who is on-site with the animals, and
// ordinary answers ("someone from the family is here", "the manager said to call
// this number") were misclassified as a handoff request. 'person' stays (explicit
// "speak to a person" contract) but is guarded by the wider HUMAN_EXCLUDE below.
const HUMAN_KEYS = [
  'human', 'person', 'real person',
  'representative', 'speak to', 'talk to', 'call me',
  'real human',
  'mens', 'persoon', 'regte persoon',      // af
  // Nguni concord-prefixed WHOLE forms (listed literally, not a bare-prefix substring
  // match) so "ngicela ukukhuluma nomuntu" (I would like to speak with a person) fires
  // the handoff. Safety-critical: handoff must work in any language without a model.
  'umuntu', 'nomuntu', 'komuntu', 'abantu',   // zu
  'umntu', 'nomntu',                          // xh
  // siSwati/isiNdebele share the Nguni 'umuntu' (person) root with Zulu/Xhosa;
  // listed explicitly (not a substring match) for the same safety-critical reason.
  'umuntfu', 'nomuntfu',                      // ss
  // Sotho-Tswana group: 'motho' (person)
  'motho', 'le motho',                        // st
  'motho', 'le motho', 'mongwe',              // tn
  // Xitsonga/Tshivenda: 'munhu'/'muthu' (person)
  'munhu', 'na munhu',                        // ts
  'muthu', 'na muthu',                        // ve
]
const HUMAN_EXCLUDE = [
  'a person told me', 'person told me', 'someone told me', 'another person',
  'in person', 'no person', 'wrong person',
  'someone come', 'someone came', 'anyone coming', 'did someone',
  'a person is here', 'a person is looking after', 'there is a person',
  'the person looking after', 'person looking after the animals',
  'someone from the family', 'someone is here', 'someone is looking after',
  'the manager said', 'manager said to call', 'staff said',
  'operator said', 'operator here', 'operator on site',
  // "is there a person who" / "can i speak to a vet" describe a THIRD PARTY
  // the worker is asking about (the farmer, a vet), not a handoff request
  // directed at casey -- the opposite shape of "let me speak to a human".
  'a person who', 'is there a person', 'speak to a vet', 'talk to a vet',
  'speak to the vet', 'talk to the vet',
  // Relayed speech: "the owner said call me when the vet comes" is the worker
  // reporting what someone on site said, not asking casey for a person. A
  // direct "please call me back" (no relay marker) still fires.
  'said call me', 'said to call', 'told me to call', 'said i must call',
  'said i should call',
  // Answers to casey's own present_person/present_person_relation prompt
  // (hooks/prompt.js: "who is on-site with the animals") -- ordinary report
  // content naming who is with the animals right now, not a handoff request.
  // Live-witnessed false positive: "a person is with the cattle now" fired
  // 'human' and short-circuited the turn instead of recording the answer.
  'person is with', 'person feeding', 'person minding', 'person watching',
  'person taking care', 'person herding', 'a person now',
]

// RESUME set: the small multi-language "help" vocabulary that opts a STOPPED
// contact back in. The opt-out ack promises "Reply HELP any time" -- this is the
// matcher that honours it, so it must work model-down. For a live (not opted-out)
// contact a 'help' hit falls through to the agent turn.
const HELP_KEYS = [
  'help', 'hlp', 'help me', 'start', 'resume',
  'hulp',                    // af
  'usizo', 'thusa',          // zu / sotho-tswana
  'nceda', 'uncedo',         // xh
  'thusa', 'ntlhokomele',    // st (Sesotho): help
  'thusa', 'nthuse',         // tn (Setswana): help
  'ndzi pfune', 'pfuneka',   // ts (Xitsonga): help me / help
  'nthuse', 'thusa',         // ve (Tshivenda): help
  'ngisita', 'sita',         // ss (siSwati): help
  'ngisiza', 'siza',         // nr (isiNdebele): help
]

// STATUS/THANKS/GREETING keyword tables were removed with the pure-LLM strip: the
// model answers all of those itself. detectContactIntent keeps ONLY STOP_KEYS /
// HUMAN_KEYS (the two irreversible service controls that must fire
// deterministically in any language even model-down) plus the HELP_KEYS resume set.

// Lowercase, strip diacritics/emoji/punctuation, COLLAPSE any run of '?' to a
// single '?' token (so "???" is a help signal, not an unmatchable "???" token),
// collapse whitespace.
function normalizeIntentText(text) {
  const s = (text || '')
    .toString()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9?\s]/g, ' ')
    .replace(/\?+/g, ' ? ')
    .replace(/\s+/g, ' ')
    .trim()
  // Voice-to-text transcription commonly duplicates the immediately-preceding
  // word ("dont dont stop stop"). Collapse immediate consecutive duplicate
  // tokens BEFORE phrase/exclude matching runs, or a duplicated exclude phrase
  // fragment can mask a genuine adjacent stop phrase (or vice versa) -- this is
  // the one deterministic, model-independent safety layer per AGENTS.md, so it
  // must be robust to this specific, well-known ASR noise class. Narrow and
  // scoped: only removes an EXACT immediate repeat, never a general fuzzy match.
  return s.split(' ').filter((w, i, arr) => i === 0 || w !== arr[i - 1]).join(' ')
}

// Add a tag to a comma-separated tag string without duplicating it.
export function mergeTag(tags, tag) {
  const list = (tags || '').split(',').map(s => s.trim()).filter(Boolean)
  if (!list.includes(tag)) list.push(tag)
  return list.join(',')
}

// Inverse of mergeTag: remove a tag, leaving the rest intact and order-stable.
export function dropTag(tags, tag) {
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

// (The STATUS_STRINGS/plainStatus tables were removed: detectContactIntent never
// returns 'status' -- a status ask is the agent's job via case_get.)

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

// Build a clear, deterministic reply for a recognized intent. Every reply names
// the reference so a low-literacy farmer always has a handle on their report.
// Localised to the SA languages guessLang can return; `lang` comes from
// guessLang(inboundText) at the call site and falls through to English. Framed
// for a disease report (a team will look into it), no order/ticket language.
// Only the REACHABLE deterministic branches remain: stop (opt-out ack), human
// (handoff ack), and resume (the help-after-stop opt-back-in ack). Everything else
// (status/thanks/greeting) is the agent's job and its strings were removed.
const INTENT_STRINGS = {
  en: {
    stop: 'Okay, we will not message you again. Reply HELP any time if you change your mind.',
    human: 'Of course. We are asking a person from the team to help you now. They will reply right here as soon as they can.',
    resume: 'Welcome back. We are here to help again. Just tell us what you are seeing with the animals.',
    refLabel: (r) => ` Your reference is ${r}.`,
  },
  af: {
    stop: 'Goed, ons sal u nie weer boodskap nie. Antwoord HELP enige tyd as u van plan verander.',
    human: 'Natuurlik. Ons vra nou iemand van die span om u te help. Hulle sal hier antwoord sodra hulle kan.',
    resume: 'Welkom terug. Ons is weer hier om te help. Se net vir ons wat u by die diere sien.',
    refLabel: (r) => ` U verwysing is ${r}.`,
  },
  zu: {
    stop: 'Kulungile, ngeke siphinde sikuthumelele. Phendula u-HELP noma nini uma ushintsha umqondo.',
    human: 'Impela. Sicela umuntu wethimba ukuthi akusize manje. Uzophendula lapha ngokushesha angakwazi.',
    resume: 'Siyakwamukela futhi. Silapha ukukusiza futhi. Sitshele nje ukuthi ubonani ezilwaneni.',
    refLabel: (r) => ` Inombolo yakho yereferensi ngu-${r}.`,
  },
  xh: {
    stop: 'Kulungile, asisayi kuphinda sikuthumelele. Phendula u-HELP nanini na ukuba uyaguqula ingqondo.',
    human: 'Ewe kakhulu. Sicela umntu weqela ukuba akuncede ngoku. Uya kuphendula apha kamsinya.',
    resume: 'Wamkelekile kwakhona. Silapha ukukunceda kwakhona. Sixelele nje ukuba ubona ntoni kwizilwanyana.',
    refLabel: (r) => ` Inombolo yakho yesalathiso ngu-${r}.`,
  },
  st: {
    stop: 'Ho lokile, re ke ke ra boela ra u romella melaetsa. Araba HELP neng kapa neng ha u fetola maikutlo.',
    human: 'Ho lokile. Re kopa motho wa sehlopha ho u thusa hona joale. O tla araba mona ha a khona.',
    resume: 'Rea u amohela hape. Re teng ho thusa hape. Re bolelle feela seo u se bonang liphoofolong.',
    refLabel: (r) => ` Nomoro ya hao ya tshupiso ke ${r}.`,
  },
  tn: {
    stop: 'Go siame, ga re kitla re tsweletsa go go romela melaetsa. Araba HELP nako nngwe le nngwe fa o fetotse maikutlo.',
    human: 'Go siame. Re kopa motho wa setlhopha go go thusa jaanong. O tla araba fano fa a kgona.',
    resume: 'Re a go amogela gape. Re fano go go thusa gape. Re bolelele fela se o se bonang mo diphologolong.',
    refLabel: (r) => ` Nomoro ya gago ya tshupetso ke ${r}.`,
  },
}

export function intentReply(intent, caseRow, lang = 'en') {
  const L = INTENT_STRINGS[lang] || INTENT_STRINGS.en
  const ref = caseRow?.ref ? L.refLabel(caseRow.ref) : ''
  const body = L[intent]
  return body ? `${body}${ref}` : ''
}
