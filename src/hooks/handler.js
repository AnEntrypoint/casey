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
import { orientCase, advanceCase } from '../conversation-state.js'
import { caseSystemPrompt } from './prompt.js'
import {
  truncate,
  isPromptEcho,
  sanitizeOutboundRef,
  CASE_REF_RE,
  isStockAck,
  isToolRefusal,
  isMetaCommentary,
  jargonHits,
  guessLang,
  stripChannelMarkup,
  detectContactIntent,
  mergeTag,
  dropTag,
  canAgentAct,
  intentReply,
} from './heuristics.js'
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
// log lines, just also shown to the contact. Applies ONLY to a live,
// first-attempt turn (not msg.resume / msg.queuedRedrive, which are
// background catch-up re-drives of an OLD message the contact has likely
// moved on from -- see the isBackgroundRedrive guard below).
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
const TURN_HARD_DEADLINE_MS = Number(process.env.CASEY_TURN_HARD_DEADLINE_MS) || 60000
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
  async function handleInboundOnce(platform, msg) {
    const channel = CHANNEL_DEFAULT[platform] || platform || 'other'
    const external_id = conversationKey(msg)   // per-contact case IDENTITY
    const replyTo = replyTarget(msg)           // channel/chat DELIVERY target
    const adapter = this?.platforms?.get?.(platform)
    // Rate limits are checked here, before findOrCreateCase/recordInbound run
    // any store write, so a signature-verified flood is turned away without
    // driving unbounded case/event writes -- checking only after those writes
    // (as this used to) still protected the LLM spend but let the flood itself
    // through to the store on every single message.
    if (rateLimited(external_id)) {
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
    const inboundEvent = await store.recordInbound(caseRow, {
      channel,
      text: inboundText || (media ? `[${media}]` : '[empty message]'),
      data: {}, msg_id: msgId,
    })
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
    if ((caseRow.tags || '').split(',').map(s => s.trim()).includes('draft-pending')) {
      try {
        await store.updateCase(caseRow.id, { tags: (caseRow.tags || '').split(',').map(s => s.trim()).filter(t => t && t !== 'draft-pending').join(',') })
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
    // When the channel adapter actually downloaded the media bytes (msg.media),
    // save them to disk and fold the saved path into the note -- otherwise the
    // note is text-only ("farmer sent a photo") with nothing behind it, which is
    // exactly the "looks captured but isn't" gap this closes. A download failure
    // (msg.media.error set, buffer null) still yields the plain text note, same
    // as before freddie could fetch media at all -- never a harder failure.
    const photoNote = inboundImageNote(msg)
    if (photoNote) {
      try {
        let note = photoNote
        const isPhotoMsg = msg.media?.buffer && msg.media.type !== 'audio'
        if (isPhotoMsg) {
          const savedPath = store.saveMedia(caseRow.id, msg.media.buffer, { mimeType: msg.media.mimeType, kind: 'photo' })
          note = `${photoNote} (saved: ${savedPath})`
          const description = await describePhoto(msg.media.buffer, msg.media.mimeType)
          if (description) note += ` -- described: "${truncate(description, 500)}"`
        }
        const r = await store.appendReportField(caseRow.id, 'photos', note)
        if (r?.appended || r?.error === 'observe') {
          await store.appendEvent(caseRow.id, { kind: 'observation', actor: 'system', text: `PHOTO RECEIVED: ${note} (recorded for the field team).` })
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
    const isAudioMsg = msg.media?.buffer && msg.media.type === 'audio'
    const transcript = isAudioMsg ? await transcribeAudio(msg.media.buffer, msg.media.mimeType) : ''
    const audioNote = inboundAudioNote(msg, transcript)
    if (audioNote) {
      try {
        let note = audioNote
        if (isAudioMsg) {
          const savedPath = store.saveMedia(caseRow.id, msg.media.buffer, { mimeType: msg.media.mimeType, kind: 'audio' })
          note = `${audioNote} (saved: ${savedPath})`
        }
        const r = await store.appendReportField(caseRow.id, 'audio', note)
        if (r?.appended || r?.error === 'observe') {
          await store.appendEvent(caseRow.id, { kind: 'observation', actor: 'system', text: `AUDIO RECEIVED: ${note}.` })
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
        const tags = String(caseRow.tags || '').split(',').map(t => t.trim()).filter(Boolean)
        if (!tags.includes('intake_mode:channel')) {
          await store.updateCase(caseRow.id, { tags: [...tags, 'intake_mode:channel'].join(',') })
        }
      } catch (e) { log.warn?.('[casey] intake_mode tag failed', { error: e.message }) }
      await store.appendEvent(caseRow.id, { kind: 'note', actor: 'system', text: `Case opened from ${channel}` })
    }

    if (!autoRespond) return { to: replyTo, text: '', platform, caseId: caseRow.id }

    let fresh = await store.getCase(caseRow.id)

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
    const optedOut = (fresh.tags || '').split(',').map(s => s.trim()).includes('opted-out')
    const intent = detectContactIntent(inboundText)
    // HELP-RESUME: an opted-out contact who sends "help" (any supported language)
    // OPTS BACK IN -- the opted-out tag is cleared, the opt-back-in is recorded, and
    // a short warm resume ack goes out. Subsequent messages reach the agent normally.
    // Without this, a STOP was a permanent dead-end (nothing ever cleared the tag).
    if (optedOut && intent === 'help') {
      try { await store.updateCase(fresh.id, { tags: dropTag(fresh.tags, 'opted-out') }) }
      catch (e) { log.warn?.('[casey] opt-back-in untag failed', { caseId: fresh.id, error: e.message }) }
      await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'OPT-BACK-IN: contact asked for help after opting out; messages resumed.' })
      const text = intentReply('resume', fresh, guessLang(inboundText))
      await store.appendEvent(fresh.id, {
        kind: 'outbound', actor: 'system', channel,
        text, data: { to: replyTo, intent: 'resume', deterministic: true },
      })
      const reply = { to: replyTo, text, platform, caseId: fresh.id, intent: 'resume' }
      if (adapter?.send) {
        try { await adapter.send(reply) }
        catch (e) {
          log.error?.('[casey] adapter.send failed', { caseId: fresh.id, platform, error: e.message })
          await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `send failed on ${channel}: ${e.message}` })
        }
      }
      return reply
    }
    // Respect a prior opt-out: once someone said STOP, do not auto-reply again
    // unless they explicitly ask for help (handled above) or a human.
    if (optedOut && intent !== 'human') {
      await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'contact previously opted out; no auto-reply' })
      return { to: replyTo, text: '', platform, caseId: fresh.id, optedOut: true }
    }
    if (intent === 'stop' || intent === 'human') {
      if (intent === 'human') {
        await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'HANDOFF REQUESTED: contact asked for a human. Needs an operator.' })
        // detectContactIntent returns 'human' for EVERY message with a human
        // keyword, so the notify must fire only on the FIRST handoff for this
        // case -- otherwise a contact repeating "person?" re-pings every time.
        // mergeTag is idempotent; the notify is not.
        const alreadyFlagged = (fresh.tags || '').split(',').map(s => s.trim()).includes('needs-human')
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
      } else if (intent === 'stop') {
        await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'OPT-OUT: contact asked to stop messaging.' })
        try { await store.updateCase(fresh.id, { tags: mergeTag(fresh.tags, 'opted-out') }) }
        catch (e) { log.warn?.('[casey] opt-out flag failed', { caseId: fresh.id, error: e.message }) }
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
      // A plain, warm deterministic acknowledgement for the irreversible control --
      // no LLM needed (and it must work with the model down). intentReply still
      // carries the per-language stop/human confirmation strings.
      const text = intentReply(intent, fresh, guessLang(inboundText))
      await store.appendEvent(fresh.id, {
        kind: 'outbound', actor: 'system', channel,
        text, data: { to: replyTo, intent, deterministic: true },
      })
      // Reply target is external_id (the conversation key), NOT msg.from. On
      // Discord, freddie's adapter POSTs to /channels/{to}/messages, so `to` must
      // be the channel id (conversationKey), not the author id -- sending to the
      // author id silently fails (Discord 404, swallowed by .then(json)) and the
      // contact never sees a reply. external_id is correct for WhatsApp too, where
      // conversationKey falls back to msg.from (the phone number).
      const reply = { to: replyTo, text, platform, caseId: fresh.id, intent }
      if (adapter?.send) {
        try { await adapter.send(reply) }
        catch (e) {
          log.error?.('[casey] adapter.send failed', { caseId: fresh.id, platform, error: e.message })
          await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `send failed on ${channel}: ${e.message}` })
        }
      }
      return reply
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
      const alreadyFlagged = (fresh.tags || '').split(',').map(s => s.trim()).includes('needs-human')
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

    // Per-contact concurrency gate: a second message from the same contact while
    // the first turn is still in the LLM is held off until next poll / retry.
    if (inFlight.has(external_id)) {
      log.info?.('[casey] skipping concurrent LLM turn, buffered for replay', { caseId: fresh.id })
      await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'concurrent turn skipped: prior LLM turn still in-flight for this contact; buffered for replay' })
      // Mark so the replay (which re-enters handleInboundOnce with this SAME msg
      // object) skips the inbound-dedup guard above -- that guard already saw
      // this exact message once, just now, and correctly recorded it; the
      // replay's job is to run the turn, not to re-record an inbound that is
      // not actually a redelivery.
      msg.burstReplay = true
      // Buffer bounded per contact (a runaway sender cannot grow this
      // unboundedly): keep the most recent BUFFER_CAP, oldest dropped silently
      // logged, mirroring the existing no-silent-caps discipline elsewhere.
      const BUFFER_CAP = 20
      const buf = pendingBuffer.get(external_id) || []
      buf.push(msg)
      if (buf.length > BUFFER_CAP) {
        const dropped = buf.shift()
        log.warn?.('[casey] burst buffer cap exceeded, oldest message dropped', { caseId: fresh.id, cap: BUFFER_CAP })
      }
      pendingBuffer.set(external_id, buf)
      return { to: replyTo, text: '', platform, caseId: fresh.id, skipped: true, buffered: true }
    }
    inFlight.add(external_id)
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
    // Durable conversation state (dstate) -- where the AGENT has declared it is in the
    // report arc. Null when adaptogen is absent/degraded (the prompt then drives from
    // the raw report alone). casey does NOT compute completion -- the model declares
    // 'complete' via case_stage, so no report-derived guard vars here.
    let convOrient = null
    try { convOrient = await orientCase(fresh, {}) }
    catch (e) { log.debug?.('[casey] orient failed', { caseId: fresh.id, error: e.message }); convOrient = null }
    // Does the turn's own return shape show the FIRST assistant message made a
    // real tool call? (freddie's runTurn message shape: an assistant message
    // only ever carries a tool_calls array when the model actually called a
    // tool -- see the STRUCTURAL forced-tool-call guard below for the full
    // rationale.) Factored out so both the attempt loop (to decide whether a
    // retry is worth it) and the guard itself (to decide whether to blank the
    // final reply) share one definition.
    function firstTurnHadToolCall(r) {
      const firstAssistant = Array.isArray(r?.messages) ? r.messages.find(m => m?.role === 'assistant') : null
      if (!firstAssistant) return true   // nothing to judge (e.g. an error result) -- do not treat as a miss
      return Array.isArray(firstAssistant.tool_calls) && firstAssistant.tool_calls.length > 0
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
    for (let attempt = 1; attempt <= MAX_TOOL_CHOICE_ATTEMPTS; attempt++) {
      const configuredTimeoutMs = Number(process.env.CASEY_LLM_TURN_TIMEOUT_MS) || 120000
      const remainingMs = isBackgroundRedrive ? configuredTimeoutMs : (TURN_HARD_DEADLINE_MS - (Date.now() - turnStartedAt))
      if (!isBackgroundRedrive && remainingMs <= 0) {
        log.warn?.('[casey] turn hard deadline reached before this attempt could start; stopping retries', { caseId: fresh.id, attempt })
        break
      }
      const attemptTimeoutMs = isBackgroundRedrive ? configuredTimeoutMs : Math.min(configuredTimeoutMs, remainingMs)
      try {
        result = await runTurn({
          prompt,
          messages: [{ role: 'system', content: caseSystemPrompt(fresh, events, contact, { orient: convOrient }) }],
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
          // case_report/case_stage/etc, nothing else, per AGENTS.md's own
          // 'the agent acts entirely through these tools' design principle.
          enabledToolsets: ['cases'],
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
            tier: contact?.tier === 'field_worker' ? 'field_worker' : 'reporter',
            store,
            principal: { id: msg.from || external_id, role: 'worker' },
            activeCaseRef: fresh.ref,
            activeCaseId: fresh.id,
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
      // Retry only when the turn genuinely needs it: a real reply (tool call
      // OR genuine on-topic prose) never retries, and neither does an
      // already-errored turn. Only a tool-call MISS whose text is empty or a
      // self-referential refusal (isToolRefusal, below) is worth spending a
      // retry on -- a model that answered the contact's question in plain
      // prose without touching a tool is a genuinely good outcome, not a
      // miss to burn the retry budget correcting.
      //
      // CRITICAL: retrying does NOT change which model gets picked. Live-
      // witnessed this session: sambanova/gemma-4-31B-it won the "best
      // available model" ranking on 3/3 consecutive attempts of the SAME
      // turn (each a fresh chain build) because it responded fast with zero
      // errors every time -- acptoapi's own availability ranker has no
      // concept of tool-call compliance, so a model that reliably ignores
      // tool_choice while otherwise "succeeding" looks perfect to it and
      // keeps re-winning. The bridge itself (acptoapi-bridge.js) now
      // penalizes the served model directly in that same shared availability
      // tracker on a detected miss, so THIS retry (and every later chain
      // build) actually routes around it instead of hitting the identical
      // broken model three times in a row.
      const rawText = (result?.result || '').toString().trim()
      const genuineMiss = !firstTurnHadToolCall(result) && (!rawText || isToolRefusal(rawText) || isMetaCommentary(rawText))
      if (!genuineMiss || attempt === MAX_TOOL_CHOICE_ATTEMPTS) break
      log.warn?.('[casey] forced tool_choice not honored by model (empty/refusal); retrying turn', { caseId: fresh.id, attempt })
      try { await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `tool_choice miss on attempt ${attempt}; retrying` }) }
      catch (e2) { log.warn?.('[casey] failed to record tool_choice-retry observation', { caseId: fresh.id, error: e2.message }) }
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
    let text = (result?.result || '').toString().trim()
    // Reject a reply that parrots the system-prompt example verbatim: record it
    // as a failed turn rather than leak a canned, robotic message to the contact.
    if (text && isPromptEcho(text)) {
      await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'model echoed prompt example; blanked' })
      text = ''
    }
    // The weak model recites the bare stock ack on later turns too (not just the
    // first-contact exemplar isPromptEcho catches). A reply that is substantively
    // only "thank you ... your reference is X" advances nothing -- treat it as a
    // failed turn.
    if (text && isStockAck(text)) {
      await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'model recited stock ack (no case-specific content); blanked' })
      text = ''
    }
    // GENERAL repeat-of-last-outbound guard. isPromptEcho/isStockAck are finite
    // string lists -- they only ever catch the SPECIFIC phrasings someone already
    // witnessed and hardcoded. Witnessed live: a small model (RECENT TIMELINE
    // shows its own prior outbound in-context) parroted the exact previous reply
    // verbatim on the next real, distinct message ("3 dead cows") with no error/
    // timeout at all -- a clean turn that just echoed. Compare against the case's
    // actual last outbound event directly instead of maintaining an ever-growing
    // blocklist: any reply that is ref-stripped-identical to the last thing this
    // case sent is a parrot, regardless of what the string happens to say.
    if (text) {
      const lastOutbound = [...events].reverse().find(e => e.kind === 'outbound')
      if (lastOutbound?.text) {
        const strip = (s) => String(s).toLowerCase().replace(/CASE-\d+-[a-z0-9]+/gi, '').replace(/\s+/g, ' ').trim()
        if (strip(text) === strip(lastOutbound.text)) {
          await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'model repeated its own last outbound verbatim; blanked' })
          text = ''
        }
      }
    }
    // STRUCTURAL forced-tool-call guard. tool_choice:'required' is a HINT casey
    // cannot force every provider to honor (freddie's acptoapi bridge logs this
    // explicitly). A weak model can ignore it and free-type plain prose instead
    // -- but that prose is not automatically bad: USER DIRECTIVE (this session):
    // if the model isn't calling a tool, is it still answering? Yes it can be,
    // and a genuine on-topic answer must reach the contact rather than being
    // discarded on a structural technicality -- discarding a real answer is
    // itself a failure to deliver, not a safety measure. The ONLY thing that
    // must never reach the contact is the specific witnessed failure mode: a
    // self-referential REFUSAL about its own tool access ("I don't have the
    // tools/access to assist", witnessed live on real Discord traffic against
    // squarely in-scope reports like "I'm in umtentweni" / "cows"/"chickens").
    // isToolRefusal (heuristics.js) matches that shape by content, the same
    // established pattern isPromptEcho/isStockAck already use elsewhere in this
    // file -- only a genuine refusal or fully empty text is blanked; real
    // content is sent.
    if (text && !firstTurnHadToolCall(result) && isToolRefusal(text)) {
      log.warn?.('[casey] model produced a self-referential tool-refusal; blanking reply', { caseId: fresh.id })
      await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'model refused citing missing tool access; blanked' })
      text = ''
    }
    // Live-witnessed on real Discord traffic (a reasoning-family model,
    // cerebras/gpt-oss-120b): the model's final content was its OWN planning
    // narration about how to reply ("We should reply warmly, short, in
    // English, ask if they have anything to report.") rather than the reply
    // itself, sent verbatim to a real contact. Not gated on
    // firstTurnHadToolCall -- this leak is about the shape of the FINAL
    // natural-language turn, independent of whether a tool was called
    // earlier in the same turn.
    if (text && isMetaCommentary(text)) {
      log.warn?.('[casey] model produced reply-planning meta-commentary instead of an actual reply; blanking', { caseId: fresh.id })
      await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'model narrated its own reply plan instead of replying; blanked' })
      text = ''
    }
    // PURE-AGENT REPLY. The agent drives the whole conversation -- intake (asking the
    // next needed fact via case_report + the system prompt), enquiries, status, all of
    // it. casey no longer composes or overrides the reply deterministically. USER
    // DIRECTIVE: no mocks/fallbacks/stubs, only singular working mechanisms and loud
    // errors -- a degraded turn (error / timeout / empty / prompt-echo / stock-ack /
    // repeat) sends NOTHING to the contact and logs loudly instead of a scripted
    // holding reply. The empty-case field-capture floor (above) still records
    // plainly-stated facts if the model missed a case_report, but it does NOT
    // compose the reply. The reliability fix is upstream (the in-process acptoapi
    // bridge), not a downstream apology.
    const isFallback = !text
    if (isFallback) {
      if (!errored && result?.error) {
        log.error?.('[casey] agent returned error result', { caseId: fresh.id, error: result.error })
        await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: `agent result error: ${result.error}` })
      }
      log.error?.('[casey] degraded turn produced no reply', { caseId: fresh.id })
      await store.appendEvent(fresh.id, { kind: 'observation', actor: 'system', text: 'degraded turn (empty/error/echo/stock-ack/repeat); no reply sent.' })
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

    // PRE-SEND JARGON GUARD: if the composed reply leaked internal jargon
    // (case/triage/workflow/status/priority as whole words), do NOT send it. Hold
    // it as a draft for a human exactly like assisted mode -- the contact must never
    // receive a jargon-laden reply, and a person rewrites it plainly. This fires in
    // ANY autonomy mode (the leak is a content defect, not a mode choice) and runs
    // before the assisted-mode branch so a jargon hit holds even in auto mode. The
    // offending words are recorded as an observation for the operator. Reuses the
    // assisted draft-hold mechanics (draft event + draft-pending + needs-human +
    // notify-once).
    const jHits = jargonHits(text)
    if (jHits.length) {
      await store.appendEvent(fresh.id, {
        kind: 'observation', actor: 'system',
        text: `JARGON-HELD: reply withheld -- contained internal jargon (${jHits.join(', ')}); held for a human to reword plainly.`,
      })
      await store.appendEvent(fresh.id, {
        kind: 'draft', actor: 'agent', channel,
        text, data: { to: replyTo, fallback: isFallback, draft: true, jargon: jHits },
      })
      const alreadyFlagged = (fresh.tags || '').split(',').map(s => s.trim()).includes('needs-human')
      try {
        await store.updateCase(fresh.id, { tags: mergeTag(mergeTag(fresh.tags, 'draft-pending'), 'needs-human') })
        if (notifyHandoff && !alreadyFlagged) {
          try { await notifyHandoff({ case: fresh, channel, from: msg.from }) }
          catch (e) { log.warn?.('[casey] jargon-held notify failed', { caseId: fresh.id, error: e.message }) }
        }
      } catch (e) { log.warn?.('[casey] jargon-held flag failed', { caseId: fresh.id, error: e.message }) }
      stopTyping()
      return { to: replyTo, text: '', platform, caseId: fresh.id, drafted: true, jargonHeld: jHits }
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
      const alreadyFlagged = (fresh.tags || '').split(',').map(s => s.trim()).includes('needs-human')
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
    // agent turn does too. Best-effort: a tag failure must never block the reply.
    if (degraded) {
      try { await store.updateCase(fresh.id, { tags: mergeTag(fresh.tags, 'ai-offline') }) }
      catch (e) { log.warn?.('[casey] ai-offline tag failed', { caseId: fresh.id, error: e.message }) }
    } else if ((fresh.tags || '').split(',').map(s => s.trim()).includes('ai-offline')) {
      // A successful, delivered turn clears a stale offline flag from a prior failure.
      try { await store.updateCase(fresh.id, { tags: dropTag(fresh.tags, 'ai-offline') }) }
      catch (e) { log.warn?.('[casey] ai-offline clear failed', { caseId: fresh.id, error: e.message }) }
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
    // ADVANCE the durable conversation state -- ONLY on a real, delivered, non-fallback
    // turn, and ONLY to the phase the AGENT itself DECLARED this turn (the newest
    // STAGE-DECLARED observation the case_stage tool wrote). casey does NOT derive a
    // phase from the report -- the model owns that. If the model declared nothing, the
    // cursor stays where it is (an honest default). Degrade-safe: advanceCase is a
    // no-op when adaptogen is absent.
    if (delivered && !isFallback && !errored) {
      try {
        let target = null
        const evs = await store.listEvents(fresh.id)
        // Bound the backward scan on THIS turn's own inbound event id, not msg_id:
        // when the adapter omits an id, msgId is '' (messageId() returns '' when
        // both msg.raw?.id and msg.id are absent -- a known, already-logged
        // condition), and matching on msg_id==='' would stop at the WRONG prior
        // inbound event (also empty msg_id) instead of this turn's own, letting
        // the scan advance the FSM to a phase declared on an earlier turn. Prefer
        // the real event id: inboundEvent.id on a fresh turn, or the matching row
        // found by msg_id on a resume-redrive (inboundEvent is null there by
        // design). Only fall back to a bare msg_id compare if neither resolves.
        const turnInboundId = inboundEvent?.id
          ?? (msgId ? evs.find(e => e.kind === 'inbound' && e.msg_id === msgId)?.id : null)
        for (let i = evs.length - 1; i >= 0; i--) {
          const m = typeof evs[i].text === 'string' && evs[i].text.match(/^STAGE-DECLARED (\w+)$/)
          if (m) { target = m[1]; break }
          if (turnInboundId != null ? evs[i].id === turnInboundId : (evs[i].kind === 'inbound' && evs[i].msg_id === msgId)) break
        }
        const cur = convOrient?.state || 'greeting'
        if (target && target !== cur) await advanceCase(store, fresh, target, {})
      } catch (e) { log.debug?.('[casey] conversation advance skipped', { caseId: fresh.id, error: e.message }) }
    }
    return reply
    } finally { inFlight.delete(external_id) }
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
    // handleInboundOnce has no outer try/finally around its ~850-line body (a
    // restructure risky enough to defer), so an unhandled throw deep inside
    // would otherwise bypass every stopTyping() call threaded through its own
    // return paths, leaking a live typing indicator until Discord's own ~10s
    // TTL silently expires it. adapter.stopTyping is idempotent (a no-op if
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
      handleInbound.call(this, platform, next).catch(e => log.error?.('[casey] burst replay failed', { error: e.message }))
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
