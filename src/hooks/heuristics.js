// hooks/heuristics.js -- pure-text heuristics used by casey's inbound handler.
//
// Split out of gateway-hooks.js (see AGENTS.md's Source map for the file's
// role). These are deliberately pure functions over strings/const tables --
// no I/O, no store access -- so they are independently readable/reviewable
// and safe to unit-reason about in isolation. Behavior is byte-identical to
// the original gateway-hooks.js; only the physical location moved.

import { tagList } from '../timestamp.js'

// The STOP/opt-out control's tag -- an irreversible-until-HELP legal control
// (see AGENTS.md's Security invariants), so every reader/writer of it must
// agree on the exact literal. Single source of truth instead of the string
// retyped independently at each call site.
export const OPTED_OUT_TAG = 'opted-out'

// Shared truncate helper -- also used by prompt.js, media.js, and handler.js.
export function truncate(s, n) { s = s || ''; return s.length > n ? s.slice(0, n - 1) + '...' : s }

// Live-witnessed (bin/selftest.js real turn, extra-0/minimax-m3 -- a
// "thinking"/reasoning-family model behind casey's own extra-providers
// aggregator): the model's raw response was its own <think>...</think>
// reasoning block, verbatim, immediately followed by the real intended
// reply -- "<think>\nThe person sent \"hi there\"...\n</think>\nHello!
// Welcome...". Distinct from the reply judge's META-COMMENTARY / PLANNING
// NARRATION shape (hooks/reply-judge.js, which catches a model's planning
// narration replacing the reply entirely, no real content left) -- here the
// genuine, correct reply IS present, just prefixed with a large,
// structurally-delimited block of leaked internal reasoning that must never
// reach a contact. Some providers strip a model's <think> tags server-side
// before returning content (the documented, expected behavior); others --
// confirmed live -- pass them through raw when the caller does not
// explicitly separate a reasoning channel. Applied BEFORE any other outbound
// check (handler.js) so the reply judge only ever sees the real intended
// reply, never the reasoning noise around it. Strips any
// <think>...</think> pair anywhere in the text (a leaked block is not
// guaranteed to be a clean prefix -- safer to remove every occurrence
// than assume one specific position) and any leftover unclosed <think>
// tag with everything after it (a truncated response cut off mid-
// reasoning, which would otherwise leave a dangling open tag in the
// contact-facing text). Case-insensitive, since a model is not guaranteed
// to emit lowercase tags consistently.
export function stripThinkingBlock(text) {
  if (!text) return text
  let out = String(text).replace(/<think>[\s\S]*?<\/think>/gi, '')
  out = out.replace(/<think>[\s\S]*$/i, '')
  return out.trim()
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

// USER DIRECTIVE: no deterministic text classification anywhere -- the
// former isStockAck, isToolRefusal, isMetaCommentary, and jargonHits
// functions (each a regex/word-list hand-written to catch ONE specific real
// leak shape found on live Discord traffic, one session at a time) have been
// removed. All of that judgment -- prompt echo, stock ack, tool refusal,
// meta-commentary, and jargon leaks -- is now done by a single real LLM call,
// hooks/reply-judge.js's judgeReply, which judges the actual composed reply
// text against all of those same real failure shapes at once (plus anything
// a hardcoded pattern list could never anticipate). See reply-judge.js's own
// header comment for the full reasoning; see hooks/handler.js for the two
// call sites (the retry-on-genuine-miss check, and the final outbound gate,
// which routes a jargon-only verdict to the same draft-hold-for-human path
// this file's old jargonHits gate used).


// USER DIRECTIVE: no hardcoded language handling anywhere -- guessLang (a
// deterministic per-language word/phrase-cue scoring table) and the
// INTENT_STRINGS/intentReply canned-per-language-string pair further below
// were removed. They existed only to let the STOP/HUMAN/resume deterministic
// acknowledgement "still work" (in a guessed language) even with the LLM
// fully down. Per explicit user directive, that must instead fail loudly --
// the STOP/HUMAN/resume STATE CHANGE (the actual legal opt-out/handoff
// control) stays fully deterministic and unconditional in handler.js, but
// the acknowledgement TEXT is now composed by the same real-LLM agent turn
// every other reply uses, and logs loud + sends nothing when the LLM is
// unreachable, matching the LLM-down queue gate's existing no-fallback
// discipline instead of carrying its own hardcoded-language exception.

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
  const list = tagList({ tags })
  if (!list.includes(tag)) list.push(tag)
  return list.join(',')
}

// Inverse of mergeTag: remove a tag, leaving the rest intact and order-stable.
export function dropTag(tags, tag) {
  return tagList({ tags }).filter(t => t !== tag).join(',')
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

// INTENT_STRINGS/intentReply (a per-language canned-string table for the
// STOP/HUMAN/resume acknowledgement) removed -- see the USER DIRECTIVE
// comment above guessLang's former location. handler.js now composes that
// acknowledgement via the same real-LLM agent turn every other reply uses.
