// hooks/handler.js -- casey's main inbound orchestration (makeCaseHandler),
// re-exported by gateway-hooks.js (see AGENTS.md's Source map for the file's
// role). The runTurn tool-loop orchestration: find/create case -> log inbound
// -> STOP/HUMAN short-circuit -> LLM-down queue gate -> rate limits -> agent
// turn -> outbound scrubs -> send. Every helper it calls (prompt construction,
// pure-text heuristics, media enrichment) lives in a sibling hooks/*.js file,
// wired as ordinary ES module imports below.

import { runTurn } from '../agent/run-turn.js'
import { fmtTimeSAST } from '../format.js'
// The two case-write shapes this file would otherwise spell out by hand: the
// observation event body, and the read-then-tag-then-notify-once sequence.
import { observation, flagNeedsHuman } from './case-writes.js'
import { makeAdmissionControl } from './admission.js'
import { applyServiceControls, isLlmDown } from './service-controls.js'
import { recordInboundMedia } from './media-intake.js'
import { mutatingActions, hadSuccessfulWrite, toolCaseRefs } from './turn-results.js'
import { tagList } from '../timestamp.js'
import { reporterTierExcludedToolNames } from '../case-tools.js'
import { caseSystemPrompt } from './prompt.js'
import {
  truncate,
  sanitizeOutboundRef,
  stripChannelMarkup,
  mergeTag,
  dropTag,
  canAgentAct,
  stripThinkingBlock,
} from './heuristics.js'
import { judgeReply } from './reply-judge.js'
import { synthesizeVoice } from './media.js'
import { recordDegradedTurn, FAILURE_REASONS } from '../degraded-turns.js'

const CHANNEL_DEFAULT = { whatsapp: 'whatsapp', discord: 'discord', sim: 'sim' }

// GUARANTEED-RESPONSE FSM (typing indicator + bounded turnaround + explicit
// fallback message). USER DIRECTIVE: every LIVE first-attempt turn must end
// in either a real chat reply or an explicit, truthful "still working" /
// "having trouble" status message -- never total silence. This is a scoped
// exception to the no-fallback-text principle, not a reversal of it: what that
// principle bans is FABRICATED case content or a scripted apology standing in
// for real understanding (a mock). A truthful status update ("still working on
// this", "having trouble right now, please try again in a moment") invents
// nothing and claims nothing about the contact's case -- it is the same class
// of honesty as the loud log lines, just also shown to the contact. Applies
// only to a live,
// first-attempt turn that clears rate-limiting: excludes msg.resume /
// msg.queuedRedrive (background catch-up re-drives of an OLD message the
// contact has likely moved on from -- see the isBackgroundRedrive guard
// below), and excludes the rateLimited/globallyRateLimited early-returns
// further down (a deliberate pre-store admission-control gate -- no
// findOrCreateCase/recordInbound has run yet at that point, so there is no
// case timeline to attach a status message to).
//
// CASEY_TURN_HARD_DEADLINE_MS is the real, unconditional guarantee: the
// attempt loop below spends AT MOST this much total wall-clock time retrying
// (each individual attempt still gets to run its own bounded provider-chain
// walk -- ACPTOAPI_CHAIN_LINK_TIMEOUT_MS-per-hop, set to 60s in casey's own
// .env -- to real completion rather than being cut off mid-hop; this is the
// "completing through multiple samples" behavior the design calls for: a
// retry that starts with real remaining budget gets a genuine chance, not an
// arbitrarily truncated one). acptoapi's OWN shipped default for this
// timeout (chain-machine.js DEFAULT_LINK_TIMEOUT_MS) is 120s, not 20s; casey's
// .env explicitly overrides it to 60s specifically because the upstream default
// alone would let one bad chain hop consume the whole hard-deadline budget on
// attempt 1 alone. A deployment missing that override silently inherits the 120s
// default (see AGENTS.md's Timeout Coordination section). Once the hard
// deadline is reached the loop stops retrying and the guaranteed-fallback
// text is composed and sent -- see the attempt loop's own remainingMs
// calculation for exactly how each attempt's budget is derived.
//
// CASEY_TURN_SOFT_DEADLINE_MS is NOT a second timeout gate -- it only picks
// which of the two fallback strings to send, based on how long the whole
// turn actually took: a turn that degraded FAST (under the soft deadline --
// a structural refusal, an immediate provider auth error) reads as "still
// working, one moment" since a quick follow-up message has a real chance of
// landing on a healthier attempt; a turn that ran long (spent real time
// genuinely retrying/waiting on providers, past the soft deadline) gets the
// more honest "having trouble" text instead of understating an already-long
// wait.
const TURN_SOFT_DEADLINE_MS = Number(process.env.CASEY_TURN_SOFT_DEADLINE_MS) || 25000
// 120s whole-turn budget: a genuine first attempt WITH tool calls (case_new +
// case_report + judge) has been witnessed eating 45s, so a 60s whole-turn cap
// left zero room for the retry budget it is supposed to protect -- the retried
// turn timed out mid-attempt and the contact got the terminal timeout text
// despite a healthy provider. The per-MODEL-CALL bound stays 60s
// (ACPTOAPI_CHAIN_LINK_TIMEOUT_MS); this is the budget across attempts.
const TURN_HARD_DEADLINE_MS = Number(process.env.CASEY_TURN_HARD_DEADLINE_MS) || 120000
// Discord's own typing-indicator TTL is ~10s; DiscordAdapter.startTyping
// re-POSTs on its own shorter interval internally, so this handler only
// needs to call start/stop once per turn, not manage a repeat itself.

// Truthful, plain-language status copy (per AGENTS.md's existing tone
// principles: no jargon, mirror the contact's own language where the case
// system prompt already does that for a real reply -- these two fixed
// strings are deliberately language-neutral/short so they read reasonably
// in translation without needing a full localization pass).
const STILL_WORKING_TEXT = "Still working on this -- one moment."
const TURN_TIMEOUT_TEXT = "Sorry, I'm having trouble right now. Please try again in a little while, or send your message again."

// Resolve the outbound adapter for a platform from the receiver the handler is
// bound to.
//
// Object index, NEVER `.get()`: casey.js binds this handler to the Casey instance
// (`handler.bind(this)`), and Casey has no `platforms` at all -- it builds
// `this.adapters`, a plain OBJECT keyed by channel (`platforms` exists only as a
// local const in casey.js's init, assigned straight into `this.adapters`). A
// `.get()` lookup short-circuits silently under optional chaining, leaving
// `adapter` undefined on every turn, and .bind is permanent so no later
// .call/.apply rescues it.
//
// That failure is silent, not loud, and it is not merely a dead typing indicator:
// the same `adapter` backs the guaranteed-fallback send and the agent's real reply
// to the contact, and freddie-bundle/src/platform discards this handler's return
// value, so adapter.send is the ONLY route an agent reply has to a reporter. Both
// delivery flags must therefore start FALSE, below their `if (adapter?.send)`
// guard -- initialised true above it, a skipped send records the turn as delivered.
//
// Kept tolerant of a missing channel so an unconfigured platform degrades rather
// than throwing.
function resolveAdapter(receiver, platform) {
  return receiver?.adapters?.[platform] || null
}

// Returns an async (platform, msg) handler suitable to assign to
// gateway.handleInbound. `store` is a CaseStore; opts.callLLM optional;
// opts.autoRespond=false to track-only (no agent turn / reply). The typing
// indicator (adapter.startTyping/stopTyping) and the guaranteed-fallback send
// both reuse `adapter` (this.platforms.get(platform), already resolved per
// inbound below) -- no separate adapter set needs threading through here.
// Missing methods on a given channel degrade to a no-op, never a thrown error
// (typing is a UX affordance, never load-bearing).
export function makeCaseHandler(store, { callLLM = null, llmStatus = null, autoRespond = true, log = console, notifyHandoff = null } = {}) {
  // Admission: the in-flight claim, the burst buffer, and the two rate windows.
  // These four pieces of state share nothing with the rest of this handler
  // except being consulted before a turn starts, and they are the only state
  // here whose correctness is about time and concurrency rather than about a
  // case -- so they live together in hooks/admission.js with the three
  // AGENTS.md guarantees they own (a burst is buffered not dropped, an
  // over-cap message is dropped silently, and the claim is taken with no
  // await between the has() and the add()).
  const admission = makeAdmissionControl({ log })
  // Claims inFlight SYNCHRONOUSLY, before handleInboundOnceClaimed's first
  // await (rateLimited/findOrCreateCase/recordInbound), never after:
  // Set.has+Set.add with no await between them is an atomic critical section
  // under JS's single-threaded/cooperative concurrency. A check placed past
  // any awaited store call cannot close the race -- two overlapping
  // handleInboundOnce calls for the same contact both pass it before either
  // reaches the point of adding itself to inFlight. A burstReplay call is the
  // ALREADY-in-flight turn for this contact being re-driven (see the trailing
  // drain block below), so it does not re-claim here; it runs as the sole
  // owner of an existing claim instead. This wrapper is what guarantees the
  // claim is released on EVERY exit path (return or throw) via the single
  // finally below, rather than at each of the inner body's many early returns.
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
      return await handleInboundOnceClaimed.call(this, platform, msg, channel, external_id, replyTo)
    } finally {
      admission.release(external_id)
    }
  }
  async function handleInboundOnceClaimed(platform, msg, channel, external_id, replyTo) {
    const adapter = resolveAdapter(this, platform)
    // Rate limits are checked here, before findOrCreateCase/recordInbound run
    // any store write, so a signature-verified flood is turned away without
    // driving unbounded case/event writes. Checking only AFTER those writes
    // still protects the LLM spend but lets the flood itself through to the
    // store on every single message. A buffered-then-replayed
    // message must not be rate-checked a second time for the same human
    // message (only the FIRST arrival, before it was buffered, consumed a
    // window slot) -- double-counting a burst against its own buffer defeats
    // the "buffered, never dropped" guarantee the buffer exists to provide.
    if (!msg.burstReplay && admission.rateLimited(external_id)) {
      log.error?.('[casey] rate limit: skipping turn, no store write, no reply sent', { channel })
      return { to: replyTo, text: '', platform, rateLimited: true }
    }
    if (admission.globallyRateLimited()) {
      log.error?.('[casey] global rate limit: skipping turn, no store write, no reply sent', { channel })
      return { to: replyTo, text: '', platform, rateLimited: true }
    }
    if (!store) {
      // USER DIRECTIVE: no mocks/fallbacks/stubs, only singular working mechanisms
      // and loud errors. The store is a hard dependency -- if it is not
      // initialized, that is a real infrastructure failure, not something a
      // scripted apology should paper over. Log loud, send nothing.
      log?.error?.('[casey] store not initialized; dropping inbound')
      return { to: replyTo, text: '', platform, error: 'store_not_ready' }
    }
    const msgId = messageId(msg)
    // Channel only, never external_id -- it is the contact's phone number
    // (PII), and the same rule is spelled out again at the findOrCreateCase
    // catch below.
    if (!msgId) log?.warn?.('[casey] inbound message missing id; dedup guarantee not applied', { channel })

    let caseRow, created
    try {
      ;({ case: caseRow, created } = await store.findOrCreateCase({
        channel, external_id,
        contact: { display_name: msg.raw?.author?.username, handle: msg.raw?.author?.username },
      }))
    } catch (e) {
      // Do NOT log external_id -- it is the contact's phone number (PII). Channel
      // plus the error is enough to diagnose without writing PII to the log sink.
      // USER DIRECTIVE: no fallback text -- a store failure is a real
      // infrastructure error, logged loud, nothing sent.
      log.error?.('[casey] findOrCreateCase failed; dropping inbound', { channel, error: e.message })
      return { to: replyTo, text: '', platform, error: e.message }
    }

    // Dedup: a redelivered platform message (webhook retry, gateway replay, or
    // the same message duplicated in one tick) is recorded and answered exactly
    // once. recordInbound runs on the per-conversation lock so the dedup check
    // and the append are atomic -- duplicates are structurally unrepresentable,
    // not merely improbable.
    // Strip channel mention markup (e.g. Discord's "<@BOTID> hello") before the
    // text reaches any reasoning: the mention's numeric id otherwise reads as a
    // count and flips a bare greeting out of the content-free path into the
    // case-ack. The raw msg.text is still recorded by recordInbound below for
    // audit; only the reasoning copy is cleaned.
    const inboundText = stripChannelMarkup(msg.text || '')
    const media = describeMedia(msg)
    let inboundEvent
    try {
      inboundEvent = await store.recordInbound(caseRow, {
        channel,
        text: inboundText || (media ? `[${media}]` : '[empty message]'),
        data: {}, msg_id: msgId,
      })
    } catch (e) {
      // Unguarded, a transient store error here (thatcher busy, a lock timeout)
      // throws straight past this point and silently drops the WHOLE inbound
      // turn, with only casey.js's _wrapInflight backstop between it and an
      // unhandled rejection. Same explicit-drop discipline as the
      // findOrCreateCase catch above: log loud, send nothing (no fallback text).
      log.error?.('[casey] recordInbound failed; dropping inbound', { caseId: caseRow.id, channel, error: e.message })
      return { to: replyTo, text: '', platform, caseId: caseRow.id, error: e.message }
    }
    // A resume re-drive (msg.resume) intentionally carries the ORIGINAL msg_id of
    // an inbound already recorded, so recordInbound correctly returns null. That is
    // the expected path here, not a duplicate to drop: the boot resume sweep is
    // re-running the turn for a message whose inbound persisted but whose reply
    // never went out. Fall through to the agent turn instead of short-circuiting.
    // Same for msg.burstReplay: the fast-message-burst buffer stores the ORIGINAL
    // msg object, whose inbound was already recorded the first time this message
    // hit the inFlight guard, and the replay re-enters this function to run the
    // turn, not to re-record a redelivery. Without both exemptions the replay
    // self-dedupes on its own earlier recording and silently no-ops -- the message
    // sits IN the event log and never gets a real reply, defeating the "buffered
    // and replayed, never silently dropped" guarantee.
    if (!inboundEvent && !msg.resume && !msg.burstReplay) {
      log.info?.('[casey] duplicate inbound dropped', { caseId: caseRow.id, msgId })
      return { to: replyTo, text: '', platform, caseId: caseRow.id, duplicate: true }
    }
    // A fresh inbound supersedes any pending assisted draft: the contact has said
    // more, so a draft composed against the old conversation is stale. Clear the
    // draft-pending tag (the agent turn below re-drafts against the full thread)
    // and record the supersession so the timeline shows why the old draft lapsed.
    // needs-human is left in place -- the case still wants an operator.
    if (tagList(caseRow).includes('draft-pending')) {
      try {
        await store.updateCase(caseRow.id, { tags: dropTag(caseRow.tags, 'draft-pending') })
        await store.appendEvent(caseRow.id, observation('DRAFT SUPERSEDED: a new message arrived; the pending draft reply was set aside for a fresh one.'))
      } catch (e) { log.warn?.('[casey] draft supersede failed', { caseId: caseRow.id, error: e.message }) }
    }
    // Record every media artifact this message carried, before the agent turn.
    // Photo and audio arrival share one helper in hooks/media-intake.js, and the
    // adapter-shape normalisation lives with them: WhatsApp's adapter resolves a
    // single media object and Discord's resolves an ARRAY, so a read that assumes
    // the WhatsApp shape strands a Discord photo at the text-only floor with real
    // downloaded bytes sitting right there. Append-only and best-effort --
    // nothing in here may block the reply path.
    await recordInboundMedia({ store, log, caseId: caseRow.id, msg })
    if (created) {
      if (!caseRow.subject) {
        const subj = truncate(inboundText || media || 'New conversation', 80)
        try { await store.updateCase(caseRow.id, { subject: subj }) } catch (e) { log.warn?.('[casey] seed subject failed', { error: e.message }) }
      }
      // Tag intake source so the dashboard can filter and compare AI vs manual.
      try {
        if (!tagList(caseRow).includes('intake_mode:channel')) {
          await store.updateCase(caseRow.id, { tags: mergeTag(caseRow.tags, 'intake_mode:channel') })
        }
      } catch (e) { log.warn?.('[casey] intake_mode tag failed', { error: e.message }) }
      // This event is audit-trail decoration (the case already exists by this
      // point), so a failure here must never block the reply path -- guarded,
      // best-effort, the same discipline as every other non-critical append in
      // this function. Unguarded, a transient store error here silently drops
      // the whole inbound turn with no reply, no observation and no logged
      // reason.
      try { await store.appendEvent(caseRow.id, { kind: 'note', actor: 'system', text: `Case opened from ${channel}` }) }
      catch (e) { log.warn?.('[casey] case-opened note failed', { caseId: caseRow.id, error: e.message }) }
    }

    if (!autoRespond) return { to: replyTo, text: '', platform, caseId: caseRow.id }

    // Guarded: unguarded, a transient store error here silently drops the whole
    // agent turn (the STOP/HUMAN short-circuit, the LLM call, the reply) with no
    // explicit error response. The case row from findOrCreateCase (caseRow) is a
    // fine fallback -- only slightly staler (missing whatever the
    // append/updateCase calls just above wrote) -- and a genuinely broken store
    // fails again on the very next real call in this turn, surfacing loudly
    // there instead of vanishing here.
    let fresh
    try { fresh = await store.getCase(caseRow.id) }
    catch (e) {
      log.warn?.('[casey] getCase(fresh) failed; continuing with the pre-turn case snapshot', { caseId: caseRow.id, error: e.message })
      fresh = caseRow
    }

    // PURE LLM: casey does NOT deterministically extract report fields. The AGENT
    // records what it learns via case_report during its turn. There is no keyword
    // capture floor -- the model owns field recording entirely (user directive: get
    // rid of hard coding so the LLM does its job). The only deterministic pre-LLM
    // layer left is the irreversible STOP/HUMAN control below.

    // IRREVERSIBLE SERVICE CONTROLS (the only deterministic pre-LLM route left).
    // STOP (opt-out) and HUMAN (handoff) are legal/service controls that must fire
    // synchronously in any language even with the model down -- they are never
    // queued and never left to the agent's discretion, and they must fire
    // REGARDLESS of autonomy mode, so this runs BEFORE the observe-mode gate
    // below. Everything else (status, help, greeting, enquiry, report,
    // extraction) is the agent's job via the case tools in the runTurn loop.
    //
    // The control's own state change is unconditional and happens inside; a
    // non-null return means the turn is finished here, and null falls through
    // so the ordinary agent turn composes the acknowledgement in the contact's
    // own language rather than from a hardcoded per-language string.
    const controlled = await applyServiceControls({
      store, log, llmStatus, notifyHandoff,
      caseRow: fresh, inboundText, channel, msg, replyTo, platform,
    })
    if (controlled) return controlled

    // observe-mode: the agent does not act or reply automatically; a human
    // drives the case. We still recorded the inbound above, and STOP/HUMAN (the
    // irreversible controls) already had their chance to fire above this check --
    // this only gates the ordinary conversational/report turn that follows.
    if (fresh.autonomy === 'observe') {
      await store.appendEvent(fresh.id, observation('autonomy=observe: awaiting operator (no auto-reply)'))
      // Observe mode means a human drives, but the case must still SURFACE for one
      // -- otherwise an observe-mode contact waits silently with nothing in the
      // triage inbox. Flag needs-human (the observable handoff signal) and notify
      // once on first flag, exactly like an explicit human request. Do NOT raise
      // priority: casey surfaces the request; the operator decides urgency.
      await flagNeedsHuman({ store, log, caseRow: fresh, notifyHandoff, channel, from: msg.from, flagLabel: 'observe needs-human', notifyLabel: 'observe handoff' })
      return { to: replyTo, text: '', platform, caseId: fresh.id, observed: true }
    }

    // Everything else -- status, help, greeting, thanks, enquiry, report, field
    // extraction, the whole conversation -- is the AGENT'S job. No deterministic
    // pre-route: the message goes straight into the runTurn tool loop below, where
    // the model classifies and acts by calling the case tools (case_report,
    // case_list, case_get, case_mine/case_today, case_new, case_stop). Never add a
    // keyword/shape router or a STATUS-BY-REF short-circuit back: the soft dead-end
    // stays structurally impossible only while the agent, not a phrase maze,
    // decides the reply.

    const contact = fresh.contact_id ? await store.getContact(fresh.contact_id).catch(() => null) : null
    const events = await store.listEvents(fresh.id)
    const prompt = inboundText || (media ? `The contact sent ${media} with no text. Acknowledge and ask how you can help.` : 'The contact sent an empty message. Acknowledge politely.')

    // LLM-DOWN QUEUE GATE. A message that arrives while the backend is down cannot
    // be understood now -- so QUEUE it and re-drive when the provider recovers
    // (drainQueuedTurns on the down->up edge). The inbound is already recorded
    // above; here a durable QUEUED-FOR-AGENT marker is appended and the turn returns
    // WITHOUT a TURN-START (so the resume sweep does not also claim it). USER DIRECTIVE: no
    // fallback text -- log loud, send nothing, rely on the queue to re-drive once
    // the provider (the in-process acptoapi bridge) is actually reachable. Guarded
    // once per msgId. STOP/HUMAN are handled by the deterministic short-circuit
    // ABOVE this gate, so an opt-out during an outage still fires synchronously
    // and is never queued.
    // isLlmDown carries the swallow-and-assume-up catch (a status() that itself
    // throws must never gate an inbound into the queue) and the not-a-function
    // guard, so both are read once here instead of spelled out a third time.
    if (!msg.resume && await isLlmDown(llmStatus)) {
      const already = events.some(e => e.kind === 'observation' && typeof e.text === 'string' && e.text === `QUEUED-FOR-AGENT:${msgId}`)
      if (!already) {
        try {
          await store.appendEvent(fresh.id, observation(`QUEUED-FOR-AGENT:${msgId}`))
          log.error?.('[casey] LLM backend down; queued inbound, no reply sent', { caseId: fresh.id, msgId })
          return { to: replyTo, text: '', platform, caseId: fresh.id, queued: true }
        } catch (e) {
          log.warn?.('[casey] queue-gate append failed; falling through to live turn', { caseId: fresh.id, error: e.message })
        }
      } else {
        // Already queued this msgId (a duplicate delivery during the outage).
        return { to: replyTo, text: '', platform, caseId: fresh.id, queued: true, deduped: true }
      }
    }

    // Per-contact concurrency gate: the claim happens synchronously at function
    // entry, before this point is ever reached (see the top of
    // handleInboundOnce) -- a concurrent arrival is buffered and returns long
    // before reaching here. This is only the buffered turn's own case-scoped
    // audit note, logged once there is a real case row to attach it to.
    if (msg.burstReplay) {
      await store.appendEvent(fresh.id, observation('concurrent turn skipped: prior LLM turn still in-flight for this contact; buffered for replay'))
    }
    let result, errored = false
    try {
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
    // GUARANTEED-RESPONSE FSM, start: a live, first-attempt turn (never a
    // background resume/queue re-drive -- see isBackgroundRedrive) shows a
    // typing indicator for its whole duration. Best-effort: startTyping is a
    // UX affordance, never load-bearing -- an adapter with no typing support
    // (WhatsApp today) or a failed POST degrades silently, never blocks or
    // throws into the real turn. stopTyping must be called from EVERY exit path
    // below. A genuine process crash bypasses all of them, which is fine:
    // Discord's own typing indicator expires on its ~10s TTL with no re-POST,
    // so a crashed turn's indicator self-clears rather than hanging forever.
    const isBackgroundRedrive = !!(msg.resume || msg.queuedRedrive)
    let typingStarted = false
    if (!isBackgroundRedrive && typeof adapter?.startTyping === 'function') {
      try { adapter.startTyping(replyTo); typingStarted = true }
      catch (e) { log.warn?.('[casey] startTyping failed', { caseId: fresh.id, error: e.message }) }
    }
    const stopTyping = () => {
      if (!typingStarted) return
      typingStarted = false
      try { adapter.stopTyping?.(replyTo) }
      catch (e) { log.warn?.('[casey] stopTyping failed', { caseId: fresh.id, error: e.message }) }
    }
    // A forced-tool-call turn (tool_choice:'required' below) that comes back
    // with NO tool call at all is retried with a fresh runTurn dispatch before
    // the turn is accepted as genuinely degraded -- freddie's own provider
    // fallback chain walks a live-availability-ranked model order per call,
    // not a fixed sequence, so each attempt is a genuinely different roll,
    // not a repeat of the same failing call. Without the retry the structural
    // guard stops a bad refusal from reaching the contact and leaves them with
    // total silence instead. 3, not 2: even CASEY_LLM_MODEL's own primary
    // misses tool_choice (mistral/codestral-latest missed on 2/2 attempts for a
    // plain, unambiguous location report). Capped, not unbounded, so a
    // persistently broken backend still fails within a bounded number of extra
    // round trips rather than doubling every contact's wait indefinitely.
    const MAX_TOOL_CHOICE_ATTEMPTS = 3
    // A resume/queue re-drive (msg.resume) is retrying a turn already known to
    // have failed before -- exempt it from the shared completion-health window
    // (see llm.js's recordHealth doc) so a burst of boot-time redrives of old
    // stuck cases can never gate a brand-new, unrelated contact's fresh message
    // into the LLM-down queue.
    const turnCallLLM = msg.resume ? (req) => callLLM(req, { recordHealth: false }) : callLLM
    // GUARANTEED-RESPONSE FSM, bounded turnaround: the turn's own start time
    // (TURN-START, just recorded above) anchors a remaining-budget calculation
    // for EACH attempt, so a multi-attempt retry loop can never exceed
    // TURN_HARD_DEADLINE_MS in total even though each individual attempt still
    // runs its own bounded per-hop chain walk (ACPTOAPI_CHAIN_LINK_TIMEOUT_MS
    // -- see TURN_HARD_DEADLINE_MS's own declaration above, which owns the
    // per-hop budget note, and AGENTS.md's Timeout Coordination section)
    // to completion rather than being cut off mid-hop. This is the "completing
    // through multiple samples" behavior: a retry attempt that starts with
    // real remaining budget gets a REAL chance, not an arbitrarily truncated
    // one -- only once the hard deadline is genuinely exhausted does the next
    // attempt get skipped (remainingMs <= 0 breaks the loop early, same as a
    // normal attempt exhaustion). A background redrive (msg.resume) is exempt
    // from this budget -- it already ran once as a live turn and is now a
    // background catch-up with its own separate retry/cap discipline
    // (RESUME_DEGRADED_RETRY_CAP in casey.js), not subject to the live-turn
    // guarantee at all.
    const turnStartedAt = Date.now()
    // Reply quality is judged INSIDE the attempt loop below: a judge-blanked,
    // verbatim-repeated, or false-confirming reply is a RETRYABLE miss with the
    // judge's reasons fed straight back to the model on the next attempt, never
    // an instant terminal degrade. Judging outside the loop sends a healthy
    // model's recoverable miss straight to the "Still working" fallback, and
    // parks a real report in draft limbo with no reply at all. The
    // fallback/draft paths below fire only once this retry budget is exhausted.
    let text = ''
    let jargonReasons = null
    let falseConfirmReasons = null
    let retryFeedback = null
    // Prior outbound for the repeat guards, hoisted: no new outbound can land
    // between attempts of THIS message's own turn, so one lookup serves all.
    const lastOutbound = [...events].reverse().find(e => e.kind === 'outbound')
    const lastOutboundText = lastOutbound?.text || null
    // The turn's active-case binding, mutable across attempts: a successful
    // case_new/case_switch inside an attempt rebinds via onActiveCaseChange
    // (case-tools.js), and the NEXT retry attempt's toolCtx must be built with
    // the NEW binding -- otherwise a retried turn's case_report for the
    // freshly-opened case is SECURITY-rejected exactly like the first
    // attempt's was before the rebind existed (live-witnessed: a new case's
    // symptoms/location writes rejected, facts lost).
    const turnBinding = { id: fresh.id, ref: fresh.ref }
    // Shared across ALL attempts of this turn: a retry is a FRESH runTurn that
    // cannot see the prior attempt's tool calls, so without cross-attempt
    // dedupe the model blindly repeats mutating calls and opens a SECOND case
    // for the same report. With a shared cache, an exact-repeat call returns
    // the first attempt's cached result instead of re-executing.
    const turnDedupeCache = new Map()
    // Human-readable record of successful mutating tool calls across attempts,
    // fed into retry prompts ("already DONE -- do not repeat") since the model
    // cannot see the prior attempt's tool results.
    const completedActions = []
    // Track degradation reason for this turn's failure (if any)
    let degradedReason = null
    let degradedErrorMsg = null
    for (let attempt = 1; attempt <= MAX_TOOL_CHOICE_ATTEMPTS; attempt++) {
      const configuredTimeoutMs = Number(process.env.CASEY_LLM_TURN_TIMEOUT_MS) || 120000
      const remainingMs = isBackgroundRedrive ? configuredTimeoutMs : (TURN_HARD_DEADLINE_MS - (Date.now() - turnStartedAt))
      if (!isBackgroundRedrive && remainingMs <= 0) {
        log.warn?.('[casey] turn hard deadline reached before this attempt could start; stopping retries', { caseId: fresh.id, attempt })
        if (!degradedReason) degradedReason = FAILURE_REASONS.TIMEOUT
        break
      }
      const attemptTimeoutMs = isBackgroundRedrive ? configuredTimeoutMs : Math.min(configuredTimeoutMs, remainingMs)
      // Same fail-closed tier resolution toolCtx.tier uses below -- computed once
      // here so both stay byte-identical, never two independent tier expressions
      // that could silently drift apart.
      const resolvedTier = contact?.tier === 'field_worker' ? 'field_worker' : 'reporter'
      try {
        result = await runTurn({
          // A retry after a judge-blank/false-confirm/empty carries the
          // judge's reasons back to the model as a system note, so the next
          // attempt corrects the actual defect instead of re-rolling blind.
          prompt: (retryFeedback ? prompt + retryFeedback : prompt)
            + (completedActions.length ? `\n\n[System note: these actions are ALREADY DONE from your earlier attempt -- do NOT call those tools again for the same facts: ${completedActions.join('; ')}.]` : ''),
          messages: [{ role: 'system', content: caseSystemPrompt(fresh, events, contact) }],
          sessionKey: `case:${fresh.id}`,
          callLLM: turnCallLLM,
          // Nudge the weak model into its first classify/record tool call. freddie
          // applies tool_choice on ITERATION 0 ONLY (later iterations are model
          // choice), so this cannot break loop termination -- the model is still free
          // to end the turn with plain text once its first tool result is in. The
          // offline stub ignores tool_choice, which is fine.
          tool_choice: 'required',
          // SECURITY: 'cases' ONLY. freddie's bootHost ALWAYS discovers its own
          // plugins/ directory (REPO_PLUGINS in freddie/src/host/index.js)
          // regardless of casey's extraRoots, so its full library -- including
          // 'core'-toolset tools with REAL shell/file/credential access (bash,
          // code_execution, edit, write, file_operations, credential_files,
          // read, grep, terminal) and send_message (bypasses every one of
          // casey's outbound scrubs/reference-sanitization) -- is registered
          // into the SAME host casey's agent turn draws from. Enabling 'core'
          // here exposed all of it, schema-visible and CALLABLE, to every
          // WhatsApp/Discord message from the public on every casey turn (a
          // confirmed-live, confirmed-exploitable vulnerability: getEnabledToolNames
          // returned 71 tools including a real, working bash handler). casey's
          // agent needs ONLY its own case_* tools -- it converses and calls
          // case_report/case_update/etc, nothing else, per AGENTS.md's own
          // 'the agent acts entirely through these tools' design principle.
          enabledToolsets: ['cases'],
          // A reporter-tier turn (the default, and the far more common contact
          // tier per AGENTS.md's contact.tier design) can never call the
          // field_worker-gated query/mutation tools anyway -- gateByTier's runtime handler check
          // already rejects them. Excluding their schemas from the request here
          // too (freddie's getEnabledToolSchemas filters `disabledToolsets` by
          // tool NAME, not by toolset category despite the parameter name) cuts
          // ~10KB/~2500 tokens of dead-weight tool-schema payload off every
          // reporter-tier turn's request size -- real headroom against a
          // smaller/lower-TPM provider's rate limit, and one less thing for a
          // weak model to waste a turn attempting to call and being rejected.
          // field_worker tier passes an empty array (every tool stays visible).
          disabledToolsets: resolvedTier === 'field_worker' ? [] : reporterTierExcludedToolNames(),
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
            // the dashboard read path is role:'operator'. This is a SEPARATE axis from
            // `tier` below -- role controls PII projection shape, tier controls which
            // case_* tools are reachable at all.
            role: 'worker',
            // Access tier: 'reporter' (casual/public, report-only) or 'field_worker'
            // (elevated -- agentic case_list/case_mine/case_today queries + location
            // check-ins). Read from the contact's own stored tier, operator-assigned
            // via the dashboard/CLI, NEVER contact-self-service or LLM-settable. Fails
            // CLOSED to 'reporter' on any falsy/missing/unrecognised value -- a brand
            // new contact, a pre-migration row with no tier populated yet, or a
            // corrupt value all get the LOWER-privilege tier, never silently elevated.
            tier: resolvedTier,
            store,
            principal: { id: msg.from || external_id, role: 'worker' },
            activeCaseRef: turnBinding.ref,
            activeCaseId: turnBinding.id,
            // The SHARED binding object itself: freddie shallow-copies toolCtx
            // per dispatch (host_helpers.js spreads ctx), which kills a bare
            // ctx.activeCaseId mutation from case_new/case_switch -- but the
            // copy keeps this object by REFERENCE, so a rebind through it is
            // visible to every later tool call in the turn and to the next
            // retry attempt (case-tools.js's boundCase reads it first).
            activeCaseBinding: turnBinding,
            // Shared across this turn's attempts (see the declaration above) --
            // an exact-repeat mutating call on a retry returns the cached
            // result instead of re-executing.
            dedupeCache: turnDedupeCache,
            now: Date.now(),
          },
          // freddie's runTurn defaults to 30s, which is too tight for a COLD first
          // turn (host boot + first provider probe) against the real bridge and
          // times out into a degraded reply. The lead providers answer in well
          // under a second once warm, so this bound protects the cold start
          // without abandoning a live contact for minutes.
          // CASEY_LLM_TURN_TIMEOUT_MS overrides for slow links / dead-provider walks.
          // attemptTimeoutMs additionally bounds this to the REMAINING hard-deadline
          // budget for a live turn (see the guaranteed-response FSM comment above);
          // a background redrive uses the plain configured value unbounded by that
          // budget, since it isn't subject to the live-turn guarantee at all.
          timeoutMs: attemptTimeoutMs,
        })
      } catch (e) {
        errored = true
        log.error?.('[casey] agent turn failed', { caseId: fresh.id, error: e.message })
        // Classify the failure reason: timeout vs provider down
        if (!degradedReason) {
          if (e.message?.includes('timeout') || e.message?.includes('deadline')) {
            degradedReason = FAILURE_REASONS.TIMEOUT
          } else if (e.message?.includes('provider') || e.message?.includes('unreachable') || e.message?.includes('404') || e.message?.includes('503')) {
            degradedReason = FAILURE_REASONS.PROVIDER
          } else {
            degradedReason = FAILURE_REASONS.RETRY_EXHAUSTED
          }
        }
        degradedErrorMsg = e.message
        // A failed write here (store down, lock timeout) must not throw OUT of this
        // catch block -- that would propagate as an unhandled rejection from the
        // whole handleInbound call, defeating the very error handling this block
        // exists for. Degrade to a log line; the degraded-turn no-reply path below
        // still records the failure regardless.
        try { await store.appendEvent(fresh.id, observation(`agent turn error: ${e.message}`)) }
        catch (e2) { log.error?.('[casey] failed to record agent-turn-error observation', { caseId: fresh.id, error: e2.message }) }
        result = {}
        break   // an error is not the forced-tool-choice-miss case; no retry benefit, stop here
      }
      // Judge the reply INSIDE the loop (see the loop-preamble comment): an
      // empty, verbatim-repeated, judge-blanked, or false-confirming reply is
      // a retryable miss -- the next attempt carries the reason back to the
      // model as retryFeedback. Only a budget-exhausted failure falls through
      // to the terminal fallback/draft paths after the loop.
      //
      // Retrying re-rolls model selection too: the bridge penalizes the served
      // model in the shared availability tracker on a detected miss, so a
      // fresh attempt routes around a model that keeps misbehaving instead of
      // hitting the identical broken one three times in a row.
      // stripThinkingBlock runs BEFORE anything judges the text: a reasoning-
      // family model's raw <think>...</think> block does leak through
      // server-side, and every check below must only ever reason about the real
      // intended reply, never the reasoning noise around it.
      const candidate = stripThinkingBlock((result?.result || '').toString().trim())
      // Record this attempt's successful mutating tool calls BEFORE any retry
      // decision, so a retry's prompt can name them as already-done.
      for (const action of mutatingActions(result)) completedActions.push(action)
      if (!candidate) {
        log.warn?.('[casey] agent turn produced empty reply', { caseId: fresh.id, attempt })
        try { await store.appendEvent(fresh.id, observation(`empty reply on attempt ${attempt}${attempt < MAX_TOOL_CHOICE_ATTEMPTS ? '; retrying' : ''}`)) }
        catch (e2) { log.warn?.('[casey] failed to record empty-reply observation', { caseId: fresh.id, error: e2.message }) }
        retryFeedback = "\n\n[System note: your previous reply came back empty and was not sent. Write a direct, warm reply to the contact's latest message.]"
        continue
      }
      // Verbatim repeat-of-last-outbound guard: a structural EQUALITY
      // comparison against this case's own real prior outbound event, not a
      // content classifier -- deterministic on purpose, since the
      // no-deterministic-text-classification directive targets JUDGING what a
      // reply MEANS, not comparing two strings for being the same string. A
      // small model with its own prior outbound visible in-context does parrot
      // the exact previous reply on a real, distinct message.
      if (lastOutboundText) {
        const strip = (s) => String(s).toLowerCase().replace(/CASE-\d+-[a-z0-9]+/gi, '').replace(/\s+/g, ' ').trim()
        if (strip(candidate) === strip(lastOutboundText)) {
          try { await store.appendEvent(fresh.id, observation(`model repeated its own last outbound verbatim on attempt ${attempt}; retrying`)) }
          catch (e2) { log.warn?.('[casey] failed to record repeat observation', { caseId: fresh.id, error: e2.message }) }
          retryFeedback = "\n\n[System note: your previous reply was a verbatim repeat of your earlier message and was not sent. Say something new that responds to the contact's latest message.]"
          continue
        }
      }
      // USER DIRECTIVE: no deterministic text classification anywhere -- what
      // the reply MEANS is judged by the single real-LLM judgeReply call
      // (hooks/reply-judge.js), never a regex/word-list. A jargon-only verdict
      // is NOT retried -- it is the one recoverable shape (real content, just
      // needs a human to reword one word), carried to the post-loop hold.
      const verdict = await judgeReply(turnCallLLM, candidate, { lastOutboundText, hadSuccessfulWrite: hadSuccessfulWrite(result), latestInbound: inboundText })
      if (verdict.clean) { text = candidate; break }
      if (verdict.category === 'jargon') { text = candidate; jargonReasons = verdict.reasons; break }
      if (verdict.reasons?.some(r => /false.?confirm|claims?.*record|confirm.*record/i.test(r))) {
        // False confirmation: the reply claims a write that never happened.
        // Retryable -- the feedback tells the model to actually call the tool
        // (tool_choice:'required' already forces a first call, so a fresh
        // attempt with this nudge has a real chance of doing the write for
        // real). Only a budget-exhausted false confirmation falls through to
        // the draft hold below.
        if (attempt < MAX_TOOL_CHOICE_ATTEMPTS) {
          log.warn?.('[casey] reply judge flagged a false confirmation; retrying turn with feedback', { caseId: fresh.id, attempt, reasons: verdict.reasons })
          try { await store.appendEvent(fresh.id, observation(`REPLY-JUDGE-FLAGGED: ${verdict.reasons.join('; ')}; retrying turn with feedback (attempt ${attempt})`)) }
          catch (e2) { log.warn?.('[casey] failed to record judge-retry observation', { caseId: fresh.id, error: e2.message }) }
          retryFeedback = '\n\n[System note: your previous reply was not sent because it claimed something was recorded or opened when nothing actually was. If the contact reported something new, call the case_new or case_report tool FIRST and wait for its result before replying. Never claim an action you did not actually perform.]'
          continue
        }
        text = candidate
        falseConfirmReasons = verdict.reasons
        break
      }
      if (verdict.reasons?.some(r => /repeated|echo|stock|meta.?commentary|planning narration/i.test(r))) {
        // Blankable shapes (repeated/echo/stock ack/meta-commentary) -- a
        // fresh attempt with the reasons fed back has a real chance at a
        // genuine reply; only a budget-exhausted flag blanks for real.
        if (attempt < MAX_TOOL_CHOICE_ATTEMPTS) {
          log.warn?.('[casey] reply judge flagged the composed reply; retrying turn with feedback', { caseId: fresh.id, attempt, reasons: verdict.reasons })
          try { await store.appendEvent(fresh.id, observation(`REPLY-JUDGE-FLAGGED: ${verdict.reasons.join('; ')}; retrying turn with feedback (attempt ${attempt})`)) }
          catch (e2) { log.warn?.('[casey] failed to record judge-retry observation', { caseId: fresh.id, error: e2.message }) }
          retryFeedback = `\n\n[System note: your previous reply was not sent: ${verdict.reasons.join('; ')}. Write a fresh reply that directly answers the contact's latest message -- do not repeat an earlier message and do not describe your own process or plans.]`
          continue
        }
        log.warn?.('[casey] reply judge flagged the composed reply; blanking', { caseId: fresh.id, reasons: verdict.reasons })
        await store.appendEvent(fresh.id, observation(`REPLY-JUDGE-FLAGGED: ${verdict.reasons.join('; ')}; blanked`))
        text = ''
        break
      }
      // Flagged but let-through (e.g. tool refusal -- the model's own words
      // directly answering what it was asked, however poorly, not narration
      // ABOUT a reply).
      log.warn?.('[casey] reply judge flagged the composed reply; sending anyway', { caseId: fresh.id, reasons: verdict.reasons })
      await store.appendEvent(fresh.id, observation(`REPLY-JUDGE-FLAGGED-BUT-SENT: ${verdict.reasons.join('; ')}`))
      text = candidate
      break
    }
    // Re-read the case after the agent turn: the agent may have completed intake via
    // case_report (or moved the stage) during the turn. Report-aware decisions below
    // -- the precedence gate, the fallback intake-advance, the jargon hold -- must see
    // what the agent just wrote, not the pre-turn snapshot. Without it, an agent that
    // completed intake this turn is overridden by a deterministic intake question and
    // a now-complete case never lets trusted model prose through.
    fresh = await store.getCase(fresh.id).catch(() => fresh)

    // Never send a raw error string to the contact. USER DIRECTIVE: no fallback
    // text -- a degraded turn (below) sends nothing and logs loud instead.
    // text / jargonReasons / falseConfirmReasons arrive from the attempt loop
    // above: extraction, the verbatim-repeat guard, and the real-LLM judge all
    // run IN-LOOP, so a flagged reply is retried with feedback rather than
    // blanked on the spot. Reaching this point with empty text means the whole
    // genuine retry budget (attempts x hard deadline) was spent.
    const isFallback = !text
    if (isFallback) {
      if (!errored && result?.error) {
        log.error?.('[casey] agent returned error result', { caseId: fresh.id, error: result.error })
        // Structured data.degraded_turn marker, not just free-form text: a
        // cross-case aggregate query (GET /api/turns/degraded, operations.js)
        // has to find every degraded turn across the whole system without
        // already knowing which case to look at, and prose alone is queryable
        // only by fragile substring matching.
        await store.appendEvent(fresh.id, observation(`agent result error: ${result.error}`, { degraded_turn: true, reason: 'error', error: String(result.error).slice(0, 500) }))
      }
      log.error?.('[casey] degraded turn produced no reply', { caseId: fresh.id })
      await store.appendEvent(fresh.id, observation('degraded turn (empty/error/echo/stock-ack/repeat); no reply sent.', { degraded_turn: true, reason: 'empty' }))
      // Plain (non-health-sweep) tag, read synchronously by attn.js alongside
      // every other tag-based signal -- a case with a prior degraded turn is a
      // priori more likely to degrade again (context corruption, a stuck
      // conversation), so the inbox nudges it up before a second failure
      // compounds. It stays a plain case.tags entry, NOT a case-health.js
      // ALL_HEALTH_TAGS member, because it is a per-turn event fact rather than
      // a periodic sweep classification -- rankAttention reads case.tags
      // directly with no event fetch, keeping the dashboard poll cheap.
      try { await store.updateCase(fresh.id, { tags: mergeTag(fresh.tags, 'degraded-turn-seen') }) }
      catch (e) { log.warn?.('[casey] degraded-turn-seen tag failed', { caseId: fresh.id, error: e.message }) }
    }
    // A turn that ended empty (model error OR empty/echo/stock-ack/repeat) is
    // DEGRADED: the agent never actually understood this message. Surfaced on
    // the reply object so drainQueuedTurns can treat a degraded re-drive as a
    // failed attempt instead of burning the queued message.
    const degraded = errored || isFallback

    // Final guard before the reply leaves (send OR assisted draft): correct any
    // fabricated/stale case reference to this case's real ref. A weak model recites
    // a memorized stock reply carrying the wrong ref; the contact must never be
    // handed a reference that does not resolve to their case. BUT an enquiry turn
    // (case_list/case_mine/case_today/case_get/case_link_suggestions) legitimately
    // cites OTHER cases' real refs per AGENTS.md's enquiry-surface design -- every
    // ref that actually came back from a tool call this turn is real, not
    // hallucinated, and must pass through unmodified. toolCaseRefs() collects
    // those; see turn-results.js for why it scans the raw tool-message content
    // rather than each tool's own result shape.
    {
      const { text: safeText, corrected } = sanitizeOutboundRef(text, fresh.ref, toolCaseRefs(result))
      if (corrected.length) {
        text = safeText
        await store.appendEvent(fresh.id, observation(`REF-CORRECTED: model emitted ${corrected.join(', ')}; rewrote to real ref ${fresh.ref}.`))
      }
    }

    // A genuinely non-degraded turn (the model produced real, usable content)
    // proves the AI is back online RIGHT NOW, independent of whether that
    // content ends up held for jargon or assisted-mode approval below. Keep this
    // clear AHEAD of both of those early-return guards: below either of them, a
    // successful-but-held reply never reaches the clear at all and a stale
    // ai-offline tag sits in the operator's offline queue while the AI is
    // healthy.
    if (!degraded && tagList(fresh).includes('ai-offline')) {
      try { await store.updateCase(fresh.id, { tags: dropTag(fresh.tags, 'ai-offline') }) }
      catch (e) { log.warn?.('[casey] ai-offline clear failed', { caseId: fresh.id, error: e.message }) }
    }

    // PRE-SEND JARGON GUARD: if the reply judge flagged the composed reply as a
    // jargon-only leak (case/triage/workflow/status/priority etc leaking through),
    // do NOT send it. Hold it as a draft for a human exactly like assisted mode --
    // the contact must never receive a jargon-laden reply, and a person rewrites
    // it plainly. This fires in ANY autonomy mode (the leak is a content defect,
    // not a mode choice) and runs before the assisted-mode branch so a jargon hit
    // holds even in auto mode. The judge's reasons are recorded as an observation
    // for the operator. Reuses the assisted draft-hold mechanics (draft event +
    // draft-pending + needs-human + notify-once). USER DIRECTIVE: no deterministic
    // text classification -- jargonReasons comes from the real-LLM judge above
    // (hooks/reply-judge.js), never a regex/word-list scan.
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
      stopTyping()
      return { to: replyTo, text: '', platform, caseId: fresh.id, drafted: true, jargonHeld: jargonReasons, falseConfirmationHeld: falseConfirmReasons }
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
      await flagNeedsHuman({ store, log, caseRow: fresh, notifyHandoff, channel, from: msg.from, extraTags: ['draft-pending'], flagLabel: 'assisted draft', notifyLabel: 'assisted draft' })
      // Nothing is sent in assisted mode -- return empty text so the gateway sends
      // nothing and the contact waits on a human-approved reply.
      stopTyping()
      return { to: replyTo, text: '', platform, caseId: fresh.id, drafted: true }
    }

    // Deterministic intake advance: a substantive inbound on a brand-new case
    // means the case is observably past "new" -- a real report has landed and a
    // reply is going out. The agent turn is SUPPOSED to call case_transition, but
    // a content-only model rarely emits tool calls, so relying on the LLM makes
    // the first stage change flaky. Move new->triaging here, deterministically,
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

    // AI-offline queue: when a turn is DEGRADED -- the agent turn itself failed
    // (model error/timeout), or it "succeeded" but produced unusable text
    // (prompt-echo/stock-ack/repeat-of-last-outbound/empty) -- the contact now gets
    // NOTHING sent (no fallback text, per the no-mocks-fallbacks-stubs invariant),
    // so a human needs a way to notice this silently-unanswered message. Tag the
    // case 'ai-offline' so it surfaces in the operator's offline queue (GET
    // /api/unreplied) and on the case list, on EITHER a genuine turn failure OR a
    // degraded/blanked reply -- both leave the contact unanswered. The next
    // operator reply clears it (claim-on-reply untags it), and a later successful
    // agent turn does too, via the clear half that runs earlier -- ahead of the
    // jargon/assisted-mode early returns. Best-effort: a tag failure must never
    // block the reply.
    if (degraded) {
      try { await store.updateCase(fresh.id, { tags: mergeTag(fresh.tags, 'ai-offline') }) }
      catch (e) { log.warn?.('[casey] ai-offline tag failed', { caseId: fresh.id, error: e.message }) }
    }

    // A QUEUED message re-driven (msg.queuedRedrive, set only by drainQueuedTurns)
    // while the backend is STILL degraded must NOT be burned: an outbound here
    // would positionally complete the queued msgId in drainQueuedTurns, so the
    // agent would never see the message. Record the failure as an OBSERVATION
    // (which completes nothing) and send nothing.
    if (msg.queuedRedrive && degraded) {
      await store.appendEvent(fresh.id, observation('degraded re-drive; still degraded, nothing sent'))
      return { to: replyTo, text: '', platform, caseId: fresh.id, degraded: true }
    }

    // GUARANTEED-RESPONSE FSM, terminal fallback: a degraded LIVE first-attempt
    // turn never sends total silence -- it sends the truthful status text
    // (STILL_WORKING_TEXT if the hard deadline has not yet been reached -- rare
    // here, since the attempt loop above already spent up to the whole
    // hard-deadline budget retrying, but a genuinely instant degrade, e.g. a
    // structural refusal caught before any real network wait, can still land
    // here well under the deadline -- vs TURN_TIMEOUT_TEXT once it has). A
    // background redrive (msg.resume / msg.queuedRedrive) stays SILENT on
    // degrade: it is a background catch-up re-drive of an old message the
    // contact has likely moved on from, never subject to the live-turn
    // guarantee (see isBackgroundRedrive's definition above, and the
    // queuedRedrive-specific silent return just above this block).
    if (isFallback) {
      if (isBackgroundRedrive) {
        return { to: replyTo, text: '', platform, caseId: fresh.id, degraded: true }
      }
      // Record degraded_turn event with reason classification (timeout/provider/retry-exhausted/llm-refusal)
      if (!degradedReason) {
        // If no specific reason was set during attempt loop, classify based on final state
        if (errored) {
          degradedReason = FAILURE_REASONS.RETRY_EXHAUSTED
        } else if (result?.error) {
          degradedReason = FAILURE_REASONS.LLM_REFUSAL
        } else {
          degradedReason = FAILURE_REASONS.RETRY_EXHAUSTED
        }
      }
      try {
        await recordDegradedTurn(store, {
          caseId: fresh.id,
          contactId: fresh.contact_id,
          reason: degradedReason,
          turnStartMs: turnStartedAt,
          channel,
        })
      } catch (e) { log.warn?.('[casey] failed to record degraded-turn event', { caseId: fresh.id, error: e.message }) }
      // Message tone is picked by the soft deadline alone -- see
      // TURN_SOFT_DEADLINE_MS's own declaration above for why fast-degrade
      // reads as "still working" and long-degrade as "having trouble".
      const elapsedMs = Date.now() - turnStartedAt
      const fallbackText = elapsedMs >= TURN_SOFT_DEADLINE_MS ? TURN_TIMEOUT_TEXT : STILL_WORKING_TEXT
      await store.appendEvent(fresh.id, {
        kind: 'outbound', actor: 'system', channel,
        text: fallbackText, data: { to: replyTo, fallback: isFallback, guaranteedFallback: true },
      })
      stopTyping()
      const fallbackReply = { to: replyTo, text: fallbackText, platform, caseId: fresh.id, degraded: true, guaranteedFallback: true }
      // Same rule as the reply path below: starts FALSE and goes true only once
      // a real send is attempted, so 'the guaranteed fallback went out' can
      // never be recorded for a turn that had no adapter to send it with.
      let fallbackDelivered = false
      try {
        if (typeof adapter?.send === 'function') { fallbackDelivered = true; await adapter.send(fallbackReply) }
      } catch (e) {
        fallbackDelivered = false
        log.error?.('[casey] guaranteed-fallback send failed', { caseId: fresh.id, error: e.message })
        // Mirrors the successful-reply path's send-failure visibility below.
        // This is the path meant to GUARANTEE an observable record for a
        // worried contact, so its own delivery failure must not be the one
        // silent case: the 'sent' event above already exists, and this adds the
        // correcting fact so the timeline is never wrong about whether the
        // fallback text actually reached the contact.
        await store.appendEvent(fresh.id, observation(`fallback send failed on ${channel}: ${e.message}`))
      }
      fallbackReply.delivered = fallbackDelivered
      return fallbackReply
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
    const reply = { to: replyTo, text, platform, caseId: fresh.id, ...(degraded ? { degraded: true } : {}) }
    // Opt-in voice reply: speak the (already-vetted, non-degraded) text back so a
    // low-literacy reporter can hear it. Additive -- text still sends; null when
    // disabled/unavailable/failed, leaving a plain text reply.
    const audio = await synthesizeVoice(text)
    if (audio) reply.audio = audio
    // Start FALSE and set it only inside the branch that earns it. Initialised
    // true above the guard, a turn with no resolved adapter records itself
    // delivered having sent nothing, and a broken adapter lookup stays hidden.
    let delivered = false
    if (adapter?.send) {
      delivered = true
      try { await adapter.send(reply) }
      catch (e) {
        delivered = false
        log.error?.('[casey] adapter.send failed', { caseId: fresh.id, platform, error: e.message })
        await store.appendEvent(fresh.id, observation(`send failed on ${channel}: ${e.message}`))
      }
    }
    // GUARANTEED-RESPONSE FSM, end: the real reply attempt (success or a failed
    // send, either way nothing more is coming) is the last point a typing
    // indicator should still be showing.
    stopTyping()
    return reply
    } finally { /* inFlight release now owned by handleInboundOnce's wrapper */ }
  }

  // Public entrypoint: run one turn, then drain any message a fast burst
  // buffered while that turn was in flight -- one extra turn per buffered
  // message, oldest-first, so a burst's later messages still reach a prompt
  // instead of vanishing at the guard. `this` is preserved via .call so the
  // adapter lookup inside handleInboundOnce still resolves (casey.js binds
  // handleInbound to the gateway instance).
  return async function handleInbound(platform, msg) {
    // Crash-safety backstop for the guaranteed-response FSM's typing indicator:
    // handleInboundOnceClaimed has no try/finally of its own around most of its
    // body, so an unhandled throw deep inside bypasses every stopTyping() call
    // threaded through its own return paths and leaks a live typing indicator
    // until Discord's own ~10s TTL expires it. adapter.stopTyping is idempotent
    // (a no-op if nothing was ever started for this channel -- see
    // DiscordAdapter's own Map-based tracking), so calling it here defensively
    // in a finally, keyed on the same replyTarget() the inner handler used to
    // start it, is safe on the many paths that never started one at all.
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
      // Route through `this.handleInbound` (the casey.js _wrapInflight-WRAPPED
      // reference -- `this` here is the gateway instance, and _wrapInflight
      // reassigns `this.gateway.handleInbound` to a tracked version immediately
      // after this very function is bound to it), NEVER the raw closure-local
      // `handleInbound` variable this function itself is bound to. A raw
      // self-call bypasses casey.js's `_inflight` tracking entirely, so a
      // burst-replay turn can still be mid-flight when casey.stop() closes the
      // store, and the replay throws "CaseStore not initialised".
      this.handleInbound(platform, next).catch(e => log.error?.('[casey] burst replay failed', { error: e.message }))
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


