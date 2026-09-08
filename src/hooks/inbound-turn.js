// hooks/inbound-turn.js -- one inbound turn, start to finish, with the
// per-contact claim already held by hooks/handler.js's wrapper.
//
// Two functions, split where the turn itself begins. runInboundTurn owns
// everything up to and including the pre-turn gates -- admission, case
// resolution, the intake writes, the irreversible service controls, observe
// mode, the LLM-down queue. driveAgentTurn owns the TURN-START marker onward --
// the agent turn, the post-turn decisions, and delivery. Neither composes
// contact-facing text of its own; the ONE sanctioned status message is
// hooks/delivery.js's guaranteed fallback.
//
// `receiver` is the Casey instance the handler is bound to, threaded through
// explicitly rather than as `this` so this module has no binding contract of its
// own: the only thing read off it is the outbound adapter.

import { observation } from './case-writes.js'
import {
  checkAdmission, openCaseForInbound, applyInboundSideEffects,
  applyPreTurnControls, llmDownQueueGate,
} from './case-intake.js'
import { runAgentTurn } from './turn-attempts.js'
import {
  recordDegradedOutcome, correctOutboundRef, clearAiOffline, tagAiOffline,
  holdReplyForHuman, advanceIntake,
} from './turn-outcome.js'
import { resolveAdapter, sendGuaranteedFallback, sendAgentReply } from './delivery.js'
import { makeTypingIndicator } from './typing.js'

export async function runInboundTurn(receiver, deps, { platform, msg, channel, external_id, replyTo }) {
  const { store, log, admission, autoRespond, llmStatus, notifyHandoff } = deps
  const adapter = resolveAdapter(receiver, platform)
  const denied = checkAdmission({ admission, store, log, msg, channel, external_id, replyTo, platform })
  if (denied) return denied

  const opened = await openCaseForInbound({ store, log, msg, channel, external_id, replyTo, platform })
  if (opened.done) return opened.done
  const { caseRow, created, inboundText, media, msgId } = opened
  await applyInboundSideEffects({ store, log, caseRow, created, msg, channel, inboundText, media })
  if (!autoRespond) return { to: replyTo, text: '', platform, caseId: caseRow.id }

  // Guarded: unguarded, a transient store error here silently drops the whole
  // agent turn with no explicit error response. The case row from
  // findOrCreateCase is a fine fallback -- only slightly staler -- and a
  // genuinely broken store fails again on the very next real call in this turn,
  // surfacing loudly there instead of vanishing here.
  let fresh
  try { fresh = await store.getCase(caseRow.id) }
  catch (e) {
    log.warn?.('[casey] getCase(fresh) failed; continuing with the pre-turn case snapshot', { caseId: caseRow.id, error: e.message })
    fresh = caseRow
  }

  const controlled = await applyPreTurnControls({ store, log, llmStatus, notifyHandoff, fresh, inboundText, channel, msg, replyTo, platform })
  if (controlled) return controlled

  // Everything else -- status, help, greeting, thanks, enquiry, report, field
  // extraction, the whole conversation -- is the AGENT'S job. No deterministic
  // pre-route: the message goes straight into the runTurn tool loop, where the
  // model classifies and acts by calling the case tools. Never add a
  // keyword/shape router or a STATUS-BY-REF short-circuit back: the soft
  // dead-end stays structurally impossible only while the agent, not a phrase
  // maze, decides the reply.
  const contact = fresh.contact_id ? await store.getContact(fresh.contact_id).catch(() => null) : null
  const events = await store.listEvents(fresh.id)
  const prompt = inboundText || (media ? `The contact sent ${media} with no text. Acknowledge and ask how you can help.` : 'The contact sent an empty message. Acknowledge politely.')

  const queued = await llmDownQueueGate({ store, log, llmStatus, fresh, events, msg, msgId, replyTo, platform })
  if (queued) return queued

  // The buffered turn's own case-scoped audit note, logged once there is a real
  // case row to attach it to. The concurrency gate itself fired long before
  // this, at handleInboundOnce's entry.
  if (msg.burstReplay) {
    await store.appendEvent(fresh.id, observation('concurrent turn skipped: prior LLM turn still in-flight for this contact; buffered for replay'))
  }

  return await driveAgentTurn(deps, {
    adapter, fresh, contact, events, prompt, inboundText, media,
    msg, msgId, channel, external_id, replyTo, platform,
  })
}

async function driveAgentTurn(deps, {
  adapter, fresh, contact, events, prompt, inboundText, media,
  msg, msgId, channel, external_id, replyTo, platform,
}) {
  const { store, log, callLLM, notifyHandoff } = deps
  // Durable turn-lifecycle marker: record that an agent turn STARTED for this
  // inbound (keyed by msgId) as an append-only observation, BEFORE the LLM call.
  // If the process crashes/reloads between here and the outbound below, the boot
  // resume sweep (resumePendingTurns) finds an inbound with a TURN-START but no
  // following outbound/draft and re-drives it exactly once -- so a contact whose
  // message arrived mid-crash still gets a reply instead of waiting forever.
  // Completion is detected positionally (a later outbound/draft), so no separate
  // TURN-DONE marker is needed; the outbound IS the completion witness.
  try { await store.appendEvent(fresh.id, observation(`TURN-START:${msgId}`)) }
  catch (e) { log.warn?.('[casey] turn-start marker failed', { caseId: fresh.id, error: e.message }) }

  const isBackgroundRedrive = !!(msg.resume || msg.queuedRedrive)
  const stopTyping = makeTypingIndicator({ adapter, replyTo, log, caseId: fresh.id, enabled: !isBackgroundRedrive })
  // Anchors every attempt's remaining-budget calculation (hooks/turn-attempts.js)
  // and the fallback's fast-vs-long tone choice (hooks/delivery.js).
  const turnStartedAt = Date.now()

  const turn = await runAgentTurn({
    store, log, callLLM, msg, fresh, events, contact, inboundText, prompt,
    channel, external_id, turnStartedAt, isBackgroundRedrive,
  })
  const { result, errored, jargonReasons, falseConfirmReasons, degradedReason } = turn
  let text = turn.text

  // Re-read the case after the agent turn: the agent may have completed intake
  // via case_report (or moved the stage) during the turn. Every report-aware
  // decision below must see what the agent just wrote, not the pre-turn snapshot.
  fresh = await store.getCase(fresh.id).catch(() => fresh)

  // Reaching here with empty text means the whole genuine retry budget (attempts
  // x hard deadline) was spent.
  const isFallback = !text
  if (isFallback) await recordDegradedOutcome({ store, log, fresh, result, errored })
  // Surfaced on the reply object so drainQueuedTurns can treat a degraded
  // re-drive as a failed attempt instead of burning the queued message.
  const degraded = errored || isFallback

  text = await correctOutboundRef({ store, fresh, text, result })
  if (!degraded) await clearAiOffline({ store, log, fresh })

  const held = await holdReplyForHuman({
    store, log, fresh, notifyHandoff, msg, channel, replyTo, platform,
    text, isFallback, jargonReasons, falseConfirmReasons,
  })
  if (held) { stopTyping(); return held }

  await advanceIntake({ store, log, fresh, inboundText, media })
  if (degraded) await tagAiOffline({ store, log, fresh })

  // A QUEUED message re-driven (msg.queuedRedrive, set only by drainQueuedTurns)
  // while the backend is STILL degraded must NOT be burned: an outbound here
  // would positionally complete the queued msgId in drainQueuedTurns, so the
  // agent would never see the message. Record the failure as an OBSERVATION
  // (which completes nothing) and send nothing.
  if (msg.queuedRedrive && degraded) {
    await store.appendEvent(fresh.id, observation('degraded re-drive; still degraded, nothing sent'))
    return { to: replyTo, text: '', platform, caseId: fresh.id, degraded: true }
  }

  if (isFallback) {
    // A background redrive stays SILENT on degrade: it is a catch-up re-drive of
    // an old message the contact has likely moved on from, never subject to the
    // live-turn guarantee.
    if (isBackgroundRedrive) {
      stopTyping()
      return { to: replyTo, text: '', platform, caseId: fresh.id, degraded: true }
    }
    return await sendGuaranteedFallback({
      store, log, adapter, fresh, channel, replyTo, platform,
      turnStartedAt, degradedReason, errored, result, stopTyping,
    })
  }

  const { reply } = await sendAgentReply({ store, log, adapter, fresh, channel, replyTo, platform, text, isFallback, degraded })
  // GUARANTEED-RESPONSE FSM, end: the real reply attempt (success or a failed
  // send, either way nothing more is coming) is the last point a typing indicator
  // should still be showing.
  stopTyping()
  return reply
}
