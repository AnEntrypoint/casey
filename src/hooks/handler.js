// hooks/handler.js -- casey's inbound entrypoint (makeCaseHandler), re-exported
// by gateway-hooks.js (see AGENTS.md's Source map for the file's role), plus the
// four pure key/target functions every other module derives a case identity or a
// delivery address from.
//
// This file owns only the per-contact CLAIM and the burst drain around a turn.
// The turn itself is hooks/inbound-turn.js, and each phase inside it lives in a
// sibling hooks/*.js module:
//
//   admission + rate limits ....... hooks/admission.js, hooks/case-intake.js
//   case resolution + intake ...... hooks/case-intake.js
//   media intake .................. hooks/media-intake.js
//   pre-turn gates ................ hooks/case-intake.js, hooks/service-controls.js
//   the agent turn ................ hooks/turn-attempts.js
//   post-turn decisions ........... hooks/turn-outcome.js
//   delivery + guaranteed fallback  hooks/delivery.js
//   typing indicator .............. hooks/typing.js
//   deadlines + status copy ....... hooks/turn-deadlines.js
//
// Keep it that way: the whole shape of a turn stays readable top to bottom, with
// each phase's reasoning held next to its own code rather than inlined here.

import { makeAdmissionControl } from './admission.js'
import { runInboundTurn } from './inbound-turn.js'
import { resolveAdapter } from './delivery.js'

const CHANNEL_DEFAULT = { whatsapp: 'whatsapp', discord: 'discord', sim: 'sim' }

// Returns an async (platform, msg) handler suitable to assign to
// gateway.handleInbound. `store` is a CaseStore; opts.callLLM optional;
// opts.autoRespond=false to track-only (no agent turn / reply). The typing
// indicator and the guaranteed-fallback send both reuse the adapter resolved per
// inbound (resolveAdapter, hooks/delivery.js) -- no separate adapter set needs
// threading through here. Missing methods on a given channel degrade to a no-op,
// never a thrown error (typing is a UX affordance, never load-bearing).
export function makeCaseHandler(store, { callLLM = null, llmStatus = null, autoRespond = true, log = console, notifyHandoff = null } = {}) {
  // Admission: the in-flight claim, the burst buffer, and the two rate windows.
  // These four pieces of state share nothing with the rest of this handler
  // except being consulted before a turn starts, and they are the only state
  // here whose correctness is about time and concurrency rather than about a
  // case -- so they live together in hooks/admission.js with the three AGENTS.md
  // guarantees they own (a burst is buffered not dropped, an over-cap message is
  // dropped silently, and the claim is taken with no await between the has() and
  // the add()).
  const admission = makeAdmissionControl({ log, store })
  const deps = { store, callLLM, llmStatus, autoRespond, log, notifyHandoff, admission }

  // Claims inFlight SYNCHRONOUSLY, before runInboundTurn's first await
  // (rateLimited/findOrCreateCase/recordInbound), never after: Set.has+Set.add
  // with no await between them is an atomic critical section under JS's
  // single-threaded/cooperative concurrency. A check placed past any awaited
  // store call cannot close the race -- two overlapping handleInboundOnce calls
  // for the same contact both pass it before either reaches the point of adding
  // itself to inFlight. This wrapper is what guarantees the claim is released on
  // EVERY exit path (return or throw) via the single finally below, rather than
  // at each of the turn's many early returns.
  async function handleInboundOnce(platform, msg) {
    const channel = CHANNEL_DEFAULT[platform] || platform || 'other'
    const external_id = conversationKey(msg)   // per-contact case IDENTITY
    const replyTo = replyTarget(msg)           // channel/chat DELIVERY target
    // A replay skips the isClaimed CHECK -- it was already turned away once and
    // must not be buffered a second time -- but it still takes the claim. It is
    // a full turn on this contact and has to exclude another one, exactly like a
    // first arrival. Skipping the claim too left the contact unclaimed for the
    // whole replay: a new message arriving mid-replay saw isClaimed false,
    // claimed, and ran a SECOND concurrent LLM turn on the same case, which is
    // the one thing this gate exists to prevent.
    //
    // Claiming here cannot stomp a live claim: a replay only ever begins after
    // admission.takeBuffered() handed the message over, and that returns null
    // while inFlight.has(id) -- so the previous turn has already released.
    if (!msg.burstReplay && admission.isClaimed(external_id)) {
      log.info?.('[casey] skipping concurrent LLM turn, buffered for replay', { channel })
      msg.burstReplay = true
      admission.bufferBurst(external_id, msg, channel)
      return { to: replyTo, text: '', platform, skipped: true, buffered: true }
    }
    admission.claim(external_id)
    try {
      return await runInboundTurn(this, deps, { platform, msg, channel, external_id, replyTo })
    } finally {
      admission.release(external_id)
    }
  }

  // Public entrypoint: run one turn, then drain any message a fast burst
  // buffered while that turn was in flight -- one extra turn per buffered
  // message, oldest-first, so a burst's later messages still reach a prompt
  // instead of vanishing at the guard. `this` is preserved via .call so the
  // adapter lookup inside the turn still resolves (casey.js binds handleInbound
  // to the gateway instance).
  return async function handleInbound(platform, msg) {
    // Crash-safety backstop for the guaranteed-response FSM's typing indicator:
    // the turn body has no try/finally of its own around most of itself, so an
    // unhandled throw deep inside bypasses every stopTyping() call threaded
    // through its own return paths and leaks a live typing indicator until
    // Discord's own ~10s TTL expires it. adapter.stopTyping is idempotent (a
    // no-op if nothing was ever started for this channel -- see DiscordAdapter's
    // own Map-based tracking), so calling it here defensively in a finally,
    // keyed on the same replyTarget() the turn used to start it, is safe on the
    // many paths that never started one at all.
    const adapter = resolveAdapter(this, platform)
    let result
    try {
      result = await handleInboundOnce.call(this, platform, msg)
    } finally {
      try { adapter?.stopTyping?.(replyTarget(msg)) } catch { /* best-effort */ }
    }
    const external_id = conversationKey(msg)
    const next = admission.takeBuffered(external_id)
    if (next) {
      // Fire-and-forget: the replay is a full turn in its own right (it appends
      // its own events/outbound), not something the original caller should block
      // on -- mirrors how drainQueuedTurns re-drives independently.
      //
      // Route through the casey.js _wrapInflight-WRAPPED reference, NEVER the
      // raw closure-local `handleInbound` this function is bound to. A raw
      // self-call bypasses casey.js's `_inflight` tracking entirely, so a
      // burst-replay turn can still be mid-flight when casey.stop() closes the
      // store, and the replay throws "CaseStore not initialised".
      //
      // `this` is the CASEY INSTANCE, not a gateway: casey.js does
      // `handler.bind(this)` on the Casey object (which is also what makes
      // `this.adapters` resolvable), and _wrapInflight reassigns
      // `this.gateway.handleInbound` -- Casey itself has no `handleInbound`
      // property at all. A bare `this.handleInbound(...)` here is therefore a
      // TypeError on every burst replay, thrown from a fire-and-forget call
      // with no catch attached yet: the buffered message is lost AND the
      // rejection is unhandled, which takes the whole worker down with it
      // (live-witnessed). Prefer the gateway reference, fall back to a
      // receiver that does expose handleInbound directly, and log loud rather
      // than dropping the buffered message silently if neither exists.
      const tracked = this.gateway?.handleInbound || this.handleInbound
      if (typeof tracked !== 'function') {
        log.error?.('[casey] burst replay dropped: no tracked handleInbound on the bound receiver', { platform })
      } else {
        Promise.resolve(tracked.call(this, platform, next))
          .catch(e => log.error?.('[casey] burst replay failed', { error: e?.message || String(e) }))
      }
    }
    return result
  }
}

// The conversation/case IDENTITY -- per CONTACT, not per channel. A Discord server
// channel carries many authors, and keying on the channel alone puts everyone in it
// on ONE case. So when the container (channel/chat) and the author differ -- a
// multi-person channel -- the key is "container:author". A 1:1 chat (WhatsApp, where
// the chat id IS the person, or there is no separate container) stays the single id.
// This is identity only; the reply DELIVERY target is replyTarget() below (the
// channel), because Discord posts to the channel, not the author.
export function conversationKey(msg) {
  const container = msg.raw?.channel_id || msg.raw?.chatId || msg.chatId || ''
  const author = msg.from || ''
  if (container && author && container !== author) return `${container}:${author}`
  return container || author || 'unknown'
}

// The inverse of conversationKey: decompose a stored external_id back into its
// container and author. The container is the FIRST colon-separated segment and
// the author the LAST, deliberately, because a corrupted key can carry the same
// container repeated many times.
//
// Keep this decomposition in ONE place, and never feed a combined external_id
// back into conversationKey as `msg.from`: conversationKey builds
// `container:from`, so a redrive that does inflates the key to
// `container:container:author` on its own next write, growing by one duplicated
// segment every sweep pass and compounding without bound. Taking the LAST
// segment as the author both prevents that and self-heals an already compounded
// key on its next successful resume -- the freshly split-and-rejoined key
// collapses back to a clean two-part container:author with no migration.
export function splitExternalId(externalId) {
  const parts = String(externalId || '').split(':')
  return { container: parts[0], author: parts[parts.length - 1] }
}

// Where a reply is DELIVERED: the channel/chat container (Discord posts to
// /channels/{channel}/messages; an author id 404s). Falls back to the sender for a
// 1:1 chat. Distinct from conversationKey, which is the per-contact case identity.
export function replyTarget(msg) {
  return msg.raw?.channel_id || msg.raw?.chatId || msg.chatId || msg.from || 'unknown'
}

// Delivery target for an operator/system send addressed to a CASE ROW rather
// than a live message: the inverse of conversationKey. On Discord external_id
// is the 'container:author' composite and /channels/{composite}/messages is a
// 400 Invalid Form Body -- the channel container alone is the target. 1:1
// channels (WhatsApp) carry no ':' composite and pass through unchanged.
export function caseDeliveryTarget(caseRow) {
  const ext = String(caseRow?.external_id || '')
  if ((caseRow?.channel || '') === 'discord' && ext.includes(':')) return splitExternalId(ext).container
  return ext
}
