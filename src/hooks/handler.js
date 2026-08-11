// hooks/handler.js -- casey's main inbound orchestration (makeCaseHandler).
//
// Split out of gateway-hooks.js (see AGENTS.md's Source map for the file's
// role). This is the ~850-line runTurn tool-loop orchestration: find/create
// case -> log inbound -> STOP/HUMAN short-circuit -> LLM-down queue gate ->
// rate limits -> agent turn -> outbound scrubs -> send. Moved verbatim; only
// the physical location and the source of its helper imports changed --
// every helper it calls (prompt construction, pure-text heuristics, media
// enrichment) now lives in a sibling hooks/*.js file, wired as ordinary ES
// module imports below.

import { runTurn } from 'freddie'
import { fmtTimeSAST } from '../format.js'
import { tagList } from '../timestamp.js'
import { reporterTierExcludedToolNames } from '../case-tools.js'
import { caseSystemPrompt } from './prompt.js'
import {
  truncate,
  sanitizeOutboundRef,
  CASE_REF_RE,
  stripChannelMarkup,
  detectContactIntent,
  mergeTag,
  dropTag,
  canAgentAct,
  stripThinkingBlock,
  OPTED_OUT_TAG,
} from './heuristics.js'
import { judgeReply } from './reply-judge.js'
import { transcribeAudio, describePhoto, synthesizeVoice } from './media.js'

const CHANNEL_DEFAULT = { whatsapp: 'whatsapp', discord: 'discord', sim: 'sim' }

// GUARANTEED-RESPONSE FSM (typing indicator + bounded turnaround + explicit
// fallback message). USER DIRECTIVE: every LIVE first-attempt turn must end
// in either a real chat reply or an explicit, truthful "still working" /
// "having trouble" status message -- never total silence. This is a
// deliberate, scoped evolution of the no-fallback-text principle, not a
// reversal of it: the banned thing was always FABRICATED case content or a
// scripted apology standing in for real understanding (a mock). A truthful
// status update ("still working on this", "having trouble right now, please
// try again in a moment") invents nothing and claims nothing about the
// contact's case -- it is the same class of honesty as the existing loud
// log lines, just also shown to the contact. Applies only to a live,
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
// walk -- acptoapi's own 20s-per-hop DEFAULT_LINK_TIMEOUT_MS -- to real
// completion rather than being cut off mid-hop; this is the "completing
// through multiple samples" behavior the design calls for: a retry that
// starts with real remaining budget gets a genuine chance, not an
// arbitrarily truncated one). Once the hard deadline is reached the loop
// stops retrying and the guaranteed-fallback text is composed and sent --
// see the attempt loop's own remainingMs calculation for exactly how each
// attempt's budget is derived.
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

// Returns an async (platform, msg) handler suitable to assign to
// gateway.handleInbound. `store` is a CaseStore; opts.callLLM optional;
// opts.autoRespond=false to track-only (no agent turn / reply). The typing
// indicator (adapter.startTyping/stopTyping) and the guaranteed-fallback send
// both reuse `adapter` (this.platforms.get(platform), already resolved per
// inbound below) -- no separate adapter set needs threading through here.
// Missing methods on a given channel degrade to a no-op, never a thrown error
// (typing is a UX affordance, never load-bearing).
export function makeCaseHandler(store, { callLLM = null, llmStatus = null, autoRespond = true, log = console, notifyHandoff = null } = {}) {
  // Per-contact in-flight guard: if a prior agent turn is still running for this
  // contact, we drop the new message rather than race two concurrent LLM calls
  // against the same case. The contact's inbound is still recorded (above), so
  // nothing is lost -- the next turn will pick up the full conversation including
  // this message. The guard is keyed on external_id (the canonical contact key).
  const inFlight = new Set()
  // A message that arrives while a prior turn is still in flight for the same
  // contact is recorded (inbound event, above the guard) but was previously
  // dropped from ever reaching a future prompt -- a fast burst ("the cow" /
  // "by the dam" / "not eating") lost every message but the first the guard let
  // through. Buffer the raw msg per contact; once the in-flight turn's finally
  // block clears the guard, replay ONE more handleInbound call for any buffered
  // text, oldest-first, same shape as the existing LLM-down queue drain.
  const pendingBuffer = new Map()   // external_id -> msg[] (raw, unprocessed)
  // Per-contact rate limit: inFlight only blocks a SIMULTANEOUS second message
  // while a turn is running -- it does nothing to bound SEQUENTIAL message rate
  // over time, so one contact could otherwise drive unbounded LLM spend and
  // store writes. A sliding window of recent turn-start timestamps per contact;
  // over the cap, the message is dropped (no reply, no LLM turn) and logged/recorded
  // but skips the LLM turn entirely.
  const rateWindows = new Map()   // external_id -> number[] (recent turn-start ms)
  const RATE_LIMIT_MSGS = Number(process.env.CASEY_RATE_LIMIT_MSGS) || 10
  const RATE_LIMIT_WINDOW_MS = Number(process.env.CASEY_RATE_LIMIT_WINDOW_MS) || 60_000
  function rateLimited(id, now = Date.now()) {
    sweepRateWindows(now)
    const hits = (rateWindows.get(id) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS)
    hits.push(now)
    rateWindows.set(id, hits)
    return hits.length > RATE_LIMIT_MSGS
  }
  // rateWindows never removes a key on its own (a contact that goes quiet after
  // its window empties out still leaves an entry), so a long-running process
  // with many one-time senders grows the Map unboundedly. A periodic sweep
  // (piggybacked on the natural rate-check cadence, not its own timer) evicts
  // any contact with no hits inside the current window.
  const RATE_SWEEP_INTERVAL_MS = 10 * 60_000
  let lastRateSweep = 0
  function sweepRateWindows(now = Date.now()) {
    if (now - lastRateSweep < RATE_SWEEP_INTERVAL_MS) return
    lastRateSweep = now
    for (const [id, hits] of rateWindows) {
      if (!hits.some(t => now - t < RATE_LIMIT_WINDOW_MS)) rateWindows.delete(id)
    }
  }
  // GLOBAL rate limit: the per-contact window above bounds each external_id
  // independently, so many DISTINCT senders (a distributed source, or simply
  // many legitimate contacts at once) have no aggregate ceiling -- each gets
  // its own fresh RATE_LIMIT_MSGS/WINDOW allowance, so total case creation and
  // LLM spend across all contacts is unbounded. A second sliding window, same
  // shape, keyed by a fixed sentinel instead of external_id, caps AGGREGATE
  // volume regardless of how many distinct ids are sending.
  const globalRateWindow = []   // number[] (recent turn-start ms, all contacts)
  const GLOBAL_RATE_LIMIT_MSGS = Number(process.env.CASEY_GLOBAL_RATE_LIMIT_MSGS) || 200
  const GLOBAL_RATE_LIMIT_WINDOW_MS = Number(process.env.CASEY_GLOBAL_RATE_LIMIT_WINDOW_MS) || 60_000
  function globallyRateLimited(now = Date.now()) {
    let i = 0
    while (i < globalRateWindow.length && now - globalRateWindow[i] >= GLOBAL_RATE_LIMIT_WINDOW_MS) i++
    if (i) globalRateWindow.splice(0, i)
    globalRateWindow.push(now)
    return globalRateWindow.length > GLOBAL_RATE_LIMIT_MSGS
  }
  // Claims inFlight SYNCHRONOUSLY, before handleInboundOnceClaimed's first
  // await (rateLimited/findOrCreateCase/recordInbound), not after --
  // Set.has+Set.add with no await between them is an atomic critical section
  // under JS's single-threaded/cooperative concurrency, closing a race the
  // OLD later in-flight check (originally sitting well past several awaited
  // store calls) could not: two overlapping handleInboundOnce calls for the
  // same contact could both pass that later check before either had reached
  // the point of adding itself to inFlight. A burstReplay call is the
  // ALREADY-in-flight turn for this contact being re-driven (see the
  // trailing drain block below) so it does not re-claim here; it runs as the
  // sole owner of an existing claim instead. This wrapper -- not a change to
  // handleInboundOnceClaimed's own ~850-line body -- is what guarantees the
  // claim is released on EVERY exit path (return or throw) via the single
  // finally below, without needing to hunt down every one of that body's
  // many early returns individually.
  async function handleInboundOnce(platform, msg) {
    const channel = CHANNEL_DEFAULT[platform] || platform || 'other'
    const external_id = conversationKey(msg)   // per-contact case IDENTITY
    const replyTo = replyTarget(msg)           // channel/chat DELIVERY target
    if (!msg.burstReplay) {
      if (inFlight.has(external_id)) {
        log.info?.('[casey] skipping concurrent LLM turn, buffered for replay', { channel })
        msg.burstReplay = true
        const BUFFER_CAP = 20
        const buf = pendingBuffer.get(external_id) || []
        buf.push(msg)
        if (buf.length > BUFFER_CAP) {
          buf.shift()
          log.warn?.('[casey] burst buffer cap exceeded, oldest message dropped', { channel, cap: BUFFER_CAP })
        }
        pendingBuffer.set(external_id, buf)
        return { to: replyTo, text: '', platform, skipped: true, buffered: true }
      }
      inFlight.add(external_id)
    }
    try {
      return await handleInboundOnceClaimed.call(this, platform, msg, channel, external_id, replyTo)
    } finally {
      if (!msg.burstReplay) inFlight.delete(external_id)
    }
  }
  async function handleInboundOnceClaimed(platform, msg, channel, external_id, replyTo) {
    const adapter = this?.platforms?.get?.(platform)
    // Rate limits are checked here, before findOrCreateCase/recordInbound run
    // any store write, so a signature-verified flood is turned away without
    // driving unbounded case/event writes -- checking only after those writes
    // (as this used to) still protected the LLM spend but let the flood itself
    // through to the store on every single message. A buffered-then-replayed
    // message must not be rate-checked a second time for the same human
    // message (only the FIRST arrival, before it was buffered, consumed a
    // window slot) -- double-counting a burst against its own buffer defeats
    // the "buffered, never dropped" guarantee the buffer exists to provide.
    if (!msg.burstReplay && rateLimited(external_id)) {
      log.error?.('[casey] rate limit: skipping turn, no store write, no reply sent', { channel })
      return { to: replyTo, text: '', platform, rateLimited: true }
    }
    if (globallyRateLimited()) {
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
    if (!msgId) log?.warn?.('[casey] inbound message missing id; dedup guarantee not applied', { channel, external_id })

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
    // Strip channel mention markup (e.g. Discord's "<@BOTID> hello" for an
    // "@memobot hello") so it never reaches capture/intent: the mention's numeric
    // id was being read as a livestock count, flipping a bare greeting out of the
    // content-free path into the case-ack. The raw msg.text is still recorded by
    // recordInbound below for audit; only the reasoning copy is cleaned.
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
      // Unlike every sibling store call around it (findOrCreateCase above,
      // appendReportField below), this one had no try/catch of its own -- a
      // transient store error here (thatcher busy, a lock timeout) threw
      // straight past this point and silently dropped the WHOLE inbound turn,
      // with only casey.js's _wrapInflight backstop (its own comment admits
      // it's a backstop, not a real handler) standing between this and an
      // unhandled rejection. Same explicit-drop discipline as the
      // findOrCreateCase catch above: log loud, send nothing (no fallback text).
      log.error?.('[casey] recordInbound failed; dropping inbound', { caseId: caseRow.id, channel, error: e.message })
      return { to: replyTo, text: '', platform, caseId: caseRow.id, error: e.message }
    }
    // A resume re-drive (msg.resume) intentionally carries the ORIGINAL msg_id of
    // an inbound already recorded -- recordInbound correctly returns null. That is
    // the expected path here, not a duplicate to drop: the boot resume sweep is
    // re-running the turn for a message whose inbound persisted but whose reply
    // never went out. Fall through to the agent turn instead of short-circuiting.
    // Same reasoning for msg.burstReplay: the fast-message-burst buffer (below)
    // stores the ORIGINAL msg object, whose inbound was already recorded the
    // first time this same message hit the inFlight guard -- the replay re-enters
    // this same function to actually run the turn, not to re-record a redelivery.
    // Without this exemption the replay always self-dedupes on its own earlier
    // recording and silently no-ops, defeating the "buffered and replayed, never
    // silently dropped" design principle -- the message ends up IN the event log
    // but never gets a real reply.
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
        await store.appendEvent(caseRow.id, { kind: 'observation', actor: 'system', text: 'DRAFT SUPERSEDED: a new message arrived; the pending draft reply was set aside for a fresh one.' })
      } catch (e) { log.warn?.('[casey] draft supersede failed', { caseId: caseRow.id, error: e.message }) }
    }
    // One-shot: a received animal photo is recorded as explicit case state right
    // here, deterministically, so the operator always sees that a picture exists
    // -- never relying on the agent turn to notice it (it may not, on a media-only
    // message). APPEND-only (appendReportField), never fill-if-empty: a worker
    // routinely sends more than one photo/voice note across a conversation, and
    // fill-if-empty silently discarded every arrival after the first with no
    // field update and no observation event -- the exact silent-loss bug this
    // fixes. In observe mode appendReportField refuses the report WRITE (that
    // guard stays -- observe means no automatic field edits), but the ARRIVAL of
    // a photo/voice note must still be visible in the timeline (observe is
    // exactly the mode with no LLM narration to compensate), so a plain
    // observation event is appended even when the field write was refused. A
    // failure here must never block the reply path.
    // Normalize msg.media across adapter shapes: WhatsApp's adapter resolves a
    // SINGLE object ({type, mimeType, buffer}, freddie's platform-whatsapp
    // handler.js), but Discord's resolves an ARRAY (one entry per attachment,
    // freddie's platform-discord handler.js _resolveAttachments). Every read
    // below used to assume the WhatsApp shape unconditionally
    // (msg.media?.buffer), so on Discord msg.media.buffer was always undefined
    // (arrays have no .buffer property) -- isPhotoMsg/isAudioMsg were
    // permanently false, meaning every Discord photo/voice note was stuck at
    // the honest-degradation floor ("farmer sent a photo", no bytes saved, no
    // transcription/description) even with real downloaded bytes sitting right
    // there and CASEY_DESCRIBE_PHOTOS/CASEY_TRANSCRIBE_VOICE_NOTES enabled.
    // Picking the first entry that actually has a buffer (a failed-download
    // entry may be null/error-only) mirrors WhatsApp's own single-object
    // degrade shape; Array.isArray is false for WhatsApp's object, so this is
    // a no-op there (mediaItem === msg.media, byte-identical to before).
    const mediaItem = Array.isArray(msg.media) ? (msg.media.find(m => m?.buffer) || msg.media[0]) : msg.media
    // When the channel adapter actually downloaded the media bytes (mediaItem),
    // save them to disk and fold the saved path into the note -- otherwise the
    // note is text-only ("farmer sent a photo") with nothing behind it, which is
    // exactly the "looks captured but isn't" gap this closes. A download failure
    // (mediaItem.error set, buffer null) still yields the plain text note, same
    // as before freddie could fetch media at all -- never a harder failure.
    const photoNote = inboundImageNote(msg)
    if (photoNote) {
      try {
        let note = photoNote
        const isPhotoMsg = mediaItem?.buffer && mediaItem.type !== 'audio'
        if (isPhotoMsg) {
          const savedPath = store.saveMedia(caseRow.id, mediaItem.buffer, { mimeType: mediaItem.mimeType, kind: 'photo' })
          note = `${photoNote} (saved: ${savedPath})`
          const description = await describePhoto(mediaItem.buffer, mediaItem.mimeType)
          if (description) note += ` -- described: "${truncate(description, 500)}"`
        }
        const r = await store.appendReportField(caseRow.id, 'photos', note)
        if (r?.appended || r?.error === 'observe') {
          await store.appendEvent(caseRow.id, { kind: 'observation', actor: 'system', text: `PHOTO RECEIVED: ${note} (recorded for the field team).` })
        }
        if (r?.reportWasCorrupted) {
          await store.appendEvent(caseRow.id, { kind: 'observation', actor: 'system', text: 'WARNING: this case\'s stored report JSON was corrupted and has been reset before appending this photo note -- some previously recorded fields may be lost.' })
        }
      } catch (e) { log.warn?.('[casey] photo mark failed', { caseId: caseRow.id, error: e.message }) }
    }
    // Same discipline for a voice note: record it as explicit state so an
    // operator always sees EVERY voice message arrive, even on an audio-only
    // message the agent turn might not narrate. Append-only; never blocks the reply.
    // Transcription (opt-in via CASEY_TRANSCRIBE_VOICE_NOTES=1) runs BEFORE the
    // note is composed so a successful transcript is folded straight into the
    // recorded field -- a failure/opt-out yields '' and the note reads exactly
    // as it always did (operator listens, per the original degrade rung).
    const isAudioMsg = mediaItem?.buffer && mediaItem.type === 'audio'
    const transcript = isAudioMsg ? await transcribeAudio(mediaItem.buffer, mediaItem.mimeType) : ''
    const audioNote = inboundAudioNote(msg, transcript)
    if (audioNote) {
      try {
        let note = audioNote
        if (isAudioMsg) {
          const savedPath = store.saveMedia(caseRow.id, mediaItem.buffer, { mimeType: mediaItem.mimeType, kind: 'audio' })
          note = `${audioNote} (saved: ${savedPath})`
        }
        const r = await store.appendReportField(caseRow.id, 'audio', note)
        if (r?.appended || r?.error === 'observe') {
          await store.appendEvent(caseRow.id, { kind: 'observation', actor: 'system', text: `AUDIO RECEIVED: ${note}.` })
        }
        if (r?.reportWasCorrupted) {
          await store.appendEvent(caseRow.id, { kind: 'observation', actor: 'system', text: 'WARNING: this case\'s stored report JSON was corrupted and has been reset before appending this audio note -- some previously recorded fields may be lost.' })
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
        if (!tagList(caseRow).includes('intake_mode:channel')) {
          await store.updateCase(caseRow.id, { tags: mergeTag(caseRow.tags, 'intake_mode:channel') })
        }
      } catch (e) { log.warn?.('[casey] intake_mode tag failed', { error: e.message }) }
      // Unlike its immediate siblings above (subject seed, intake_mode tag),
      // this append had no try/catch -- a transient store error here silently
      // dropped the whole inbound turn with no reply, no observation, no
      // logged reason. This event is audit-trail decoration (the case already
      // exists by this point), so a failure here must never block the reply
      // path -- best-effort, same discipline as every other non-critical
      // append in this function.
      try { await store.appendEvent(caseRow.id, { kind: 'note', actor: 'system', text: `Case opened from ${channel}` }) }
      catch (e) { log.warn?.('[casey] case-opened note failed', { caseId: caseRow.id, error: e.message }) }
    }

    if (!autoRespond) return { to: replyTo, text: '', platform, caseId: caseRow.id }

    // Unguarded like the two fixed above -- a transient store error here
    // silently dropped the entire agent turn (the STOP/HUMAN short-circuit,
    // the LLM call, the reply) past this point with no explicit error
    // response. The case row from findOrCreateCase (caseRow) is a fine
    // fallback: it is only slightly staler (missing whatever the
    // append/updateCase calls just above wrote), and a genuinely broken store
    // will fail again on the very next real call in this turn, surfacing
    // loudly there instead of vanishing here.
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
    // REGARDLESS of autonomy mode: an observe-mode contact can still say STOP or
    // ask for a person, and that request is irreversible/legal, not something an
    // operator's autonomy choice can silently swallow. This check therefore runs
    // BEFORE the observe-mode early-return below. Everything else (status, help,
    // greeting, enquiry, report, extraction) is now the agent's job via the case
    // tools in the runTurn loop further down. Empty/media messages return null
    // here and fall through unchanged.
    let optedOut = tagList(fresh).includes(OPTED_OUT_TAG)
    const intent = detectContactIntent(inboundText)
    // HELP-RESUME: an opted-out contact who sends "help" (any supported language)
    // OPTS BACK IN -- the opted-out tag is cleared, the opt-back-in is recorded, and
    // a short warm resume ack goes out. Subsequent messages reach the agent normally.
    // Without this, a STOP was a permanent dead-end (nothing ever cleared the tag).
    if (optedOut && intent === 'help') {
      try { await store.updateCase(fresh.id, { tags: dropTag(fresh.tags, OPTED_OUT_TAG) }) }
      catch (e) { log.warn?.('[casey] opt-back-in untag failed', { caseId: fresh.id, error: e.message }) }
      optedOut = false
      await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'OPT-BACK-IN: contact asked for help after opting out; messages resumed.' })
      // USER DIRECTIVE: no hardcoded language handling anywhere -- same fix as
      // the STOP/HUMAN branch below. The state change above (untagging
      // opted-out) is the real, unconditional control; the acknowledgement
      // TEXT no longer comes from guessLang+intentReply's canned strings.
      // With the LLM down, log loud and send nothing (matches the queue-gate
      // pattern) rather than a hardcoded-language fallback; otherwise fall
      // through to the normal agent turn to compose a real, language-
      // mirrored resume acknowledgement.
      let helpDown = false
      if (typeof llmStatus === 'function') {
        try { const st = await llmStatus(); helpDown = st && st.ok === false } catch { helpDown = false }
      }
      if (helpDown) {
        log.error?.('[casey] LLM backend down; opt-back-in state recorded but no reply composed (no hardcoded-language fallback)', { caseId: fresh.id })
        await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'RESUME-ACK-DEGRADED: LLM unreachable; opt-back-in was applied, but no acknowledgement reply could be composed.', data: { degraded_turn: true, reason: 'llm_down_on_irreversible_control' } })
        return { to: replyTo, text: '', platform, caseId: fresh.id, intent: 'resume', degraded: true }
      }
      // Fall through to the normal agent turn below -- it composes the real
      // resume acknowledgement, in the person's own language, from the
      // OPT-BACK-IN observation already on the case timeline.
    }
    // Respect a prior opt-out: once someone said STOP, do not auto-reply again
    // unless they explicitly ask for help (handled above) or a human.
    if (optedOut && intent !== 'human') {
      await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'contact previously opted out; no auto-reply' })
      return { to: replyTo, text: '', platform, caseId: fresh.id, optedOut: true }
    }
    if (intent === 'stop' || intent === 'human') {
      if (intent === 'human') {
        // detectContactIntent returns 'human' for EVERY message with a human
        // keyword, so the notify must fire only on the FIRST handoff for this
        // case -- otherwise a contact repeating "person?" re-pings every time.
        // mergeTag is idempotent; the notify is not.
        const alreadyFlagged = tagList(fresh).includes('needs-human')
        // STATE-CHANGING WRITE FIRST, independently guarded: this used to run
        // AFTER an unguarded appendEvent (the audit-trail note two lines
        // below), so a transient thatcher/lock error on that leading append
        // threw before this write ever ran, silently losing the needs-human
        // flag with no record the handoff was ever requested -- an
        // irreversible-control tag must be structurally guaranteed to persist
        // independent of whether its own audit-trail note happens to land.
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
        try { await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'HANDOFF REQUESTED: contact asked for a human. Needs an operator.' }) }
        catch (e) { log.warn?.('[casey] handoff audit event failed', { caseId: fresh.id, error: e.message }) }
      } else if (intent === 'stop') {
        // Same ordering fix as the human branch above: the state-changing
        // opt-out tag write must never be gated behind its own audit-trail
        // append succeeding first -- STOP is a legal opt-out control and must
        // be structurally guaranteed to persist even if the append throws.
        try { await store.updateCase(fresh.id, { tags: mergeTag(fresh.tags, OPTED_OUT_TAG) }) }
        catch (e) { log.warn?.('[casey] opt-out flag failed', { caseId: fresh.id, error: e.message }) }
        try { await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'OPT-OUT: contact asked to stop messaging.' }) }
        catch (e) { log.warn?.('[casey] opt-out audit event failed', { caseId: fresh.id, error: e.message }) }
        // A stop can arrive packed with real report content ("...please stop
        // messaging me") -- the agent never sees it (opt-out means no further
        // engagement, correctly), so any facts in the same message would
        // otherwise rest silently in the append-only inbound event with nothing
        // making them actionable. A distinct, worst-first-visible observation
        // gives a human the chance to read and act on it manually.
        const substantive = String(inboundText || '').trim().length >= 20
        if (substantive) {
          await store.appendEvent(fresh.id, {
            kind: 'observation', actor: 'system',
            text: `STOP-WITH-CONTENT: the opt-out message also carried possible report content -- review manually: ${truncate(inboundText, 300)}`,
            data: { guardrail: 'stop_with_content' },
          })
          try { await store.updateCase(fresh.id, { tags: mergeTag(fresh.tags, 'needs-human') }) }
          catch (e) { log.warn?.('[casey] stop-with-content flag failed', { caseId: fresh.id, error: e.message }) }
        }
      }
      // USER DIRECTIVE: no hardcoded language handling anywhere -- the LLM is the
      // only thing that provides language interpretation and response. The
      // STOP/HUMAN state change above (opt-out tag, needs-human flag, audit
      // trail, handoff notify) is a real legal/safety control and MUST persist
      // regardless of LLM health -- that part stays fully deterministic and
      // unconditional. But the REPLY TEXT used to be composed via guessLang's
      // hardcoded per-language word-cue tables + intentReply's canned per-
      // language strings specifically so it could "still work" with the LLM
      // down. That is exactly the silent-fallback shape the no-mocks/no-
      // fallbacks invariant already forbids everywhere else in this file (the
      // LLM-down queue gate below sends nothing and logs loud, never a scripted
      // apology) -- this branch was the one deterministic-language exception
      // to that rule, kept for a stated reason (a legal control must not
      // depend on ONE thing succeeding) that turned out not to require a
      // canned-text fallback at all: the STATE CHANGE (the actual legal
      // action) already does not depend on the LLM, so the LLM-composed reply
      // can now fail loudly exactly like every other turn instead of getting
      // a silent deterministic substitute.
      let down = false
      if (typeof llmStatus === 'function') {
        try { const st = await llmStatus(); down = st && st.ok === false } catch { down = false }
      }
      if (down) {
        log.error?.('[casey] LLM backend down; opt-out/handoff state recorded but no reply composed (no hardcoded-language fallback)', { caseId: fresh.id, intent })
        await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `${intent.toUpperCase()}-ACK-DEGRADED: LLM unreachable; the ${intent} control itself was applied, but no acknowledgement reply could be composed.`, data: { degraded_turn: true, reason: 'llm_down_on_irreversible_control' } })
        return { to: replyTo, text: '', platform, caseId: fresh.id, intent, degraded: true }
      }
      // Reply target is external_id (the conversation key), NOT msg.from. On
      // Discord, freddie's adapter POSTs to /channels/{to}/messages, so `to` must
      // be the channel id (conversationKey), not the author id -- sending to the
      // author id silently fails (Discord 404, swallowed by .then(json)) and the
      // contact never sees a reply. external_id is correct for WhatsApp too, where
      // conversationKey falls back to msg.from (the phone number).
      //
      // The acknowledgement text itself is now composed by the SAME real-LLM
      // turn path every other reply uses (runTurn further below), never a
      // canned per-language string -- see the deferred-to-agent note this
      // replaces. STOP/HUMAN's own state change already happened above,
      // unconditionally; falling through here lets the normal agent turn
      // compose a warm, correctly-mirrored-language acknowledgement instead
      // of a hardcoded one, while the irreversible control itself already
      // took effect regardless of what the agent turn produces or whether it
      // even completes.
    }

    // observe-mode: the agent does not act or reply automatically; a human
    // drives the case. We still recorded the inbound above, and STOP/HUMAN (the
    // irreversible controls) already had their chance to fire above this check --
    // this only gates the ordinary conversational/report turn that follows.
    if (fresh.autonomy === 'observe') {
      await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'autonomy=observe: awaiting operator (no auto-reply)' })
      // Observe mode means a human drives, but the case must still SURFACE for one
      // -- otherwise an observe-mode contact waits silently with nothing in the
      // triage inbox. Flag needs-human (the observable handoff signal) and notify
      // once on first flag, exactly like an explicit human request. Do NOT raise
      // priority: casey surfaces the request; the operator decides urgency.
      const alreadyFlagged = tagList(fresh).includes('needs-human')
      try {
        await store.updateCase(fresh.id, { tags: mergeTag(fresh.tags, 'needs-human') })
        if (notifyHandoff && !alreadyFlagged) {
          try { await notifyHandoff({ case: fresh, channel, from: msg.from }) }
          catch (e) { log.warn?.('[casey] observe handoff notify failed', { caseId: fresh.id, error: e.message }) }
        }
      } catch (e) { log.warn?.('[casey] observe needs-human flag failed', { caseId: fresh.id, error: e.message }) }
      return { to: replyTo, text: '', platform, caseId: fresh.id, observed: true }
    }

    // Everything else -- status, help, greeting, thanks, enquiry, report, field
    // extraction, the whole conversation -- is now the AGENT'S job. No deterministic
    // pre-route: the message goes straight into the runTurn tool loop below, where
    // the model classifies and acts by calling the case tools (case_report,
    // case_list, case_get, case_mine/case_today, case_new, case_stop). The old
    // keyword/shape router + STATUS-BY-REF + enquiry/answer/chitchat short-circuits
    // are removed; the soft dead-end is structurally impossible because the agent,
    // not a phrase maze, decides the reply.

    const contact = fresh.contact_id ? await store.getContact(fresh.contact_id).catch(() => null) : null
    const events = await store.listEvents(fresh.id)
    const prompt = inboundText || (media ? `The contact sent ${media} with no text. Acknowledge and ask how you can help.` : 'The contact sent an empty message. Acknowledge politely.')

    // LLM-DOWN QUEUE GATE. A message that arrives while the backend is down cannot
    // be understood now -- so QUEUE it and re-drive when the provider recovers
    // (drainQueuedTurns on the down->up edge). The inbound is already recorded
    // above; here we append a durable QUEUED-FOR-AGENT marker and return WITHOUT a
    // TURN-START (so the resume sweep does not also claim it). USER DIRECTIVE: no
    // fallback text -- log loud, send nothing, rely on the queue to re-drive once
    // the provider (the in-process acptoapi bridge) is actually reachable. Guarded
    // once per msgId. STOP/HUMAN are handled by the deterministic short-circuit
    // ABOVE this gate, so an opt-out during an outage still fires synchronously
    // and is never queued.
    if (typeof llmStatus === 'function' && !msg.resume) {
      let down = false
      try { const st = await llmStatus(); down = st && st.ok === false } catch { down = false }
      if (down) {
        const already = events.some(e => e.kind === 'observation' && typeof e.text === 'string' && e.text === `QUEUED-FOR-AGENT:${msgId}`)
        if (!already) {
          try {
            await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `QUEUED-FOR-AGENT:${msgId}` })
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
    }

    // Per-contact concurrency gate: the claim itself now happens synchronously
    // at function entry, before this point is ever reached (see the top of
    // handleInboundOnce) -- a concurrent arrival is buffered and returns long
    // before reaching here. This is just the buffered-turn's own case-scoped
    // audit note, logged once we have a real case row to attach it to.
    if (msg.burstReplay) {
      await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'concurrent turn skipped: prior LLM turn still in-flight for this contact; buffered for replay' })
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
    try { await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `TURN-START:${msgId}` }) }
    catch (e) { log.warn?.('[casey] turn-start marker failed', { caseId: fresh.id, error: e.message }) }
    // GUARANTEED-RESPONSE FSM, start: a live, first-attempt turn (never a
    // background resume/queue re-drive -- see isBackgroundRedrive) shows a
    // typing indicator for its whole duration. Best-effort: startTyping is a
    // UX affordance, never load-bearing -- an adapter with no typing support
    // (WhatsApp today) or a failed POST degrades silently, never blocks or
    // throws into the real turn. stopTyping is called from EVERY exit path
    // below via the tryStopTyping() helper (including the crash-net's own
    // reach -- but a genuine process crash bypasses this entirely, which is
    // fine: Discord's own typing indicator expires on its own ~10s TTL with
    // no re-POST, so a crashed turn's indicator self-clears, it does not hang
    // forever).
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
    // Which MUTATING tool calls succeeded in this attempt? Feeds the
    // cross-attempt "already DONE -- do not repeat" retry note (a retry is a
    // fresh runTurn; the model cannot see the prior attempt's tool results,
    // and live-witnessed re-opened the same case / re-reported the same facts
    // without it). Same name-by-tool_call_id mapping as
    // hadSuccessfulWriteThisTurn (freddie's tool-role messages carry no name).
    function mutatingActionsThisAttempt(r) {
      if (!Array.isArray(r?.messages)) return []
      const MUTATING = new Set(['case_new', 'case_report', 'case_update', 'case_transition', 'case_switch'])
      const nameById = new Map()
      for (const m of r.messages) {
        if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) nameById.set(tc.id || tc.tool_call_id, tc.name || tc.function?.name)
        }
      }
      const done = []
      for (const m of r.messages) {
        if (m?.role !== 'tool' || !m.content) continue
        const tname = nameById.get(m.tool_call_id)
        if (!tname || !MUTATING.has(tname)) continue
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        try {
          const parsed = JSON.parse(content)
          if (parsed && parsed.ok === true) {
            const detail = parsed.activeCase?.ref ? ` (${parsed.activeCase.ref})`
              : parsed.fields ? ` (${Object.keys(parsed.fields).join(', ')})` : ''
            done.push(`${tname}${detail}`)
          }
        } catch { /* not a recognized success result */ }
      }
      return done
    }
    // Did case_report/case_update actually WRITE something this turn? A
    // structural fact read straight from this turn's real tool-call results
    // (role:'tool' messages), never a text classifier -- feeds reply-judge.js's
    // FALSE CONFIRMATION shape (the judge itself still decides whether the
    // reply's WORDS claim a write happened; this only supplies the ground
    // truth of whether one actually did). A tool result is JSON-stringified
    // by the bridge; {"ok":true,...} is case_report/case_update's own success
    // shape (see case-tools.js). Any parse failure or non-matching content
    // counts as no write, never a false positive.
    function hadSuccessfulWriteThisTurn(r) {
      if (!Array.isArray(r?.messages)) return false
      const WRITE_TOOLS = new Set(['case_report', 'case_update', 'case_new'])
      // Tool-role messages carry tool_call_id but never a `name` (freddie's
      // machine.js only ever sets {tool_call_id, content} on them) -- the name
      // lives on the preceding assistant message's tool_calls[].name instead.
      const nameById = new Map()
      for (const m of r.messages) {
        if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) nameById.set(tc.id || tc.tool_call_id, tc.name || tc.function?.name)
        }
      }
      for (const m of r.messages) {
        if (m?.role !== 'tool' || !m.content) continue
        const tname = nameById.get(m.tool_call_id)
        if (tname && !WRITE_TOOLS.has(tname)) continue
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        try {
          const parsed = JSON.parse(content)
          if (parsed && parsed.ok === true) return true
        } catch { /* not JSON or not this shape -- not a recognized write result */ }
      }
      return false
    }
    // A forced-tool-call turn (tool_choice:'required' below) that comes back
    // with NO tool call at all is retried with a fresh runTurn dispatch before
    // the turn is accepted as genuinely degraded -- freddie's own provider
    // fallback chain walks a live-availability-ranked model order per call,
    // not a fixed sequence, so each attempt is a genuinely different roll,
    // not a repeat of the same failing call.
    // Witnessed live this session: the structural guard alone correctly
    // stopped a bad refusal from reaching the contact, but then left them
    // with total silence -- a retry gives the contact a real chance at an
    // actual reply before giving up. Raised from 2 to 3: even
    // CASEY_LLM_MODEL's own primary occasionally misses tool_choice
    // (witnessed live: mistral/codestral-latest missed on 2/2 attempts for a
    // plain "I'm in sheppie" location report with no ambiguity at all) --
    // capped, not unbounded, so a persistently broken backend still fails
    // within a bounded number of extra round trips rather than doubling
    // every contact's wait time indefinitely.
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
    // gets to run its own bounded chain walk (acptoapi's own 20s per-hop
    // timeout -- see chain-machine.js's DEFAULT_LINK_TIMEOUT_MS) to
    // completion rather than being cut off mid-hop. This is the "completing
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
    // verbatim-repeated, or false-confirming reply is a RETRYABLE miss with
    // the judge's reasons fed straight back to the model on the next attempt
    // -- never an instant terminal degrade. Live-witnessed why: a judge
    // 'repeated reply' blank went straight to the "Still working" fallback
    // while the model was healthy and seconds away from a real answer, and a
    // false-confirmation hold parked a real report ("my chickens are sick")
    // in draft limbo with no reply at all. The fallback/draft paths below now
    // only fire once this genuine retry budget is exhausted.
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
    // dedupe the model blindly repeats mutating calls (live-witnessed: a
    // retried turn opened a SECOND case for the same report). With a shared
    // cache, an exact-repeat call returns the first attempt's cached result
    // instead of re-executing.
    const turnDedupeCache = new Map()
    // Human-readable record of successful mutating tool calls across attempts,
    // fed into retry prompts ("already DONE -- do not repeat") since the model
    // cannot see the prior attempt's tool results.
    const completedActions = []
    for (let attempt = 1; attempt <= MAX_TOOL_CHOICE_ATTEMPTS; attempt++) {
      const configuredTimeoutMs = Number(process.env.CASEY_LLM_TURN_TIMEOUT_MS) || 120000
      const remainingMs = isBackgroundRedrive ? configuredTimeoutMs : (TURN_HARD_DEADLINE_MS - (Date.now() - turnStartedAt))
      if (!isBackgroundRedrive && remainingMs <= 0) {
        log.warn?.('[casey] turn hard deadline reached before this attempt could start; stopping retries', { caseId: fresh.id, attempt })
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
            // Same discipline as ownsCase's "no author on ctx -> not owned" fail-closed
            // guard a few lines up in case-tools.js.
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
          // turn (host boot + first provider probe) against the real bridge -- the
          // crucible run timed out there and the contact got a degraded reply. The
          // lead providers answer in well under a second once warm, so this bound
          // protects the cold start without abandoning a live contact for minutes.
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
        // A failed write here (store down, lock timeout) must not throw OUT of this
        // catch block -- that would propagate as an unhandled rejection from the
        // whole handleInbound call, defeating the very error handling this block
        // exists for. Degrade to a log line; the degraded-turn no-reply path below
        // still records the failure regardless.
        try { await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `agent turn error: ${e.message}` }) }
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
      // fresh attempt genuinely routes around a model that keeps misbehaving
      // instead of hitting the identical broken one three times in a row.
      // stripThinkingBlock BEFORE anything judges the text -- a reasoning-
      // family model's raw <think>...</think> block leaked through server-side
      // once already (live-witnessed); every check below must only ever reason
      // about the real intended reply, never the reasoning noise around it.
      const candidate = stripThinkingBlock((result?.result || '').toString().trim())
      // Record this attempt's successful mutating tool calls BEFORE any retry
      // decision, so a retry's prompt can name them as already-done.
      for (const action of mutatingActionsThisAttempt(result)) completedActions.push(action)
      if (!candidate) {
        log.warn?.('[casey] agent turn produced empty reply', { caseId: fresh.id, attempt })
        try { await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `empty reply on attempt ${attempt}${attempt < MAX_TOOL_CHOICE_ATTEMPTS ? '; retrying' : ''}` }) }
        catch (e2) { log.warn?.('[casey] failed to record empty-reply observation', { caseId: fresh.id, error: e2.message }) }
        retryFeedback = "\n\n[System note: your previous reply came back empty and was not sent. Write a direct, warm reply to the contact's latest message.]"
        continue
      }
      // Verbatim repeat-of-last-outbound guard: a structural EQUALITY
      // comparison against this case's own real prior outbound event, not a
      // content classifier -- kept deterministic (the no-deterministic-text-
      // classification directive targets JUDGING what a reply MEANS, not
      // comparing two strings for being the same string). Live-witnessed: a
      // small model (its own prior outbound visible in-context) parroted the
      // exact previous reply verbatim on a real, distinct message.
      if (lastOutboundText) {
        const strip = (s) => String(s).toLowerCase().replace(/CASE-\d+-[a-z0-9]+/gi, '').replace(/\s+/g, ' ').trim()
        if (strip(candidate) === strip(lastOutboundText)) {
          try { await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `model repeated its own last outbound verbatim on attempt ${attempt}; retrying` }) }
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
      const verdict = await judgeReply(turnCallLLM, candidate, { lastOutboundText, hadSuccessfulWrite: hadSuccessfulWriteThisTurn(result), latestInbound: inboundText })
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
          try { await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `REPLY-JUDGE-FLAGGED: ${verdict.reasons.join('; ')}; retrying turn with feedback (attempt ${attempt})` }) }
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
          try { await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `REPLY-JUDGE-FLAGGED: ${verdict.reasons.join('; ')}; retrying turn with feedback (attempt ${attempt})` }) }
          catch (e2) { log.warn?.('[casey] failed to record judge-retry observation', { caseId: fresh.id, error: e2.message }) }
          retryFeedback = `\n\n[System note: your previous reply was not sent: ${verdict.reasons.join('; ')}. Write a fresh reply that directly answers the contact's latest message -- do not repeat an earlier message and do not describe your own process or plans.]`
          continue
        }
        log.warn?.('[casey] reply judge flagged the composed reply; blanking', { caseId: fresh.id, reasons: verdict.reasons })
        await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `REPLY-JUDGE-FLAGGED: ${verdict.reasons.join('; ')}; blanked` })
        text = ''
        break
      }
      // Flagged but let-through (e.g. tool refusal -- the model's own words
      // directly answering what it was asked, however poorly, not narration
      // ABOUT a reply).
      log.warn?.('[casey] reply judge flagged the composed reply; sending anyway', { caseId: fresh.id, reasons: verdict.reasons })
      await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `REPLY-JUDGE-FLAGGED-BUT-SENT: ${verdict.reasons.join('; ')}` })
      text = candidate
      break
    }
    // Re-read the case after the agent turn: the agent may have completed intake via
    // case_report (or moved the stage) during the turn. Report-aware decisions below
    // -- the precedence gate, the fallback intake-advance, the jargon hold -- must see
    // what the agent just wrote, not the pre-turn snapshot. Without this, an agent
    // that completed intake this turn is still overridden by a deterministic intake
    // question, and a now-complete case never lets trusted model prose through.
    fresh = await store.getCase(fresh.id).catch(() => fresh)

    // Never send a raw error string to the contact. USER DIRECTIVE: no fallback
    // text -- a degraded turn (below) sends nothing and logs loud instead.
    // text / jargonReasons / falseConfirmReasons arrive from the attempt loop
    // above: extraction, the verbatim-repeat guard, and the real-LLM judge all
    // run IN-LOOP now so a flagged reply is retried with feedback instead of
    // being blanked on the spot. Reaching this point with empty text means the
    // whole genuine retry budget (attempts x hard deadline) was spent.
    const isFallback = !text
    if (isFallback) {
      if (!errored && result?.error) {
        log.error?.('[casey] agent returned error result', { caseId: fresh.id, error: result.error })
        // Structured data.degraded_turn marker (not just free-form text) so a
        // cross-case aggregate query (GET /api/turns/degraded, operations.js)
        // can reliably find every degraded turn across the whole system without
        // already knowing which case to look at -- the prose-only text this
        // event used to carry alone was queryable only by fragile substring
        // matching, or by an operator who happened to already be looking at
        // THIS specific case's own timeline.
        await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `agent result error: ${result.error}`, data: { degraded_turn: true, reason: 'error', error: String(result.error).slice(0, 500) } })
      }
      log.error?.('[casey] degraded turn produced no reply', { caseId: fresh.id })
      await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'degraded turn (empty/error/echo/stock-ack/repeat); no reply sent.', data: { degraded_turn: true, reason: 'empty' } })
      // Plain (non-health-sweep) tag, read synchronously by attn.js's
      // attnScore alongside every other tag-based signal -- a case with a
      // prior degraded turn is a priori more likely to degrade again
      // (context corruption, a stuck conversation), so the inbox should
      // already nudge it up before a second failure compounds. Kept as a
      // plain case.tags entry (not a case-health.js ALL_HEALTH_TAGS member)
      // since this is a per-turn event fact, not a periodic sweep
      // classification -- rankAttention already reads case.tags directly with
      // no event fetch, so this stays a synchronous, cheap dashboard-poll cost.
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
    // hallucinated, and must pass through unmodified. Scan the raw tool-message
    // content (already JSON-stringified by the bridge) for ref-shaped tokens
    // rather than parsing each tool's own result shape -- a superset is safe here
    // since only a token this regex would ALSO strip out of the reply is at risk.
    {
      const toolRefs = []
      if (Array.isArray(result?.messages)) {
        for (const m of result.messages) {
          if (m?.role !== 'tool' || !m.content) continue
          const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
          const found = content.match(CASE_REF_RE)
          if (found) toolRefs.push(...found)
        }
      }
      const { text: safeText, corrected } = sanitizeOutboundRef(text, fresh.ref, toolRefs)
      if (corrected.length) {
        text = safeText
        await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `REF-CORRECTED: model emitted ${corrected.join(', ')}; rewrote to real ref ${fresh.ref}.` })
      }
    }

    // A genuinely non-degraded turn (the model produced real, usable content)
    // proves the AI is back online RIGHT NOW, independent of whether that
    // content ends up held for jargon or assisted-mode approval below --
    // clearing the stale ai-offline flag here (moved ahead of both of those
    // early-return guards) instead of only after them means a jargon-held or
    // assisted-draft reply still clears a prior failure's flag. Previously
    // this lived after the jargon guard's own early return, so a successful-
    // but-jargon-laden reply held as a draft never reached the clear logic at
    // all, leaving a stale ai-offline tag in the operator's offline queue even
    // though the AI had genuinely recovered.
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
      await store.appendEvent(fresh.id, {
        kind: 'observation', actor: 'system',
        text: holdNote,
      })
      await store.appendEvent(fresh.id, {
        kind: 'draft', actor: 'agent', channel,
        text, data: { to: replyTo, fallback: isFallback, draft: true, jargon: jargonReasons, falseConfirmation: falseConfirmReasons },
      })
      const alreadyFlagged = tagList(fresh).includes('needs-human')
      try {
        await store.updateCase(fresh.id, { tags: mergeTag(mergeTag(fresh.tags, 'draft-pending'), 'needs-human') })
        if (notifyHandoff && !alreadyFlagged) {
          try { await notifyHandoff({ case: fresh, channel, from: msg.from }) }
          catch (e) { log.warn?.('[casey] reply-hold notify failed', { caseId: fresh.id, error: e.message }) }
        }
      } catch (e) { log.warn?.('[casey] reply-hold flag failed', { caseId: fresh.id, error: e.message }) }
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
      const alreadyFlagged = tagList(fresh).includes('needs-human')
      try {
        await store.updateCase(fresh.id, { tags: mergeTag(mergeTag(fresh.tags, 'draft-pending'), 'needs-human') })
        if (notifyHandoff && !alreadyFlagged) {
          try { await notifyHandoff({ case: fresh, channel, from: msg.from }) }
          catch (e) { log.warn?.('[casey] assisted draft notify failed', { caseId: fresh.id, error: e.message }) }
        }
      } catch (e) { log.warn?.('[casey] assisted draft flag failed', { caseId: fresh.id, error: e.message }) }
      // Nothing is sent in assisted mode -- return empty text so the gateway sends
      // nothing and the contact waits on a human-approved reply.
      stopTyping()
      return { to: replyTo, text: '', platform, caseId: fresh.id, drafted: true }
    }

    // Deterministic intake advance: a substantive inbound on a brand-new case
    // means the case is observably past "new" -- a real report has landed and a
    // reply is going out. The agent turn is SUPPOSED to call case_transition, but
    // the production model is content-only (it rarely emits tool calls) and even
    // the stub can leave the move uncommitted, so relying on the LLM makes the
    // first stage change flaky. We move new->triaging here, deterministically,
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
    // agent turn does too (the clear half now runs earlier, ahead of the
    // jargon/assisted-mode early returns -- see that comment above -- so only
    // the tag-ON-degraded half remains here). Best-effort: a tag failure must
    // never block the reply.
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
      await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'degraded re-drive; still degraded, nothing sent' })
      return { to: replyTo, text: '', platform, caseId: fresh.id, degraded: true }
    }

    // GUARANTEED-RESPONSE FSM, terminal fallback: a degraded LIVE first-attempt
    // turn no longer sends total silence -- it sends the truthful status text
    // (STILL_WORKING_TEXT if the hard deadline has not yet been reached --
    // rare here, since the attempt loop above already spent up to the whole
    // hard-deadline budget retrying, but a genuinely instant degrade, e.g. a
    // structural refusal caught before any real network wait, can still land
    // here well under the deadline -- vs TURN_TIMEOUT_TEXT once it has). A
    // background redrive (msg.resume / msg.queuedRedrive) stays SILENT on
    // degrade, unchanged from before: it is a background catch-up re-drive of
    // an old message the contact has likely moved on from, never subject to
    // the live-turn guarantee (see isBackgroundRedrive's definition above,
    // and the queuedRedrive-specific silent return just above this block).
    if (isFallback) {
      if (isBackgroundRedrive) {
        return { to: replyTo, text: '', platform, caseId: fresh.id, degraded: true }
      }
      // Message tone: a turn that degraded FAST (a structural refusal, an
      // immediate provider auth error -- under the soft deadline) reads as
      // "still working, one moment" since a quick retry from the contact's
      // next message has a real chance of landing on a healthier attempt. A
      // turn that ran long (spent real time genuinely retrying/waiting on
      // providers, past the soft deadline) reads as the more honest "having
      // trouble" -- the contact has already been waiting a while and a vague
      // "still working" would understate that.
      const elapsedMs = Date.now() - turnStartedAt
      const fallbackText = elapsedMs >= TURN_SOFT_DEADLINE_MS ? TURN_TIMEOUT_TEXT : STILL_WORKING_TEXT
      await store.appendEvent(fresh.id, {
        kind: 'outbound', actor: 'system', channel,
        text: fallbackText, data: { to: replyTo, fallback: isFallback, guaranteedFallback: true },
      })
      stopTyping()
      const fallbackReply = { to: replyTo, text: fallbackText, platform, caseId: fresh.id, degraded: true, guaranteedFallback: true }
      let fallbackDelivered = true
      try {
        if (typeof adapter?.send === 'function') await adapter.send(fallbackReply)
      } catch (e) {
        fallbackDelivered = false
        log.error?.('[casey] guaranteed-fallback send failed', { caseId: fresh.id, error: e.message })
        // Mirrors the successful-reply path's send-failure visibility below --
        // this is precisely the path meant to GUARANTEE an observable record
        // for a worried farmer, so its own delivery failure must not be the
        // one silent case. The 'sent' event above already exists; this adds
        // the correcting fact so the timeline is never wrong about whether
        // the fallback text actually reached the contact.
        await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `fallback send failed on ${channel}: ${e.message}` })
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
    let delivered = true
    if (adapter?.send) {
      try { await adapter.send(reply) }
      catch (e) {
        delivered = false
        log.error?.('[casey] adapter.send failed', { caseId: fresh.id, platform, error: e.message })
        await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `send failed on ${channel}: ${e.message}` })
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
  // buffered while that turn was in flight (see pendingBuffer above) -- one
  // extra turn per buffered message, oldest-first, so a burst's later messages
  // still reach a prompt instead of vanishing once the guard dropped them.
  // `this` is preserved via .call so the platform-adapter lookup inside
  // handleInboundOnce still resolves (casey.js binds handleInbound to the
  // gateway instance).
  return async function handleInbound(platform, msg) {
    // Crash-safety backstop for the guaranteed-response FSM's typing indicator:
    // handleInboundOnceClaimed (the ~850-line body handleInboundOnce's claim
    // wrapper delegates to) has no try/finally of its own around most of that
    // body, so an unhandled throw deep inside would otherwise bypass every
    // stopTyping() call threaded through its own return paths, leaking a live
    // typing indicator until Discord's own ~10s TTL silently expires it.
    // adapter.stopTyping is idempotent (a no-op if
    // nothing was ever started for this channel -- see DiscordAdapter's own
    // Map-based tracking), so calling it here defensively in a finally, keyed
    // on the same replyTarget() the inner handler used to start it, is safe
    // even on the many paths that never started one at all.
    const adapter = this?.platforms?.get?.(platform)
    let result
    try {
      result = await handleInboundOnce.call(this, platform, msg)
    } finally {
      try { adapter?.stopTyping?.(replyTarget(msg)) } catch { /* best-effort */ }
    }
    const external_id = conversationKey(msg)
    const buf = pendingBuffer.get(external_id)
    if (buf && buf.length && !inFlight.has(external_id)) {
      const next = buf.shift()
      if (!buf.length) pendingBuffer.delete(external_id)
      else pendingBuffer.set(external_id, buf)
      // Fire-and-forget: the replay is a full turn in its own right (it will
      // append its own events/outbound), not something the original caller
      // should block on -- mirrors how drainQueuedTurns re-drives independently.
      // Routed through `this.handleInbound` (the casey.js _wrapInflight-WRAPPED
      // reference -- `this` here is the gateway instance, and _wrapInflight
      // reassigns `this.gateway.handleInbound` to a tracked version
      // immediately after this very function is bound to it), NOT the raw
      // closure-local `handleInbound` variable this function itself is bound
      // to. The raw self-call bypassed casey.js's `_inflight` tracking
      // entirely, so a burst-replay turn could still be mid-flight when
      // casey.stop() closed the store -- live-witnessed: "CaseStore not
      // initialised -- call init() first" thrown from a replay turn racing a
      // real stop() call during a test run.
      this.handleInbound(platform, next).catch(e => log.error?.('[casey] burst replay failed', { error: e.message }))
    }
    return result
  }
}

// The conversation/case IDENTITY -- per CONTACT, not per channel. A Discord server
// channel carries many authors; keying on the channel alone made everyone in it
// share ONE case (a second worker's "hello" landed on the first worker's case). So
// when the container (channel/chat) and the author differ -- a multi-person channel
// -- the key is "container:author". A 1:1 chat (WhatsApp, where the chat id IS the
// person, or there is no separate container) stays the single id. This is identity
// only; the reply DELIVERY target is replyTarget() below (the channel), because
// Discord posts to the channel, not the author.
export function conversationKey(msg) {
  const container = msg.raw?.channel_id || msg.raw?.chatId || msg.chatId || ''
  const author = msg.from || ''
  if (container && author && container !== author) return `${container}:${author}`
  return container || author || 'unknown'
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
// 400 Invalid Form Body (live-witnessed: an operator transition's stage note
// failed to deliver with exactly that) -- the channel container alone is the
// target. 1:1 channels (WhatsApp) carry no ':' composite and pass through
// unchanged.
export function caseDeliveryTarget(caseRow) {
  const ext = String(caseRow?.external_id || '')
  if ((caseRow?.channel || '') === 'discord' && ext.includes(':')) return ext.slice(0, ext.indexOf(':'))
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
// not an image) and record a note at ingress, append-only. When a transcript is
// available (see transcribeAudio below) it is folded into the note; otherwise the
// operator listens and can fill the richer detail -- an honest degradation rung,
// not a silent drop. Returns '' when THIS message carries no audio.
function inboundAudioNote(msg, transcript = '') {
  const r = msg.raw || {}
  const tail = transcript ? ` -- transcript: "${truncate(transcript, 500)}"` : ''
  const base = 'farmer sent a voice note (listen and record what it says)' + tail
  if (r.audio || r.voice || r.type === 'audio' || r.type === 'voice') return base
  const atts = Array.isArray(r.attachments) ? r.attachments : []
  const auds = atts.filter(a => typeof (a?.content_type || a?.contentType || a?.mimetype) === 'string'
    && /^audio\//i.test(a.content_type || a.contentType || a.mimetype))
  if (auds.length) return base
  return ''
}
