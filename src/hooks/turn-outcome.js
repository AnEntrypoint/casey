// hooks/turn-outcome.js -- what hooks/handler.js decides AFTER the agent turn
// and BEFORE anything is delivered: recording a degraded turn, correcting a
// fabricated case reference, clearing/raising the ai-offline signal, holding a
// reply for a human, and the deterministic intake advance.
//
// Nothing here talks to an adapter. Delivery lives in hooks/delivery.js.

import { observation, flagNeedsHuman } from './case-writes.js'
import { sanitizeOutboundRef, mergeTag, dropTag, canAgentAct } from './heuristics.js'
import { toolCaseRefs } from './turn-results.js'
import { tagList } from '../timestamp.js'

// A turn that reaches the post-loop with empty text spent its whole genuine
// retry budget (attempts x hard deadline). Never send a raw error string to the
// contact: USER DIRECTIVE, no fallback text -- record loudly instead.
export async function recordDegradedOutcome({ store, log, fresh, result, errored }) {
  if (!errored && result?.error) {
    log.error?.('[casey] agent returned error result', { caseId: fresh.id, error: result.error })
    // Structured data.degraded_turn marker, not just free-form text: a
    // cross-case aggregate query (GET /api/turns/degraded, operations.js) has to
    // find every degraded turn across the whole system without already knowing
    // which case to look at, and prose alone is queryable only by fragile
    // substring matching.
    await store.appendEvent(fresh.id, observation(`agent result error: ${result.error}`, { degraded_turn: true, reason: 'error', error: String(result.error).slice(0, 500) }))
  }
  log.error?.('[casey] degraded turn produced no reply', { caseId: fresh.id })
  await store.appendEvent(fresh.id, observation('degraded turn (empty/error/echo/stock-ack/repeat); no reply sent.', { degraded_turn: true, reason: 'empty' }))
  // Plain (non-health-sweep) tag, read synchronously by attn.js alongside every
  // other tag-based signal -- a case with a prior degraded turn is a priori more
  // likely to degrade again (context corruption, a stuck conversation), so the
  // inbox nudges it up before a second failure compounds. It stays a plain
  // case.tags entry, NOT a case-health.js ALL_HEALTH_TAGS member, because it is
  // a per-turn event fact rather than a periodic sweep classification --
  // rankAttention reads case.tags directly with no event fetch, keeping the
  // dashboard poll cheap.
  try { await store.updateCase(fresh.id, { tags: mergeTag(fresh.tags, 'degraded-turn-seen') }) }
  catch (e) { log.warn?.('[casey] degraded-turn-seen tag failed', { caseId: fresh.id, error: e.message }) }
}

// Final guard before the reply leaves (send OR assisted draft): correct any
// fabricated/stale case reference to this case's real ref. A weak model recites
// a memorized stock reply carrying the wrong ref; the contact must never be
// handed a reference that does not resolve to their case. BUT an enquiry turn
// (case_list/case_mine/case_today/case_get/case_link_suggestions) legitimately
// cites OTHER cases' real refs per AGENTS.md's enquiry-surface design -- every
// ref that actually came back from a tool call this turn is real, not
// hallucinated, and must pass through unmodified. toolCaseRefs() collects those;
// see turn-results.js for why it scans the raw tool-message content rather than
// each tool's own result shape.
export async function correctOutboundRef({ store, fresh, text, result }) {
  const { text: safeText, corrected } = sanitizeOutboundRef(text, fresh.ref, toolCaseRefs(result))
  if (!corrected.length) return text
  await store.appendEvent(fresh.id, observation(`REF-CORRECTED: model emitted ${corrected.join(', ')}; rewrote to real ref ${fresh.ref}.`))
  return safeText
}

// A genuinely non-degraded turn (the model produced real, usable content) proves
// the AI is back online RIGHT NOW, independent of whether that content ends up
// held for jargon or assisted-mode approval. The caller must run this AHEAD of
// both hold gates: below either of them, a successful-but-held reply never
// reaches the clear at all and a stale ai-offline tag sits in the operator's
// offline queue while the AI is healthy.
export async function clearAiOffline({ store, log, fresh }) {
  if (!tagList(fresh).includes('ai-offline')) return
  try { await store.updateCase(fresh.id, { tags: dropTag(fresh.tags, 'ai-offline') }) }
  catch (e) { log.warn?.('[casey] ai-offline clear failed', { caseId: fresh.id, error: e.message }) }
}

// AI-offline queue: when a turn is DEGRADED -- the agent turn itself failed
// (model error/timeout), or it "succeeded" but produced unusable text -- the
// contact gets nothing real sent, so a human needs a way to notice this
// silently-unanswered message. Tag the case 'ai-offline' so it surfaces in the
// operator's offline queue (GET /api/unreplied) and on the case list. The next
// operator reply clears it (claim-on-reply untags it), and a later successful
// agent turn does too, via clearAiOffline above. Best-effort: a tag failure must
// never block the reply.
export async function tagAiOffline({ store, log, fresh }) {
  try { await store.updateCase(fresh.id, { tags: mergeTag(fresh.tags, 'ai-offline') }) }
  catch (e) { log.warn?.('[casey] ai-offline tag failed', { caseId: fresh.id, error: e.message }) }
}

// The two draft holds, in the order they must fire. Returns a finished reply
// when the text is withheld, else null.
//
// PRE-SEND JARGON / FALSE-CONFIRMATION GUARD: a reply the judge flagged as a
// jargon-only leak, or as claiming a write that never happened, is NOT sent. It
// is held as a draft for a human exactly like assisted mode. This fires in ANY
// autonomy mode (the leak is a content defect, not a mode choice) and runs
// before the assisted-mode branch so a jargon hit holds even in auto mode. USER
// DIRECTIVE: no deterministic text classification -- the reasons come from the
// real-LLM judge (hooks/reply-judge.js), never a regex/word-list scan.
//
// ASSISTED mode is a real delivery gate, not a label: the agent composed a
// reply, but a human must approve before anything reaches the contact. Both
// paths return empty text so the gateway sends nothing and the contact waits on
// a human-approved reply; the dashboard surfaces the draft for one-click
// approve/discard.
export async function holdReplyForHuman({
  store, log, fresh, notifyHandoff, msg, channel, replyTo, platform,
  text, isFallback, jargonReasons, falseConfirmReasons,
}) {
  if (jargonReasons || falseConfirmReasons) {
    const heldReasons = jargonReasons || falseConfirmReasons
    const marker = jargonReasons ? 'JARGON-HELD' : 'FALSE-CONFIRMATION-HELD'
    const holdNote = jargonReasons
      ? `${marker}: reply withheld -- ${heldReasons.join('; ')}; held for a human to reword plainly.`
      : `${marker}: reply withheld -- ${heldReasons.join('; ')}; the reply claims something was recorded but no write actually succeeded this turn; held for a human to check and reword.`
    await store.appendEvent(fresh.id, observation(holdNote))
    await store.appendEvent(fresh.id, {
      kind: 'draft', actor: 'agent', channel,
      text, data: { to: replyTo, fallback: isFallback, draft: true, jargon: jargonReasons, falseConfirmation: falseConfirmReasons },
    })
    await flagNeedsHuman({ store, log, caseRow: fresh, notifyHandoff, channel, from: msg.from, extraTags: ['draft-pending'], flagLabel: 'reply-hold', notifyLabel: 'reply-hold' })
    return { to: replyTo, text: '', platform, caseId: fresh.id, drafted: true, jargonHeld: jargonReasons, falseConfirmationHeld: falseConfirmReasons }
  }
  if (canAgentAct(fresh, 'reply') === 'draft') {
    await store.appendEvent(fresh.id, {
      kind: 'draft', actor: 'agent', channel,
      text, data: { to: replyTo, fallback: isFallback, draft: true },
    })
    await flagNeedsHuman({ store, log, caseRow: fresh, notifyHandoff, channel, from: msg.from, extraTags: ['draft-pending'], flagLabel: 'assisted draft', notifyLabel: 'assisted draft' })
    return { to: replyTo, text: '', platform, caseId: fresh.id, drafted: true }
  }
  return null
}

// Deterministic intake advance: a substantive inbound on a brand-new case means
// the case is observably past "new" -- a real report has landed and a reply is
// going out. The agent turn is SUPPOSED to call case_transition, but a
// content-only model rarely emits tool calls, so relying on the LLM makes the
// first stage change flaky. Move new->triaging here, deterministically, BEFORE
// recording the outbound. It is a no-op if the agent already moved the case
// (transition() returns early on an equal stage) and is skipped for the
// content-free social/empty turns (those never reach a substantive reply with a
// recorded report). Best-effort: a transition failure must never block the
// reply. Observe mode returned far earlier, so acting here is always permitted.
export async function advanceIntake({ store, log, fresh, inboundText, media }) {
  const latest = await store.getCase(fresh.id).catch(() => fresh)
  if (!latest || latest.status !== 'new' || !(inboundText || media)) return
  try { await store.transition(fresh.id, 'triaging', { reason: 'first report received (auto)' }) }
  catch (e) { log.warn?.('[casey] intake auto-transition failed', { caseId: fresh.id, error: e.message }) }
}
