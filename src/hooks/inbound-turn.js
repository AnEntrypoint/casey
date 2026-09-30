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
import { normaliseReply } from './plain-text.js'
import { decideNotice, composeNotice, recordNoticeShown } from '../first-contact-notice.js'
import { renderFormProgress, formLabelsFor } from '../progress-line.js'
import { atLeast, resolveContactTier, TIER_FIELD_WORKER } from '../contact-tiers.js'
import { tryRegisterByCode } from './role-registration.js'
import { parseReport, tagList } from '../timestamp.js'
import { controlRegistered } from './turn-results.js'
import { speakerState, noteAsked } from '../phone-persons.js'
import { consentManaged, consentState } from '../phone-consent.js'

export async function runInboundTurn(receiver, deps, { platform, msg, channel, external_id, replyTo }) {
  const { store, log, admission, autoRespond, llmStatus, notifyHandoff } = deps
  const adapter = resolveAdapter(receiver, platform)
  const denied = checkAdmission({ admission, store, log, msg, channel, external_id, replyTo, platform })
  if (denied) return denied

  // A message that is nothing but a one-time role code is consumed here, before
  // any case exists and before any agent turn (hooks/role-registration.js).
  const registered = await tryRegisterByCode({ store, log, adapter, msg, channel, external_id, replyTo, platform })
  if (registered) return registered

  const opened = await openCaseForInbound({ store, log, msg, channel, external_id, replyTo, platform })
  if (opened.done) return opened.done
  const { caseRow, created, inboundText, media, msgId } = opened
  const { promptNote = '', ingressRecorded = false } = (await applyInboundSideEffects({ store, log, caseRow, created, msg, channel, inboundText, media })) || {}
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
  const basePrompt = inboundText || (media ? `The contact sent ${media} with no text. Acknowledge and ask how you can help.` : 'The contact sent an empty message. Acknowledge politely.')
  const prompt = basePrompt + promptNote

  const queued = await llmDownQueueGate({ store, log, llmStatus, fresh, events, msg, msgId, replyTo, platform })
  if (queued) return queued

  // The buffered turn's own case-scoped audit note, logged once there is a real
  // case row to attach it to. The concurrency gate itself fired long before
  // this, at handleInboundOnce's entry.
  if (msg.burstReplay) {
    await store.appendEvent(fresh.id, observation('concurrent turn skipped: prior LLM turn still in-flight for this contact; buffered for replay'))
  }

  // The team tools' outbound seam: the receiver's own sendReply -- Casey.sendReply,
  // the very function the dashboard's operator reply and the proactive stage note
  // call -- and whether the channel a record arrived on has a live adapter. No
  // second outbound mechanism exists; a receiver without either leaves the team
  // tools to refuse honestly.
  const staffSend = typeof receiver?.sendReply === 'function'
    ? { sendReply: (caseRow, text) => receiver.sendReply(caseRow, text), canSend: (ch) => !!resolveAdapter(receiver, ch)?.send }
    : null
  return await driveAgentTurn(deps, {
    adapter, fresh, contact, events, prompt, inboundText, media,
    msg, msgId, channel, external_id, replyTo, platform, staffSend, ingressRecorded,
  })
}

async function driveAgentTurn(deps, {
  adapter, fresh, contact, events, prompt, inboundText, media,
  msg, msgId, channel, external_id, replyTo, platform, staffSend = null, ingressRecorded = false,
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

  // The first-contact notice does not depend on the answer, so its wording is composed
  // WHILE the answer is being written rather than after it (it was a serial ~7 second
  // step on a first message). Whether to attach it is still decided below, once the
  // turn is known not to be degraded.
  //
  // On a shared phone (src/phone-persons.js) the notice is owed per PERSON, so it is decided for whoever is
  // recorded as writing when the turn starts; if the model records a different person during the turn, it is
  // decided again below for that person.
  const isPublic = !atLeast(resolveContactTier(contact), TIER_FIELD_WORKER) && !!contact?.id
  const speakerNow = () => (isPublic ? speakerState(store, contact.id).catch(() => null) : Promise.resolve(null))
  const speakerBefore = await speakerNow()
  const noticeFor = (caseRow, speaker) => decideNotice(store, { fresh: caseRow, events, contact, speaker })
    .then(async (n) => (n ? { notice: n, body: await composeNotice(callLLM, n, { inboundText }).catch(() => null) } : null))
    .catch(() => null)
  const noticeReady = isBackgroundRedrive ? Promise.resolve(null) : noticeFor(fresh, speakerBefore)

  const turn = await runAgentTurn({
    store, log, callLLM, msg, fresh, events, contact, inboundText, prompt,
    channel, external_id, turnStartedAt, isBackgroundRedrive, staffSend, ingressRecorded,
  })
  const { result, errored, jargonReasons, falseConfirmReasons, adviceReasons, degradedReason } = turn
  let text = turn.text

  // Re-read the case after the agent turn: the agent may have completed intake
  // via case_report (or moved the stage) during the turn. Every report-aware
  // decision below must see what the agent just wrote, not the pre-turn snapshot.
  //
  // And re-read the case the turn ENDED bound to, which a case_new/case_switch
  // makes a DIFFERENT case from the one the handler resolved before the turn
  // began. Reading fresh.id unconditionally meant every post-turn decision acted
  // on the case the reporter had just moved on FROM, while their facts sat in the
  // new one -- the outbound ref correction worst of all, since a reference is the
  // single datum a reporter quotes to a vet. sanitizeOutboundRef is handed
  // `fresh.ref` as "the real ref", and case_new's own result puts the new ref in
  // the tool-learned allowlist, so BOTH refs read as legitimate and a reply
  // naming the stale one passed through untouched.
  //
  // Live-witnessed over Discord: a reporter who finished with their goats and
  // reported a separate pig sickness at another farm was answered "Your reference
  // for this is: CASE-1118-..." -- the goat case -- for facts casey had just
  // written into CASE-1119. Quoting that back would have named the wrong animals
  // at the wrong place.
  //
  // Falls back to the original id if the rebound case cannot be read, so a
  // failed lookup degrades to the previous behaviour rather than losing `fresh`.
  const endedOnId = turn.activeCase?.id || fresh.id
  // The case the turn STARTED on, kept before `fresh` is rebound: a case_new
  // leaves it behind, and it may hold a full report the reporter just gave. See
  // the advanceIntake call below for why it still needs advancing.
  const startedOnId = fresh.id
  // case_handoff (the agent's read of a request for a person, in any language) only
  // sets the tag; the team is told here, once, on the first flag -- the same
  // notify-once rule flagNeedsHuman applies (hooks/case-writes.js).
  const wasFlagged = tagList(fresh).includes('needs-human')
  const handoffAsked = controlRegistered(result, 'case_handoff')
  const preTurnCase = fresh
  fresh = await store.getCase(endedOnId).catch(() => null) || await store.getCase(fresh.id).catch(() => fresh)

  if (handoffAsked && !wasFlagged && notifyHandoff) {
    try { await notifyHandoff({ case: preTurnCase, channel, from: msg.from }) }
    catch (e) { log.warn?.('[casey] handoff notify failed', { caseId: preTurnCase.id, error: e.message }) }
  }

  // Reaching here with empty text means the whole genuine retry budget (attempts
  // x hard deadline) was spent.
  const isFallback = !text
  if (isFallback) await recordDegradedOutcome({ store, log, fresh, result, errored, degradedReason, contactId: contact?.id, turnStartedAt, channel })
  // Surfaced on the reply object so drainQueuedTurns can treat a degraded
  // re-drive as a failed attempt instead of burning the queued message.
  const degraded = errored || isFallback

  text = await correctOutboundRef({ store, fresh, text, result, inboundText, contact })
  // Markdown the phone would show literally is rewritten (hooks/plain-text.js). WhatsApp
  // only: Discord renders markdown itself.
  if (text && channel === 'whatsapp') {
    const plain = normaliseReply(text)
    if (plain.changed) {
      text = plain.text
      try { await store.appendEvent(fresh.id, observation('REPLY-FORMAT-NORMALISED: markdown syntax rewritten for WhatsApp')) }
      catch (e) { log.warn?.('[casey] format-normalised marker failed', { caseId: fresh.id, error: e.message }) }
    }
  }
  if (!degraded) await clearAiOffline({ store, log, fresh })

  const held = await holdReplyForHuman({
    store, log, fresh, notifyHandoff, msg, channel, replyTo, platform,
    text, isFallback, jargonReasons, falseConfirmReasons, adviceReasons,
  })
  if (held) { stopTyping(); return held }

  // reportLanded/replySending: see advanceIntake's own header for why a degraded
  // turn that recorded nothing may not move the case out of `new` claiming a first
  // report was received. `fresh` is the post-turn re-read, so its report column is
  // exactly what this turn's own case_report left behind.
  await advanceIntake({ store, log, fresh, inboundText, media, reportLanded: !!fresh?.report, replySending: !isFallback })
  // A case_new mid-turn leaves the case the turn STARTED on behind, and one
  // message carrying two separate situations records the first situation into it
  // and then departs -- so that case holds a real report and has never had a turn
  // end on it. Without this it sits at `new` indefinitely, reading as an intake
  // nobody has begun while holding facts somebody gave, until the 24h
  // abandoned_intake sweep notices. Gated on reportLanded alone: no reply is going
  // out on THIS case, its report is the whole warrant, and advanceIntake is a
  // no-op for a case already past `new` or holding nothing.
  if (startedOnId && startedOnId !== fresh?.id) {
    // The reply (if any) lands on the case the turn ended on, so the case it STARTED
    // on holds a TURN-START with nothing after it. Left like that the resume sweep
    // reads the message as unanswered and replays it after every restart, opening a
    // fresh case and answering the person a second time. This marker completes it
    // (casey-resume-scan.js completesTurn), positionally like an outbound would.
    try { await store.appendEvent(startedOnId, observation(`TURN-HANDED-OFF:${msgId} continued on ${fresh?.ref || fresh?.id}`)) }
    catch (e) { log.warn?.('[casey] turn hand-off marker failed', { caseId: startedOnId, error: e.message }) }
    const departed = await store.getCase(startedOnId).catch(() => null)
    if (departed?.report) {
      await advanceIntake({ store, log, fresh: departed, inboundText, media, reportLanded: true, replySending: false })
    }
  }
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
      turnStartedAt, stopTyping,
    })
  }

  // PROGRESS FORM and FIRST-CONTACT NOTICE. Every reply to a member of the public that has a case OPENS with the
  // report form's state: the finished fields and the unfinished ones (progress-line.js), printed by the system from the
  // record, with the model's reply after it. A staff notice (first-contact-notice.js) is appended after it as its own paragraph; a public number is
  // asked once in conversation instead (phone-consent.js). Neither is ever added to a fallback, degraded or
  // held turn, and neither may hold the reply back. Team members do not get the form (their prompt carries the
  // reference and gaps); someone who opted out does not either.
  let notice = null
  if (!degraded && !isFallback && text) {
    let early = await noticeReady
    if (!isBackgroundRedrive && isPublic) {
      const after = await speakerNow()
      if ((after?.current?.id || null) !== (speakerBefore?.current?.id || null)) early = await noticeFor(fresh, after)
    }
    notice = early ? early.notice : null
    const wantsForm = !atLeast(resolveContactTier(contact), TIER_FIELD_WORKER) && !tagList(fresh).includes('opted-out')
      // No form summary before the number has said yes (src/phone-consent.js): nothing is recorded to summarise.
      && !(consentManaged() && isPublic && await consentState(store, contact.id, { caseId: fresh.id }) !== 'agreed')
    let merged = ''
    if (wantsForm) {
      // Rendered in code from the record (progress-line.js): no model call on the reply's path, except the one-time
      // translation of the fixed words the first time a language is seen.
      const labels = await formLabelsFor(callLLM, parseReport(fresh).language_detected).catch(() => undefined)
      merged = renderFormProgress(fresh, labels)
      // The system's own print of the form comes FIRST and the model's reply after it, so the reply is the last thing read.
      if (merged) text = `${merged}\n\n${text}`
    }
    if (notice) {
      const body = early.body
      if (body) text = `${text}\n\n${body}`
      else { notice = null; await store.appendEvent(fresh.id, observation('NOTICE-NOT-COMPOSED: the first-contact notice could not be composed; it is still owed')).catch(() => {}) }
    }
  }
  const { reply, delivered } = await sendAgentReply({ store, log, adapter, fresh, channel, replyTo, platform, text, isFallback, degraded })
  // The first-contact notice is recorded only once a reply that carries it was delivered.
  if (delivered && notice) {
    try { await recordNoticeShown(store, fresh.id, notice) }
    catch (e) { log.warn?.('[casey] notice_shown record failed', { caseId: fresh.id, error: e.message }) }
  }
  // Casey was told to ask who is writing (two or more people known, nobody recorded): once the reply that
  // carries the question was delivered and nobody has been recorded since, remember it, so the question is
  // asked once and the next message is read as the answer (src/phone-persons.js).
  if (delivered && !isBackgroundRedrive && isPublic && turn.speakerAtStart?.needs_ask) {
    try { const now = await speakerNow(); if (now && !now.current) await noteAsked(store, contact.id) }
    catch (e) { log.warn?.('[casey] asked-who marker failed', { caseId: fresh.id, error: e.message }) }
  }
  // GUARANTEED-RESPONSE FSM, end: the real reply attempt (success or a failed
  // send, either way nothing more is coming) is the last point a typing indicator
  // should still be showing.
  stopTyping()
  return reply
}
