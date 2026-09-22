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
import { recordDegradedTurn, FAILURE_REASONS } from '../degraded-turns.js'

// A turn that reaches the post-loop with empty text spent its whole genuine
// retry budget (attempts x hard deadline). Never send a raw error string to the
// contact: USER DIRECTIVE, no fallback text -- record loudly instead.
// ONE data.degraded_turn MARKER PER DEGRADED TURN, written here and nowhere else
// on this path. The marker is not a log line, it is a COUNTED row: both
// degraded-turns.js's calculateDegradationRate (the /api/health degradation
// percentage) and GET /api/turns/degraded (operations.js) take each marker to BE
// one degraded turn, against a denominator of one TURN-START per turn. This
// function used to stamp the marker on its own two diagnostic rows AND
// hooks/delivery.js's sendGuaranteedFallback then called recordDegradedTurn for a
// third, so a single timed-out turn counted three times: live-witnessed at 9
// degraded / 33 turns = 27.27% for 3 real failures out of 33 (the true 9.09%),
// with each failure listed three times in the operator's degraded-turns view. A
// health metric that triples its own numerator is worse than no metric -- it
// reports a broken backend to an operator whose backend is fine, and the rate can
// exceed 100%.
//
// So the two rows below keep their prose and their detail but NOT the marker, and
// the single marker is delegated to degraded-turns.js's recordDegradedTurn -- the
// canonical writer named in that module's own header, which validates the reason
// against FAILURE_REASONS and carries the contact_id/turn_ts the operator view
// needs. This function runs on EVERY degraded path (hooks/inbound-turn.js calls it
// under the one `isFallback` gate, before the background-redrive and
// queuedRedrive branches return), which is why the marker belongs here and not in
// the live-only fallback sender.
export async function recordDegradedOutcome({ store, log, fresh, result, errored, degradedReason, contactId, turnStartedAt, channel }) {
  if (!errored && result?.error) {
    log.error?.('[casey] agent returned error result', { caseId: fresh.id, error: result.error })
    await store.appendEvent(fresh.id, observation(`agent result error: ${result.error}`, { turn_error: String(result.error).slice(0, 500) }))
  }
  log.error?.('[casey] degraded turn produced no reply', { caseId: fresh.id })
  await store.appendEvent(fresh.id, observation('degraded turn (empty/error/echo/stock-ack/repeat); no reply sent.'))
  // The classification that used to live at the fallback sender, moved with the
  // marker so the reason an operator reads is still the specific one
  // (timeout/provider from the attempt loop, llm-refusal for a result the model
  // returned as an error, retry-exhausted otherwise) rather than a bare "empty".
  await recordDegradedTurn(store, {
    caseId: fresh.id,
    contactId: contactId || fresh.contact_id,
    reason: degradedReason || (!errored && result?.error ? FAILURE_REASONS.LLM_REFUSAL : FAILURE_REASONS.RETRY_EXHAUSTED),
    turnStartMs: turnStartedAt,
    channel,
    error: !errored && result?.error ? String(result.error).slice(0, 500) : null,
  })
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
//
// A DEGRADED TURN THAT RECORDED NOTHING MAY NOT ADVANCE THE CASE, which is what
// the paragraph above already says ("a real report has landed and a reply is going
// out", "skipped for the content-free social/empty turns") and what the call site
// did not enforce: hooks/inbound-turn.js called this unconditionally, ABOVE its own
// `isFallback` branch, so a turn that burned its whole hard-deadline budget,
// recorded no report at all and said only "Sorry, I'm having trouble right now"
// still moved the case out of `new` with the audited reason "first report received
// (auto)". Live-witnessed on a timed-out Discord turn: report null, no action event,
// and a transition row asserting a first report had been received. On an
// append-only audited timeline for animal-disease reports, a stage change carrying
// a reason that did not happen is not a cosmetic problem -- and the case then reads
// as past intake in the operator pipeline while holding nothing.
//
// The two admissible warrants are passed in explicitly rather than re-derived here,
// because only the caller knows whether a real reply is about to be sent:
//   reportLanded  -- the post-turn row actually carries a report (so the stage
//                    change is true even if the reply itself was blanked/held)
//   replySending  -- a real agent reply is going out (not the guaranteed fallback)
// Either one warrants the advance; neither means nothing observable happened.
export async function advanceIntake({ store, log, fresh, inboundText, media, reportLanded, replySending }) {
  if (!reportLanded && !replySending) return
  const latest = await store.getCase(fresh.id).catch(() => fresh)
  if (!latest || latest.status !== 'new' || !(inboundText || media)) return
  try { await store.transition(fresh.id, 'triaging', { reason: 'first report received (auto)' }) }
  catch (e) { log.warn?.('[casey] intake auto-transition failed', { caseId: fresh.id, error: e.message }) }
}
