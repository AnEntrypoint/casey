

import { observation, flagNeedsHuman } from './case-writes.js'
import { applyServiceControls, isLlmDown } from './service-controls.js'
import { describeMedia, recordInboundMedia, recordInboundLocation, transcribeInboundAudio, sttProvenance } from './media-intake.js'
import { voiceNote, voiceFailureNote } from '../stt/readback.js'
import { googleSttConfig } from '../stt/config.js'
import { atLeast, resolveContactTier, TIER_FIELD_WORKER } from '../contact-tiers.js'
import { routeStaffArtifact, recordRelayedLocationPin, noteRoute, routeChoices } from './media-relay.js'
import { staffLabel } from './staff-outbound.js'
import { truncate, stripChannelMarkup, mergeTag, dropTag } from './heuristics.js'
import { isContactAssignee } from '../case-assignment.js'
import { recordDroppedInbound } from './dropped-intake.js'
import { tagList } from '../timestamp.js'
import { stampReporter } from '../phone-persons.js'
import { tapNote } from '../choices.js'
import { isBarePin, answerBarePin } from '../pin-query.js'
import { resolveTierValue, TIER_REPORTER } from '../contact-tiers.js'

export function messageId(msg) {
  return msg.raw?.id || msg.id || ''
}

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

export async function openCaseForInbound({ store, log, msg, channel, external_id, replyTo, platform }) {
  const msgId = messageId(msg)
  if (!msgId) log?.warn?.('[casey] inbound message missing id; dedup guarantee not applied', { channel })

  let caseRow, created
  try {
    ;({ case: caseRow, created } = await store.findOrCreateCase({
      channel, external_id,

      contact: {
        display_name: msg.profileName || msg.raw?.author?.username,
        handle: msg.profileName || msg.raw?.author?.username,
      },
    }))
  } catch (e) {
    log.error?.('[casey] findOrCreateCase failed; dropping inbound', { channel, error: e.message })

    recordDroppedInbound('case_resolve_failed', { channel, store, log })
    return { done: { to: replyTo, text: '', platform, error: e.message } }
  }

  const spoken = (await transcribeInboundAudio({ store, log, caseId: caseRow.id, msg }).catch(() => null))?.text || ''
  const inboundText = [stripChannelMarkup(msg.text || ''), spoken].filter(Boolean).join('\n')
  const media = describeMedia(msg)
  let inboundEvent
  try {

    inboundEvent = await store.recordInbound(caseRow, {
      channel,
      text: inboundText || (media ? `[${media}]` : '[empty message]'),
      data: spoken ? { transcribed: true, transcribed_by: 'ai_helper', stt: sttProvenance(msg._transcript) } : {}, msg_id: msgId,
    })
  } catch (e) {

    log.error?.('[casey] recordInbound failed; dropping inbound', { caseId: caseRow.id, channel, error: e.message })

    recordDroppedInbound('inbound_record_failed', { channel, store, log })
    return { done: { to: replyTo, text: '', platform, caseId: caseRow.id, error: e.message } }
  }

  if (!inboundEvent && !msg.resume && !msg.burstReplay) {
    log.info?.('[casey] duplicate inbound dropped', { caseId: caseRow.id, msgId })
    return { done: { to: replyTo, text: '', platform, caseId: caseRow.id, duplicate: true } }
  }
  return { caseRow, created, inboundText, media, msgId }
}

async function isTeamSender(store, caseRow) {
  const contact = caseRow.contact_id ? await store.getContact(caseRow.contact_id) : null
  return !!contact && atLeast(resolveContactTier(contact), TIER_FIELD_WORKER)
}

export async function applyInboundSideEffects({ store, log, caseRow, created, msg, channel, inboundText, media }) {

  if (tagList(caseRow).includes('draft-pending')) {
    try {
      await store.updateCase(caseRow.id, { tags: dropTag(caseRow.tags, 'draft-pending') })
      await store.appendEvent(caseRow.id, observation('DRAFT SUPERSEDED: a new message arrived; the pending draft reply was set aside for a fresh one.'))
    } catch (e) { log.warn?.('[casey] draft supersede failed', { caseId: caseRow.id, error: e.message }) }
  }

  const barePin = isBarePin(msg, inboundText)
  let route = await routeStaffArtifact({ store, log, caseRow, msg, inboundText, msgId: messageId(msg) })
  if (barePin && route?.mode !== 'relay') route = null
  let promptNote = route ? await noteRoute({ store, log, caseRow, route, msg, barePin }) : ''
  promptNote += await tapNote(store, caseRow.contact_id, msg)
  let inboundChoices = routeChoices(route)
  const tr = msg._transcript
  if (tr?.text) {
    const staff = await isTeamSender(store, caseRow)
    promptNote += voiceNote(tr, { staff, minConfidence: googleSttConfig().minConfidence }).note
  } else if (tr) promptNote += voiceFailureNote(tr)
  const ingressRecorded = route?.mode === 'relay'
  if (ingressRecorded) {
    const relay = { by: staffLabel(route.contact), contactId: route.contact.id }
    await recordInboundMedia({ store, log, caseId: route.target.id, msg, relay })
    await recordRelayedLocationPin({ store, log, route, msg })
  } else {
    await recordInboundMedia({ store, log, caseId: caseRow.id, msg })
  }

  if (route?.mode !== 'relay') promptNote += (await recordInboundLocation({ store, log, caseId: caseRow.id, msg })) || ''
  if (barePin) {
    const answered = await answerBarePin({ store, log, caseRow, msg })
    if (answered) { promptNote += answered.promptNote; inboundChoices = answered.choices }
  }
  if (!created) return { promptNote, ingressRecorded, inboundChoices }
  if (!caseRow.subject) {
    const subj = truncate(inboundText || media || 'New conversation', 80)
    try { await store.updateCase(caseRow.id, { subject: subj }) } catch (e) { log.warn?.('[casey] seed subject failed', { error: e.message }) }
  }

  try {
    if (!tagList(caseRow).includes('intake_mode:channel')) {
      await store.updateCase(caseRow.id, { tags: mergeTag(caseRow.tags, 'intake_mode:channel') })
    }
  } catch (e) { log.warn?.('[casey] intake_mode tag failed', { error: e.message }) }
  try { await store.appendEvent(caseRow.id, { kind: 'note', actor: 'system', text: `Case opened from ${channel}` }) }
  catch (e) { log.warn?.('[casey] case-opened note failed', { caseId: caseRow.id, error: e.message }) }

  if (caseRow.contact_id && resolveTierValue(caseRow.reporter_tier) === TIER_REPORTER) {
    try { await stampReporter(store, caseRow.contact_id, caseRow.id) }
    catch (e) { log.warn?.('[casey] reporter stamp failed', { caseId: caseRow.id, error: e.message }) }
  }
  return { promptNote, ingressRecorded, inboundChoices }
}

export async function applyPreTurnControls({ store, log, llmStatus, notifyHandoff, fresh, inboundText, channel, msg, replyTo, platform }) {
  const controlled = await applyServiceControls({
    store, log, llmStatus,
    caseRow: fresh, inboundText, channel, msg, replyTo, platform,
  })
  if (controlled) return controlled

  if (fresh.autonomy === 'observe') {
    await store.appendEvent(fresh.id, observation('autonomy=observe: awaiting operator (no auto-reply)'))

    if (!isContactAssignee(fresh.assignee)) {
      await flagNeedsHuman({ store, log, caseRow: fresh, notifyHandoff, channel, from: msg.from, flagLabel: 'observe needs-human', notifyLabel: 'observe handoff' })
    }
    return { to: replyTo, text: '', platform, caseId: fresh.id, observed: true }
  }
  return null
}

export async function llmDownQueueGate({ store, log, llmStatus, fresh, events, msg, msgId, replyTo, platform }) {
  if (msg.resume || !(await isLlmDown(llmStatus))) return null
  const already = events.some(e => e.kind === 'observation' && typeof e.text === 'string' && e.text === `QUEUED-FOR-AGENT:${msgId}`)
  if (already) {

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
