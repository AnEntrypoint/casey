// hooks/case-intake.js -- everything hooks/handler.js does BEFORE the agent
// turn: admission control, case resolution, the append-only intake writes, and
// the three pre-turn gates (irreversible service controls, observe mode, the
// LLM-down queue).
//
// Each function returns either a finished reply object (the turn is over --
// handler.js returns it verbatim) or null/a data bundle to fall through with.
// Nothing here composes contact-facing text: every early return is
// text:'' plus a machine-readable flag, matching the no-fallback-text
// discipline (the ONE sanctioned status message is the guaranteed fallback in
// hooks/delivery.js, and it only ever fires AFTER a real agent turn).

import { observation, flagNeedsHuman } from './case-writes.js'
import { applyServiceControls, isLlmDown } from './service-controls.js'
import { describeMedia, recordInboundMedia } from './media-intake.js'
import { truncate, stripChannelMarkup, mergeTag, dropTag } from './heuristics.js'
import { recordDroppedInbound } from './dropped-intake.js'
import { tagList } from '../timestamp.js'

// Platform message id for dedup: Discord/WhatsApp put it on raw.id; fall back to
// an explicit msg.id.
export function messageId(msg) {
  return msg.raw?.id || msg.id || ''
}

// Rate limits are checked here, before findOrCreateCase/recordInbound run any
// store write, so a signature-verified flood is turned away without driving
// unbounded case/event writes. Checking only AFTER those writes still protects
// the LLM spend but lets the flood itself through to the store on every single
// message. A buffered-then-replayed message must not be rate-checked a second
// time for the same human message (only the FIRST arrival, before it was
// buffered, consumed a window slot) -- double-counting a burst against its own
// buffer defeats the "buffered, never dropped" guarantee the buffer exists to
// provide.
//
// The store check rides along here because it is the same class of decision: a
// hard dependency that is not initialized is a real infrastructure failure, not
// something a scripted apology should paper over (USER DIRECTIVE: no
// mocks/fallbacks/stubs, only singular working mechanisms and loud errors). Log
// loud, send nothing.
// Each of the three drops below is COUNTED (hooks/dropped-intake.js) as well as
// logged. A log line on a headless deployment is not a record: it was previously
// the only trace that a report had arrived and been thrown away, which in a
// disease-surveillance deployment is the one failure that must never be silent.
// The count is aggregate and bounded by design -- one summary written per reason
// per window, never one row per message -- precisely so recording the flood
// cannot become the store-write amplification these limiters exist to deny. The
// store-not-ready case can write nothing at all, by definition; it still
// increments the in-memory tally, so /api/health reports it.
export function checkAdmission({ admission, store, log, msg, channel, external_id, replyTo, platform }) {
  if (!msg.burstReplay && admission.rateLimited(external_id)) {
    log.error?.('[casey] rate limit: skipping turn, no store write, no reply sent', { channel })
    recordDroppedInbound('rate_limited_contact', { channel, store, log })
    return { to: replyTo, text: '', platform, rateLimited: true }
  }
  if (admission.globallyRateLimited()) {
    log.error?.('[casey] global rate limit: skipping turn, no store write, no reply sent', { channel })
    recordDroppedInbound('rate_limited_global', { channel, store, log })
    return { to: replyTo, text: '', platform, rateLimited: true }
  }
  if (!store) {
    log?.error?.('[casey] store not initialized; dropping inbound')
    recordDroppedInbound('store_not_ready', { channel, store: null, log })
    return { to: replyTo, text: '', platform, error: 'store_not_ready' }
  }
  return null
}

// Find-or-create the case, record the inbound, and apply the dedup guarantee.
// Returns `{ done }` when the turn is finished here, else the resolved
// `{ caseRow, created, inboundText, media, msgId }` bundle.
//
// Never log external_id -- it is the contact's phone number (PII). Channel plus
// the error is enough to diagnose without writing PII to the log sink.
export async function openCaseForInbound({ store, log, msg, channel, external_id, replyTo, platform }) {
  const msgId = messageId(msg)
  if (!msgId) log?.warn?.('[casey] inbound message missing id; dedup guarantee not applied', { channel })

  let caseRow, created
  try {
    ;({ case: caseRow, created } = await store.findOrCreateCase({
      channel, external_id,
      contact: { display_name: msg.raw?.author?.username, handle: msg.raw?.author?.username },
    }))
  } catch (e) {
    log.error?.('[casey] findOrCreateCase failed; dropping inbound', { channel, error: e.message })
    return { done: { to: replyTo, text: '', platform, error: e.message } }
  }

  // Strip channel mention markup (e.g. Discord's "<@BOTID> hello") before the
  // text reaches any reasoning: the mention's numeric id otherwise reads as a
  // count and flips a bare greeting out of the content-free path into the
  // case-ack. The raw msg.text is still recorded by recordInbound below for
  // audit; only the reasoning copy is cleaned.
  const inboundText = stripChannelMarkup(msg.text || '')
  const media = describeMedia(msg)
  let inboundEvent
  try {
    // recordInbound runs on the per-conversation lock so the dedup check and the
    // append are atomic -- a redelivered platform message (webhook retry,
    // gateway replay, the same message duplicated in one tick) is recorded and
    // answered exactly once, structurally rather than merely improbably.
    inboundEvent = await store.recordInbound(caseRow, {
      channel,
      text: inboundText || (media ? `[${media}]` : '[empty message]'),
      data: {}, msg_id: msgId,
    })
  } catch (e) {
    // Unguarded, a transient store error here (thatcher busy, a lock timeout)
    // throws straight past this point and silently drops the WHOLE inbound turn,
    // with only casey.js's _wrapInflight backstop between it and an unhandled
    // rejection. Same explicit-drop discipline as the findOrCreateCase catch
    // above: log loud, send nothing (no fallback text).
    log.error?.('[casey] recordInbound failed; dropping inbound', { caseId: caseRow.id, channel, error: e.message })
    return { done: { to: replyTo, text: '', platform, caseId: caseRow.id, error: e.message } }
  }
  // A resume re-drive (msg.resume) intentionally carries the ORIGINAL msg_id of
  // an inbound already recorded, so recordInbound correctly returns null. That is
  // the expected path here, not a duplicate to drop: the boot resume sweep is
  // re-running the turn for a message whose inbound persisted but whose reply
  // never went out. Fall through to the agent turn instead of short-circuiting.
  // Same for msg.burstReplay: the fast-message-burst buffer stores the ORIGINAL
  // msg object, whose inbound was already recorded the first time this message
  // hit the inFlight guard, and the replay re-enters to run the turn, not to
  // re-record a redelivery. Without both exemptions the replay self-dedupes on
  // its own earlier recording and silently no-ops -- the message sits IN the
  // event log and never gets a real reply, defeating the "buffered and replayed,
  // never silently dropped" guarantee.
  if (!inboundEvent && !msg.resume && !msg.burstReplay) {
    log.info?.('[casey] duplicate inbound dropped', { caseId: caseRow.id, msgId })
    return { done: { to: replyTo, text: '', platform, caseId: caseRow.id, duplicate: true } }
  }
  return { caseRow, created, inboundText, media, msgId }
}

// The append-only intake writes that follow a recorded inbound: supersede a
// stale assisted draft, record every media artifact, and (on a brand-new case)
// seed the subject, tag the intake source and note the opening.
//
// Every write in here is best-effort and individually guarded: this is
// audit-trail decoration and the case already exists, so nothing in here may
// block the reply path. Unguarded, a single transient store error silently
// drops the whole inbound turn with no reply, no observation and no logged
// reason.
export async function applyInboundSideEffects({ store, log, caseRow, created, msg, channel, inboundText, media }) {
  // A fresh inbound supersedes any pending assisted draft: the contact has said
  // more, so a draft composed against the old conversation is stale. Clear the
  // draft-pending tag (the agent turn re-drafts against the full thread) and
  // record the supersession so the timeline shows why the old draft lapsed.
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
  // downloaded bytes sitting right there. Append-only and best-effort.
  await recordInboundMedia({ store, log, caseId: caseRow.id, msg })
  if (!created) return
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
  try { await store.appendEvent(caseRow.id, { kind: 'note', actor: 'system', text: `Case opened from ${channel}` }) }
  catch (e) { log.warn?.('[casey] case-opened note failed', { caseId: caseRow.id, error: e.message }) }
}

// IRREVERSIBLE SERVICE CONTROLS + observe mode -- the only deterministic
// pre-LLM route left. Returns a finished reply, or null to fall through to the
// agent turn.
//
// PURE LLM otherwise: casey does NOT deterministically extract report fields,
// and there is no keyword/shape router. STOP (opt-out) and HUMAN (handoff) are
// legal/service controls that must fire synchronously in any language even with
// the model down -- never queued, never left to the agent's discretion, and
// they must fire REGARDLESS of autonomy mode, so they run BEFORE the
// observe-mode gate. The control's own state change is unconditional and
// happens inside applyServiceControls; a null return falls through so the
// ordinary agent turn composes the acknowledgement in the contact's own
// language rather than from a hardcoded per-language string.
export async function applyPreTurnControls({ store, log, llmStatus, notifyHandoff, fresh, inboundText, channel, msg, replyTo, platform }) {
  const controlled = await applyServiceControls({
    store, log, llmStatus, notifyHandoff,
    caseRow: fresh, inboundText, channel, msg, replyTo, platform,
  })
  if (controlled) return controlled

  // observe-mode: the agent does not act or reply automatically; a human drives
  // the case. The inbound is already recorded, and the irreversible controls
  // already had their chance above -- this only gates the ordinary
  // conversational/report turn that follows.
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
  return null
}

// LLM-DOWN QUEUE GATE. A message that arrives while the backend is down cannot
// be understood now -- so QUEUE it and re-drive when the provider recovers
// (drainQueuedTurns on the down->up edge). The inbound is already recorded; here
// a durable QUEUED-FOR-AGENT marker is appended and the turn returns WITHOUT a
// TURN-START (so the resume sweep does not also claim it). USER DIRECTIVE: no
// fallback text -- log loud, send nothing, rely on the queue to re-drive once
// the provider (the in-process acptoapi bridge) is actually reachable. Guarded
// once per msgId. STOP/HUMAN are handled by the deterministic short-circuit
// ABOVE this gate, so an opt-out during an outage still fires synchronously and
// is never queued.
//
// isLlmDown carries the swallow-and-assume-up catch (a status() that itself
// throws must never gate an inbound into the queue) and the not-a-function
// guard, so both are read once there instead of spelled out again here.
export async function llmDownQueueGate({ store, log, llmStatus, fresh, events, msg, msgId, replyTo, platform }) {
  if (msg.resume || !(await isLlmDown(llmStatus))) return null
  const already = events.some(e => e.kind === 'observation' && typeof e.text === 'string' && e.text === `QUEUED-FOR-AGENT:${msgId}`)
  if (already) {
    // Already queued this msgId (a duplicate delivery during the outage).
    return { to: replyTo, text: '', platform, caseId: fresh.id, queued: true, deduped: true }
  }
  try {
    await store.appendEvent(fresh.id, observation(`QUEUED-FOR-AGENT:${msgId}`))
    log.error?.('[casey] LLM backend down; queued inbound, no reply sent', { caseId: fresh.id, msgId })
    return { to: replyTo, text: '', platform, caseId: fresh.id, queued: true }
  } catch (e) {
    log.warn?.('[casey] queue-gate append failed; falling through to live turn', { caseId: fresh.id, error: e.message })
    return null
  }
}
