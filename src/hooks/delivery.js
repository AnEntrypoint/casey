// hooks/delivery.js -- the two send paths and the outbound events that record
// them: the guaranteed fallback for a degraded live turn, and the real agent
// reply.
//
// THE DELIVERY FLAG IN BOTH FUNCTIONS STARTS FALSE, BELOW THE `adapter?.send`
// GUARD, and goes true only once a real send is attempted. Initialised true
// above its own guard, a turn with no resolved adapter records itself delivered
// having sent nothing -- which is exactly how a total delivery outage stayed
// hidden for the life of a port. freddie-bundle/src/platform discards this
// handler's return value, so adapter.send is the ONLY route an agent reply has
// to a reporter: there is no second channel to notice the silence.

import { observation } from './case-writes.js'
import { synthesizeVoice } from './media.js'
import { recordDegradedTurn, FAILURE_REASONS } from '../degraded-turns.js'
import { TURN_SOFT_DEADLINE_MS, STILL_WORKING_TEXT, TURN_TIMEOUT_TEXT } from './turn-deadlines.js'

// Resolve the outbound adapter for a platform from the receiver the handler is
// bound to.
//
// Object index, NEVER `.get()`: casey.js binds the inbound handler to the Casey
// instance (`handler.bind(this)`), and Casey has no `platforms` at all -- it
// builds `this.adapters`, a plain OBJECT keyed by channel (`platforms` exists
// only as a local const in casey.js's init, assigned straight into
// `this.adapters`). A `.get()` lookup short-circuits silently under optional
// chaining, leaving `adapter` undefined on every turn, and .bind is permanent so
// no later .call/.apply rescues it. When a seam like this changes shape, search
// for the OLD shape's ACCESSOR (`.get(`) as well as its name.
//
// Kept tolerant of a missing channel so an unconfigured platform degrades rather
// than throwing.
export function resolveAdapter(receiver, platform) {
  return receiver?.adapters?.[platform] || null
}

// GUARANTEED-RESPONSE FSM, terminal fallback: a degraded LIVE first-attempt turn
// never sends total silence -- it sends the truthful status text
// (STILL_WORKING_TEXT if the hard deadline has not yet been reached -- rare
// here, since the attempt loop already spent up to the whole hard-deadline
// budget retrying, but a genuinely instant degrade, e.g. a structural refusal
// caught before any real network wait, can still land here well under the
// deadline -- vs TURN_TIMEOUT_TEXT once it has). A background redrive
// (msg.resume / msg.queuedRedrive) stays SILENT on degrade and never reaches
// this function; the caller owns that guard.
export async function sendGuaranteedFallback({
  store, log, adapter, fresh, channel, replyTo, platform,
  turnStartedAt, degradedReason, errored, result, stopTyping,
}) {
  // Classify from the final state when the attempt loop did not already name a
  // more specific reason (timeout/provider).
  const reason = degradedReason
    || (!errored && result?.error ? FAILURE_REASONS.LLM_REFUSAL : FAILURE_REASONS.RETRY_EXHAUSTED)
  try {
    await recordDegradedTurn(store, {
      caseId: fresh.id,
      contactId: fresh.contact_id,
      reason,
      turnStartMs: turnStartedAt,
      channel,
    })
  } catch (e) { log.warn?.('[casey] failed to record degraded-turn event', { caseId: fresh.id, error: e.message }) }
  // Message tone is picked by the soft deadline alone -- see
  // TURN_SOFT_DEADLINE_MS's own declaration (hooks/turn-deadlines.js) for why
  // fast-degrade reads as "still working" and long-degrade as "having trouble".
  const elapsedMs = Date.now() - turnStartedAt
  const fallbackText = elapsedMs >= TURN_SOFT_DEADLINE_MS ? TURN_TIMEOUT_TEXT : STILL_WORKING_TEXT
  await store.appendEvent(fresh.id, {
    kind: 'outbound', actor: 'system', channel,
    text: fallbackText, data: { to: replyTo, fallback: true, guaranteedFallback: true },
  })
  stopTyping?.()
  const fallbackReply = { to: replyTo, text: fallbackText, platform, caseId: fresh.id, degraded: true, guaranteedFallback: true }
  // Starts FALSE and goes true only once a real send is attempted, so "the
  // guaranteed fallback went out" can never be recorded for a turn that had no
  // adapter to send it with.
  let fallbackDelivered = false
  try {
    if (typeof adapter?.send === 'function') { fallbackDelivered = true; await adapter.send(fallbackReply) }
  } catch (e) {
    fallbackDelivered = false
    log.error?.('[casey] guaranteed-fallback send failed', { caseId: fresh.id, error: e.message })
    // Mirrors the agent-reply path's send-failure visibility below. This is the
    // path meant to GUARANTEE an observable record for a worried contact, so its
    // own delivery failure must not be the one silent case: the 'sent' event
    // above already exists, and this adds the correcting fact so the timeline is
    // never wrong about whether the fallback text actually reached the contact.
    await store.appendEvent(fresh.id, observation(`fallback send failed on ${channel}: ${e.message}`))
  }
  fallbackReply.delivered = fallbackDelivered
  return fallbackReply
}

// The real agent reply: record the outbound, optionally attach a voice render,
// and send.
//
// Reply target is external_id-derived (replyTarget), NOT msg.from. On Discord,
// the send POSTs to /channels/{to}/messages, so `to` must be the channel id; on
// WhatsApp it falls back to the phone number. msg.from (author id) silently 404s
// on Discord and the contact never sees the reply.
// Rewrite an already-written outbound event to say the send did not land. The
// row is not deleted: casey did compose and attempt that reply, and the attempt
// is real history. Only the claim that it reached the contact is withdrawn.
async function markOutboundUndelivered(store, ev, replyTo, isFallback, error, log) {
  if (!ev?.id) return
  try {
    await store.t.update('event', ev.id, {
      data: JSON.stringify({ to: replyTo, fallback: isFallback, delivered: false, send_error: String(error || '').slice(0, 300) }),
    }, { id: 'system', role: 'system' })
  } catch (e) { log?.warn?.('[casey] could not mark outbound as undelivered', { error: e.message }) }
}

export async function sendAgentReply({
  store, log, adapter, fresh, channel, replyTo, platform, text, isFallback, degraded,
}) {
  // Appended BEFORE the send attempt on purpose: a crash between the write and
  // the send leaves a record of what casey was about to say, which is the right
  // bias for an audit log. The cost is that this row exists whether or not the
  // send lands, so a failure has to come back and say so -- see below.
  const outboundEvent = await store.appendEvent(fresh.id, {
    kind: 'outbound', actor: 'agent', channel,
    text, data: { to: replyTo, fallback: isFallback },
  })
  const reply = { to: replyTo, text, platform, caseId: fresh.id, ...(degraded ? { degraded: true } : {}) }
  // Opt-in voice reply: speak the (already-vetted, non-degraded) text back so a
  // low-literacy reporter can hear it. Additive -- text still sends; null when
  // disabled/unavailable/failed, leaving a plain text reply.
  const audio = await synthesizeVoice(text)
  if (audio) reply.audio = audio
  // Starts FALSE and is set only inside the branch that earns it (see this
  // module's header).
  let delivered = false
  if (adapter?.send) {
    delivered = true
    try { await adapter.send(reply) }
    catch (e) {
      delivered = false
      log.error?.('[casey] adapter.send failed', { caseId: fresh.id, platform, error: e.message })
      await store.appendEvent(fresh.id, observation(`send failed on ${channel}: ${e.message}`))
      // MARK THE OUTBOUND ROW ITSELF. The observation above is a separate line
      // further down the timeline, so an operator scanning the conversation saw
      // "Replied automatically" and had to notice a second row elsewhere to
      // learn the contact never got it. The timeline renders this flag on the
      // reply it belongs to.
      //
      // Best-effort: the send has already failed and the observation is already
      // written, so a failure to annotate must not throw on top of it.
      await markOutboundUndelivered(store, outboundEvent, replyTo, isFallback, e.message, log)
    }
  } else {
    // NO ADAPTER RESOLVED AT ALL. Nothing was sent, and this is the exact case
    // this module's own header warns about: a turn with no resolved adapter
    // must not record itself as having replied. It reached the timeline as
    // "Replied automatically" with no qualification, which is the same untruth
    // as a failed send and arrives more quietly, because there is no thrown
    // error and no observation row beside it.
    await markOutboundUndelivered(store, outboundEvent, replyTo, isFallback,
      `no adapter for channel "${channel}" -- nothing was sent`, log)
    await store.appendEvent(fresh.id, observation(`reply not sent: no adapter for channel "${channel}"`))
  }
  // `delivered` is returned for the caller that wants it and is NOT attached to
  // `reply`. Both call sites of this turn -- freddie-bundle's platform plugin
  // for WhatsApp and for Discord -- invoke the handler as
  // `handleInbound(...).catch(...)` and discard what it resolves to, so a field
  // on the returned object would be data nobody reads. The place a delivery
  // failure has to reach is a person, and that is the event above.
  return { reply, delivered }
}
