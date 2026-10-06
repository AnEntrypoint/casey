

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
import { staffProgressLine } from '../team-focus.js'
import { caseDeliveryTarget } from './handler.js'
import { atLeast, resolveContactTier, TIER_FIELD_WORKER } from '../contact-tiers.js'
import { tryRegisterByCode } from './role-registration.js'
import { parseReport, tagList } from '../timestamp.js'
import { controlRegistered } from './turn-results.js'
import { speakerState, noteAsked } from '../phone-persons.js'
import { consentManaged, consentState } from '../phone-consent.js'
import { noteReturn } from '../return-clarify.js'
import { ensurePin } from '../pin-estimate.js'
import { pinAskOwed, pinAskValue } from '../pin-confidence.js'
import { buildPromptContext } from './prompt-context.js'

export async function runInboundTurn(receiver, deps, { platform, msg, channel, external_id, replyTo }) {
  const { store, log, admission, autoRespond, llmStatus, notifyHandoff } = deps
  const adapter = resolveAdapter(receiver, platform)
  const denied = checkAdmission({ admission, store, log, msg, channel, external_id, replyTo, platform })
  if (denied) return denied

  const registered = await tryRegisterByCode({ store, log, adapter, msg, channel, external_id, replyTo, platform })
  if (registered) return registered

  const opened = await openCaseForInbound({ store, log, msg, channel, external_id, replyTo, platform })
  if (opened.done) return opened.done
  const { caseRow, created, inboundText, media, msgId } = opened
  const { promptNote = '', ingressRecorded = false } = (await applyInboundSideEffects({ store, log, caseRow, created, msg, channel, inboundText, media })) || {}
  if (!autoRespond) return { to: replyTo, text: '', platform, caseId: caseRow.id }

  let fresh
  try { fresh = await store.getCase(caseRow.id) }
  catch (e) {
    log.warn?.('[casey] getCase(fresh) failed; continuing with the pre-turn case snapshot', { caseId: caseRow.id, error: e.message })
    fresh = caseRow
  }

  const controlled = await applyPreTurnControls({ store, log, llmStatus, notifyHandoff, fresh, inboundText, channel, msg, replyTo, platform })
  if (controlled) return controlled
  fresh = await store.getCase(fresh.id)

  const contact = fresh.contact_id ? await store.getContact(fresh.contact_id).catch(() => null) : null
  const events = await store.listEvents(fresh.id)
  const isVoice = media && /audio|voice/i.test(media)
  const basePrompt = inboundText || (isVoice
    ? 'The contact sent a voice note that could not be turned into text. It is saved with their report for the team to listen to. Do not guess what it said and record nothing from it: tell them kindly, in their language, that it is saved and that you cannot hear it yourself, and ask them to type the important facts (or say them again in a short voice note).'
    : media ? `The contact sent ${media} with no text. Acknowledge and ask how you can help.` : 'The contact sent an empty message. Acknowledge politely.')
  const prompt = basePrompt + promptNote

  const queued = await llmDownQueueGate({ store, log, llmStatus, fresh, events, msg, msgId, replyTo, platform })
  if (queued) return queued

  if (msg.burstReplay) {
    await store.appendEvent(fresh.id, observation('concurrent turn skipped: prior LLM turn still in-flight for this contact; buffered for replay'))
  }

  const staffSend = typeof receiver?.sendReply === 'function'
    ? {
      sendReply: (caseRow, text) => receiver.sendReply(caseRow, text),
      canSend: (ch) => !!resolveAdapter(receiver, ch)?.send,
      sendImage: (caseRow, image) => resolveAdapter(receiver, caseRow.channel).sendImage({ to: caseDeliveryTarget(caseRow), ...image }),
      canSendImage: (ch) => typeof resolveAdapter(receiver, ch)?.sendImage === 'function',
    }
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

  try { await store.appendEvent(fresh.id, observation(`TURN-START:${msgId}`)) }
  catch (e) { log.warn?.('[casey] turn-start marker failed', { caseId: fresh.id, error: e.message }) }

  const isBackgroundRedrive = !!(msg.resume || msg.queuedRedrive)
  const stopTyping = makeTypingIndicator({ adapter, replyTo, log, caseId: fresh.id, enabled: !isBackgroundRedrive })

  const turnStartedAt = Date.now()

  const isPublic = !atLeast(resolveContactTier(contact), TIER_FIELD_WORKER) && !!contact?.id
  const speakerNow = () => (isPublic ? speakerState(store, contact.id).catch(() => null) : Promise.resolve(null))
  const speakerBefore = await speakerNow()
  const noticeFor = (caseRow, speaker) => decideNotice(store, { fresh: caseRow, events, contact, speaker })
    .then(async (n) => (n ? { notice: n, body: await composeNotice(callLLM, n, { inboundText }).catch(() => null) } : null))
    .catch(() => null)
  const noticeReady = isBackgroundRedrive ? Promise.resolve(null) : noticeFor(fresh, speakerBefore)

  if (isPublic && !isBackgroundRedrive) await noteReturn(store, { caseRow: fresh, events, contact, msgId }).catch(() => {})

  let askedPin = false
  if (isPublic && !isBackgroundRedrive && pinAskOwed(fresh)) {
    const pc = buildPromptContext(fresh, events)
    askedPin = !pc.missingMandatory.length && !pc.missingCritical.length
      && !(consentManaged() && await consentState(store, contact.id, { caseId: fresh.id }) !== 'agreed')
  }
  const turn = await runAgentTurn({
    store, log, callLLM, msg, fresh, events, contact, inboundText, prompt,
    channel, external_id, turnStartedAt, isBackgroundRedrive, staffSend, ingressRecorded,
  })
  const { result, errored, jargonReasons, falseConfirmReasons, adviceReasons, degradedReason } = turn

  if (askedPin && String(turn.text || '').trim()) await store.updateCaseChecked(fresh.id, { pin_ask: pinAskValue(fresh) }).catch(() => {})
  if (!isBackgroundRedrive && isPublic) void ensurePin({ store, callLLM, log, caseId: turn.activeCase?.id || fresh.id })
  let text = turn.text

  const endedOnId = turn.activeCase?.id || fresh.id

  const startedOnId = fresh.id

  const wasFlagged = tagList(fresh).includes('needs-human')
  const handoffAsked = controlRegistered(result, 'case_handoff')
  const preTurnCase = fresh
  fresh = await store.getCase(endedOnId).catch(() => null) || await store.getCase(fresh.id).catch(() => fresh)

  if (handoffAsked && !wasFlagged && notifyHandoff) {
    try { await notifyHandoff({ case: preTurnCase, channel, from: msg.from }) }
    catch (e) { log.warn?.('[casey] handoff notify failed', { caseId: preTurnCase.id, error: e.message }) }
  }

  const isFallback = !text
  if (isFallback) await recordDegradedOutcome({ store, log, fresh, result, errored, degradedReason, contactId: contact?.id, turnStartedAt, channel })

  const degraded = errored || isFallback

  text = await correctOutboundRef({ store, fresh, text, result, inboundText, contact })

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

  await advanceIntake({ store, log, fresh, inboundText, media, reportLanded: !!fresh?.report, replySending: !isFallback })

  if (startedOnId && startedOnId !== fresh?.id) {

    try { await store.appendEvent(startedOnId, observation(`TURN-HANDED-OFF:${msgId} continued on ${fresh?.ref || fresh?.id}`)) }
    catch (e) { log.warn?.('[casey] turn hand-off marker failed', { caseId: startedOnId, error: e.message }) }
    const departed = await store.getCase(startedOnId).catch(() => null)
    if (departed?.report) {
      await advanceIntake({ store, log, fresh: departed, inboundText, media, reportLanded: true, replySending: false })
    }
  }
  if (degraded) await tagAiOffline({ store, log, fresh })

  if (msg.queuedRedrive && degraded) {
    await store.appendEvent(fresh.id, observation('degraded re-drive; still degraded, nothing sent'))
    return { to: replyTo, text: '', platform, caseId: fresh.id, degraded: true }
  }

  if (isFallback) {

    if (isBackgroundRedrive) {
      stopTyping()
      return { to: replyTo, text: '', platform, caseId: fresh.id, degraded: true }
    }
    return await sendGuaranteedFallback({
      store, log, adapter, fresh, channel, replyTo, platform,
      turnStartedAt, stopTyping,
    })
  }

  let notice = null
  if (!degraded && !isFallback && text) {
    let early = await noticeReady
    if (!isBackgroundRedrive && isPublic) {
      const after = await speakerNow()
      if ((after?.current?.id || null) !== (speakerBefore?.current?.id || null)) early = await noticeFor(fresh, after)
    }
    notice = early ? early.notice : null
    const wantsForm = !atLeast(resolveContactTier(contact), TIER_FIELD_WORKER) && !tagList(fresh).includes('opted-out')

      && !(consentManaged() && isPublic && await consentState(store, contact.id, { caseId: fresh.id }) !== 'agreed')
    let merged = ''
    if (wantsForm) {

      const labels = await formLabelsFor(callLLM, parseReport(fresh).language_detected).catch(() => undefined)
      merged = renderFormProgress(fresh, labels)

      if (merged) text = `${merged}\n\n${text}`
    }
    if (atLeast(resolveContactTier(contact), TIER_FIELD_WORKER) && contact?.id) {
      try {
        const working = await staffProgressLine(store, contact)
        if (working) text = `${working}\n\n${text}`
      } catch (e) { log.warn?.('[casey] staff progress line failed; reply sent without it', { caseId: fresh.id, error: e.message }) }
    }
    if (notice) {
      const body = early.body
      if (body) text = `${text}\n\n${body}`
      else { notice = null; await store.appendEvent(fresh.id, observation('NOTICE-NOT-COMPOSED: the first-contact notice could not be composed; it is still owed')).catch(() => {}) }
    }
  }
  const { reply, delivered } = await sendAgentReply({ store, log, adapter, fresh, channel, replyTo, platform, text, isFallback, degraded })

  if (delivered && notice) {
    try { await recordNoticeShown(store, fresh.id, notice) }
    catch (e) { log.warn?.('[casey] notice_shown record failed', { caseId: fresh.id, error: e.message }) }
  }

  if (delivered && !isBackgroundRedrive && isPublic && turn.speakerAtStart?.needs_ask) {
    try { const now = await speakerNow(); if (now && !now.current) await noteAsked(store, contact.id) }
    catch (e) { log.warn?.('[casey] asked-who marker failed', { caseId: fresh.id, error: e.message }) }
  }

  stopTyping()
  return reply
}
