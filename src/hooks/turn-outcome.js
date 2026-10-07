

import { observation, flagNeedsHuman } from './case-writes.js'
import { sanitizeOutboundRef, mergeTag, dropTag, canAgentAct, CASE_REF_RE } from './heuristics.js'
import { resolveTierValue, canQueryCases } from '../contact-tiers.js'
import { deskAuthorityOn } from '../case-tools-team-shared.js'
import { toolCaseRefs } from './turn-results.js'
import { tagList } from '../timestamp.js'
import { recordDegradedTurn, FAILURE_REASONS } from '../degraded-turns.js'

export async function recordDegradedOutcome({ store, log, fresh, result, errored, degradedReason, contactId, turnStartedAt, channel }) {
  if (!errored && result?.error) {
    log.error?.('[casey] agent returned error result', { caseId: fresh.id, error: result.error })
    await store.appendEvent(fresh.id, observation(`agent result error: ${result.error}`, { turn_error: String(result.error).slice(0, 500) }))
  }
  log.error?.('[casey] degraded turn produced no reply', { caseId: fresh.id })
  await store.appendEvent(fresh.id, observation('degraded turn (empty/error/echo/stock-ack/repeat); no reply sent.'))

  await recordDegradedTurn(store, {
    caseId: fresh.id,
    contactId: contactId || fresh.contact_id,
    reason: degradedReason || (!errored && result?.error ? FAILURE_REASONS.LLM_REFUSAL : FAILURE_REASONS.RETRY_EXHAUSTED),
    turnStartMs: turnStartedAt,
    channel,
    error: !errored && result?.error ? String(result.error).slice(0, 500) : null,
  })

  try { await store.updateCase(fresh.id, { tags: mergeTag(fresh.tags, 'degraded-turn-seen') }) }
  catch (e) { log.warn?.('[casey] degraded-turn-seen tag failed', { caseId: fresh.id, error: e.message }) }
}

export async function correctOutboundRef({ store, fresh, text, result, inboundText = '', contact = null }) {
  const extra = [...toolCaseRefs(result), ...(await namedRefsToKeep({ store, text, inboundText, contact }))]
  const { text: safeText, corrected } = sanitizeOutboundRef(text, fresh.ref, extra)
  if (!corrected.length) return text
  await store.appendEvent(fresh.id, observation(`REF-CORRECTED: model emitted ${corrected.join(', ')}; rewrote to real ref ${fresh.ref}.`))
  return safeText
}

async function namedRefsToKeep({ store, text, inboundText, contact }) {
  const found = (t) => [...new Set((String(t || '').match(CASE_REF_RE) || []).map(r => r.toUpperCase()))]

  if (!contact || !canQueryCases(contact.tier)) return []
  const typed = found(inboundText)
  const keep = [...typed]
  const ctx = { tier: resolveTierValue(contact.tier), contact }
  for (const ref of found(text)) {
    if (typed.includes(ref)) continue
    const c = await store.getCaseByRef(ref).catch(() => null)
    if (c && c.channel !== 'system' && deskAuthorityOn(ctx, c)) keep.push(ref)
  }
  return keep
}

export async function clearAiOffline({ store, log, fresh }) {
  if (!tagList(fresh).includes('ai-offline')) return
  try { await store.updateCase(fresh.id, { tags: dropTag(fresh.tags, 'ai-offline') }) }
  catch (e) { log.warn?.('[casey] ai-offline clear failed', { caseId: fresh.id, error: e.message }) }
}

export async function tagAiOffline({ store, log, fresh }) {
  try { await store.updateCase(fresh.id, { tags: mergeTag(fresh.tags, 'ai-offline') }) }
  catch (e) { log.warn?.('[casey] ai-offline tag failed', { caseId: fresh.id, error: e.message }) }
}

export async function holdReplyForHuman({
  store, log, fresh, notifyHandoff, msg, channel, replyTo, platform,
  text, isFallback, jargonReasons, falseConfirmReasons, adviceReasons, groupIds,
}) {
  if (jargonReasons || falseConfirmReasons || adviceReasons) {
    const heldReasons = jargonReasons || falseConfirmReasons || adviceReasons
    const marker = jargonReasons ? 'JARGON-HELD' : falseConfirmReasons ? 'FALSE-CONFIRMATION-HELD' : 'ADVICE-HELD'
    const holdNote = jargonReasons
      ? `${marker}: reply withheld -- ${heldReasons.join('; ')}; held for a human to reword plainly.`
      : falseConfirmReasons
        ? `${marker}: reply withheld -- ${heldReasons.join('; ')}; the reply claims something was recorded but no write actually succeeded this turn; held for a human to check and reword.`
        : `${marker}: reply withheld -- ${heldReasons.join('; ')}; the reply gives advice and the bot only connects people; held for a human to answer or reword.`
    await store.appendEvent(fresh.id, observation(holdNote))
    await store.appendEvent(fresh.id, {
      kind: 'draft', actor: 'agent', channel,
      text, data: { to: replyTo, fallback: isFallback, draft: true, in_reply_to: groupIds, jargon: jargonReasons, falseConfirmation: falseConfirmReasons, advice: adviceReasons },
    })
    await flagNeedsHuman({ store, log, caseRow: fresh, notifyHandoff, channel, from: msg.from, extraTags: ['draft-pending'], flagLabel: 'reply-hold', notifyLabel: 'reply-hold' })
    return { to: replyTo, text: '', platform, caseId: fresh.id, drafted: true, jargonHeld: jargonReasons, falseConfirmationHeld: falseConfirmReasons, adviceHeld: adviceReasons }
  }
  if (canAgentAct(fresh, 'reply') === 'draft') {
    await store.appendEvent(fresh.id, {
      kind: 'draft', actor: 'agent', channel,
      text, data: { to: replyTo, fallback: isFallback, draft: true, in_reply_to: groupIds },
    })
    await flagNeedsHuman({ store, log, caseRow: fresh, notifyHandoff, channel, from: msg.from, extraTags: ['draft-pending'], flagLabel: 'assisted draft', notifyLabel: 'assisted draft' })
    return { to: replyTo, text: '', platform, caseId: fresh.id, drafted: true }
  }
  return null
}

export async function advanceIntake({ store, log, fresh, inboundText, media, reportLanded, replySending }) {
  if (!reportLanded && !replySending) return
  const latest = await store.getCase(fresh.id).catch(() => fresh)
  if (!latest || latest.status !== 'new' || !(inboundText || media)) return
  try { await store.transition(fresh.id, 'triaging', { reason: 'first report received (auto)' }) }
  catch (e) { log.warn?.('[casey] intake auto-transition failed', { caseId: fresh.id, error: e.message }) }
}
