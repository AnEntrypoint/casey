

import { tagList } from '../timestamp.js'
import { mergeTag, dropTag, detectContactIntent, OPTED_OUT_TAG, STOP_PENDING_PREFIX } from './heuristics.js'
import { stopPendingState, stopPendingTag, stopConfirmEvent } from './stop-pending.js'
import { observation } from './case-writes.js'
import { controlActor, forgetSpeakerAfterHelp } from '../phone-persons.js'
import { resolveTierValue, TIER_REPORTER } from '../contact-tiers.js'

const isPublicPhone = (caseRow) => !!caseRow?.contact_id && resolveTierValue(caseRow.reporter_tier) === TIER_REPORTER

export async function isLlmDown(llmStatus) {
  if (typeof llmStatus !== 'function') return false
  try { const st = await llmStatus(); return !!(st && st.ok === false) }
  catch { return false }
}

export async function applyServiceControls({ store, log, llmStatus, caseRow, typedText, channel, msg, replyTo, platform }) {
  let optedOut = tagList(caseRow).includes(OPTED_OUT_TAG)
  const intent = detectContactIntent(typedText)

  if (optedOut && intent === 'help') {
    try { await store.updateCase(caseRow.id, { tags: dropTag(caseRow.tags, OPTED_OUT_TAG) }) }
    catch (e) { log.warn?.('[casey] opt-back-in untag failed', { caseId: caseRow.id, error: e.message }) }
    optedOut = false

    const actor = isPublicPhone(caseRow) ? await controlActor(store, caseRow.contact_id) : {}
    await store.appendEvent(caseRow.id, observation('OPT-BACK-IN: contact asked for help after opting out; messages resumed.', Object.keys(actor).length ? { opt_back_in: true, ...actor } : undefined))
    if (isPublicPhone(caseRow)) await forgetSpeakerAfterHelp(store, caseRow.contact_id)

    if (await isLlmDown(llmStatus)) {
      log.error?.('[casey] LLM backend down; opt-back-in state recorded but no reply composed (no hardcoded-language fallback)', { caseId: caseRow.id })
      await store.appendEvent(caseRow.id, observation('RESUME-ACK-DEGRADED: LLM unreachable; opt-back-in was applied, but no acknowledgement reply could be composed.', { degraded_turn: true, reason: 'llm_down_on_irreversible_control' }))
      return { to: replyTo, text: '', platform, caseId: caseRow.id, intent: 'resume', degraded: true }
    }
    return null
  }

  if (optedOut) {
    await store.appendEvent(caseRow.id, observation('contact previously opted out; no auto-reply'))
    return { to: replyTo, text: '', platform, caseId: caseRow.id, optedOut: true }
  }

  let tags = caseRow.tags
  let confirmed = false
  if (tagList(caseRow).some(t => t.startsWith(STOP_PENDING_PREFIX))) {
    const pending = stopPendingState(caseRow, await store.listEvents(caseRow.id))
    if (pending.valid && pending.sameTurn) return null
    tags = dropTag(tags, STOP_PENDING_PREFIX)
    confirmed = pending.valid && intent === 'stop'
    if (!confirmed) {
      await store.updateCase(caseRow.id, { tags })
      if (pending.valid) await store.appendEvent(caseRow.id, observation('STOP-CANCELLED: contact sent another message instead of confirming; they are not opted out.', { stop_cancelled: true }))
    }
  }

  if (intent !== 'stop') return null

  const stopActor = isPublicPhone(caseRow) ? await controlActor(store, caseRow.contact_id) : {}
  if (!confirmed) {
    await store.updateCase(caseRow.id, { tags: mergeTag(tags, stopPendingTag()) })
    await store.appendEvent(caseRow.id, stopConfirmEvent(await store.listEvents(caseRow.id), stopActor))
    return null
  }

  try { await store.updateCase(caseRow.id, { tags: mergeTag(tags, OPTED_OUT_TAG) }) }
  catch (e) { log.warn?.('[casey] opt-out flag failed', { caseId: caseRow.id, error: e.message }) }
  try { await store.appendEvent(caseRow.id, observation('OPT-OUT: contact asked to stop messaging.', Object.keys(stopActor).length ? { opt_out: true, ...stopActor } : undefined)) }
  catch (e) { log.warn?.('[casey] opt-out audit event failed', { caseId: caseRow.id, error: e.message }) }

  if (await isLlmDown(llmStatus)) {
    log.error?.('[casey] LLM backend down; opt-out state recorded but no reply composed (no hardcoded-language fallback)', { caseId: caseRow.id, intent })
    await store.appendEvent(caseRow.id, observation(`STOP-ACK-DEGRADED: LLM unreachable; the opt-out itself was applied, but no acknowledgement reply could be composed.`, { degraded_turn: true, reason: 'llm_down_on_irreversible_control' }))
    return { to: replyTo, text: '', platform, caseId: caseRow.id, intent, degraded: true }
  }

  return null
}
