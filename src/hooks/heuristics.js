// hooks/heuristics.js -- pure-text heuristics used by casey's inbound handler.
//
// Everything here is a pure function over strings/const tables: no I/O, no
// store access. Keep it that way -- callers rely on being able to run these
// synchronously anywhere in the turn.

import { tagList } from '../timestamp.js'

// The STOP/opt-out control's tag -- an irreversible-until-HELP legal control
// (see AGENTS.md's Security invariants), so every reader/writer of it must
// agree on the exact literal. Import this constant rather than retyping the
// string.
export const OPTED_OUT_TAG = 'opted-out'
// Tags the system owns (opt-out, hand-off, draft and health flags, intake mode):
// no team member's hand -- WhatsApp tool or dashboard field login -- adds, drops
// or rewrites one. Clearing 'opted-out' by editing tags would undo a STOP.
export const RESERVED_TAG = /^(opted-out|needs-human|draft-pending|ai-offline|flagged-reply|dispatch-suggested|handed-off|health:|intake_mode:)/i

// Shared truncate helper.
export function truncate(s, n) { s = s || ''; return s.length > n ? s.slice(0, n - 1) + '...' : s }

// A reasoning-family model's raw <think>...</think> block reaches casey
// verbatim whenever the provider does not strip it server-side, prefixing the
// genuine reply with leaked internal reasoning that must never reach a
// contact. Distinct from the reply judge's META-COMMENTARY / PLANNING
// NARRATION shape (hooks/reply-judge.js), which catches planning narration
// REPLACING the reply; here the real reply is present and intact.
// Must run BEFORE any other outbound check (hooks/turn-attempts.js) so the reply judge
// only ever sees the real intended reply, never the reasoning noise.
// Strips every <think>...</think> pair anywhere in the text (a leaked block
// is not guaranteed to be a clean prefix) plus any leftover unclosed <think>
// and everything after it (a response truncated mid-reasoning would otherwise
// leave a dangling open tag in contact-facing text). Case-insensitive: a
// model is not guaranteed to emit lowercase tags consistently.
export function stripThinkingBlock(text) {
  if (!text) return text
  let out = String(text).replace(/<think>[\s\S]*?<\/think>/gi, '')
  out = out.replace(/<think>[\s\S]*$/i, '')
  return out.trim()
}

// A reference number is a real datum -- the only token in a reply the contact
// may quote back to find their case, and a weak model will recite a memorized
// stock reply carrying a STALE or wholly HALLUCINATED ref. So before any reply
// is sent OR held as a draft, every case-ref-shaped token that is not this
// case's real ref is rewritten to the real ref. Deterministic, ASCII, no model
// in the loop -- the contact can never be handed a fabricated reference.
// Returns { text, corrected:[wrong refs] }. The pattern is exported so other
// text (raw tool-call results) can be scanned for the same ref shape without
// duplicating it.
export const CASE_REF_RE = /CASE-\d+-[a-z0-9]+/gi

// extraAllowedRefs: real refs the agent legitimately learned THIS turn via a
// tool call (case_list/case_mine/case_today/case_get/case_link_suggestions --
// the enquiry surface that answers "my cases"/"any cases near X" by citing
// OTHER cases' real refs). Without it a genuinely-different, tool-returned ref
// is indistinguishable from a hallucinated one and gets rewritten to THIS
// case's own ref, corrupting every multi-case enquiry answer into a wrong case
// number. Case-insensitive, matching the realRef comparison.
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

// USER DIRECTIVE: no deterministic text classification anywhere. There is no
// isStockAck, isToolRefusal, isMetaCommentary or jargonHits here, and none may
// be reintroduced. All of that judgment -- prompt echo, stock ack, tool
// refusal, meta-commentary, jargon leaks -- is a single real LLM call,
// hooks/reply-judge.js's judgeReply (see its own header for the reasoning),
// whose verdict turn-attempts.js branches on: retry on a genuine miss, and a
// jargon-only verdict routed to the draft-hold-for-human path.


// USER DIRECTIVE: no hardcoded language handling anywhere. There is no
// guessLang (a per-language word/phrase-cue scoring table) and no
// INTENT_STRINGS/intentReply canned-per-language-string pair, and neither may
// come back to let a STOP/HUMAN/resume acknowledgement "still work" in a
// guessed language with the LLM down. That case must fail loudly instead: the
// STOP/HUMAN/resume STATE CHANGE (the legal opt-out/handoff control) stays
// deterministic and unconditional, but the acknowledgement TEXT is composed by
// the same real-LLM agent turn every other reply uses, and logs loud + sends
// nothing when the LLM is unreachable -- matching the LLM-down queue gate's
// no-fallback discipline rather than carrying a hardcoded-language exception.

// USER DIRECTIVE: no mocks/fallbacks/stubs -- only singular working mechanisms
// and loud errors. A degraded turn (model error/timeout/empty/echo/stock-ack/
// repeat) composes no warm holding reply; there is no fallbackReply() and none
// may be added. The caller sends NOTHING to the contact on a degraded turn and
// logs/records the failure loudly instead (the degraded-turn branch in
// makeCaseHandler). The reliability fix is upstream: the in-process acptoapi
// bridge (freddie) is the mechanism that must actually work, not a scripted
// apology for when it doesn't.

// Strip channel mention/markup tokens a chat platform injects when a contact
// addresses the bot: on Discord "@memobot hello" arrives as msg.content
// "<@BOTID> hello", and the bare numeric snowflake id inside the mention reads
// as report content (a count) to whatever consumes the text next, so a
// content-free greeting stops looking content-free. Strips Discord-style
// user/role/channel mentions (<@id>, <@!id>, <@&id>, <#id>), custom-emoji
// tokens (<:name:id> / <a:name:id>), and a leading bare "@name" handle, for
// the text that drives intent/replies. The raw inbound is still recorded
// verbatim in the event log for audit -- only the reasoning copy is cleaned.
// Returns the trimmed, collapsed remainder.
export function stripChannelMarkup(text) {
  return (text || '')
    .replace(/<a?:\w+:\d+>/g, ' ')        // custom emoji <:name:id> / <a:name:id>
    .replace(/<[@#][!&]?\d+>/g, ' ')      // <@id> <@!id> <@&id> <#id>
    .replace(/^\s*@[\w.-]+\b/, ' ')       // a leading bare @handle (e.g. "@memobot")
    .replace(/\s+/g, ' ')
    .trim()
}

// Contact intent detection -- the bare universal minimum.
//
// Returns 'stop' | 'help' | null. Language handling is the AGENT's job: a STOP in
// isiXhosa, isiZulu, Afrikaans, Sesotho or any phrasing, and a request for a
// person, are read by the model, which calls case_stop / case_handoff (both are
// REPORT_ONLY_TOOLS, so reachable at every tier). The bot never contacts anyone
// first, so an opt-out the agent handles a moment later -- or after an LLM outage,
// when the queued message is re-driven -- causes no extra message. All that stays
// here is the two whole-message English words every messaging service treats as
// universal: 'stop' (opt out) and 'help' (an opted-out contact opts back in; for a
// live contact it falls through to the agent). There are no per-language tables,
// no exclude lists and no negation guards: a whole-message equality needs none.
// Because the equality is on the WHOLE message, a team member's "wrong one, stop"
// never matches, so the team tier needs no rule of its own here.
export function detectContactIntent(text) {
  const t = normalizeIntentText(text)
  if (t === 'stop') return 'stop'
  if (t === 'help') return 'help'
  return null
}

// Lowercase, strip diacritics/emoji/punctuation, collapse whitespace.
function normalizeIntentText(text) {
  return (text || '')
    .toString()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Add a tag to a comma-separated tag string without duplicating it.
export function mergeTag(tags, tag) {
  const list = tagList({ tags })
  if (!list.includes(tag)) list.push(tag)
  return list.join(',')
}

// Inverse of mergeTag: remove one or more tags, leaving the rest intact and
// order-stable. Variadic because the dashboard's draft/reply paths clear
// 'draft-pending' and 'needs-human' together in one write.
export function dropTag(tags, ...names) {
  return tagList({ tags }).filter(t => !names.includes(t)).join(',')
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

// There is deliberately no STATUS_STRINGS/plainStatus table: detectContactIntent
// never returns 'status' -- a status ask is the agent's job via case_get.

// Proactive, contact-safe note sent when a case MOVES to a new stage on an
// OPERATOR's action (hooks/notifiers.js sends this text verbatim over the
// contact's own channel). Internal stages (new, triaging) and closed return ''
// and are not sent:
// - new/triaging are internal review steps the contact need not hear about.
// - closed is silent because `resolved` already told them it is done; an
//     operator moving resolved->closed seconds later would otherwise double-send.
//
// These three strings are the ONLY words casey puts in front of a reporter
// without the model composing them, so every rule the prompt holds the model to
// has to hold here too, and nothing downstream checks them:
// - No helpdesk vocabulary. "your request" is casey's demo domain talking; the
//   person messaging reported dying animals, not filed a request. Say what they
//   did ("what you sent us") rather than naming an entity at all, which also
//   keeps this string correct under every deployment's own entity_label.
// - No stage names. "in progress" is the literal `in_progress` enum leaking to
//   the person, in the same breath the prompt forbids the model that vocabulary.
// - No promise. "We will be in touch" is a guaranteed outcome the reply-style
//   rules forbid the model from making, and casey has no mechanism behind it.
// - No corporate opener. "A quick update:" and a repeated "Good news." read as a
//   template, and "Good news, your request is sorted" is the wrong register
//   entirely when the outcome was a dead herd.
// - Plain, short, one idea per sentence, ASCII, no dashes-as-punctuation.
// Known and NOT fixed here: these are English only and are sent whatever
// language the person has been writing in. Fixing that needs the real LLM turn
// (AGENTS.md forbids a hardcoded per-language template anywhere in this repo),
// and this path deliberately does not run one.
export function stageNote(status) {
  return ({
    in_progress: 'Someone is looking at what you sent us now.',
    waiting:     'We are still busy with what you sent us. There is nothing you need to do for now.',
    resolved:    'What you sent us has been dealt with. If something is still wrong, just reply here.',
  })[status] || ''
}

// There is deliberately no INTENT_STRINGS/intentReply per-language canned-string
// table for the STOP/HUMAN/resume acknowledgement -- see the no-hardcoded-
// language USER DIRECTIVE above. That acknowledgement is composed by the same
// real-LLM agent turn every other reply uses.
