// hooks/service-controls.js -- the only deterministic pre-LLM route left in casey,
// reduced to the bare minimum.
//
// Language handling is the agent's (case_stop / case_handoff, see
// heuristics.js). What remains here: the whole-message English word 'stop'
// applies the opt-out state change at once, and the whole-message word 'help'
// opts an opted-out contact back in. Both fire REGARDLESS of autonomy mode and
// ABOVE the LLM-down queue gate and the observe-mode early return.
//
// The bot never contacts anyone first, so nothing here needs to beat the model:
// a STOP the agent reads a moment later, or on recovery from an outage (the
// queued message is re-driven), causes no message to the contact in between.
// The acknowledgement TEXT is always the model's, never a canned string.

import { tagList } from '../timestamp.js'
import { mergeTag, dropTag, detectContactIntent, OPTED_OUT_TAG } from './heuristics.js'
import { observation } from './case-writes.js'

// Is the LLM backend reporting itself down right now? A status() that itself
// throws must never be read as "the provider is down" -- swallow and assume up,
// or a broken health probe gates every inbound into the queue.
export async function isLlmDown(llmStatus) {
  if (typeof llmStatus !== 'function') return false
  try { const st = await llmStatus(); return !!(st && st.ok === false) }
  catch { return false }
}

// Runs the irreversible controls for one inbound. Returns a reply object when
// the turn is finished here, or null to fall through to the ordinary agent turn
// (which is what composes the STOP acknowledgement in the contact's own
// language once the control itself has already taken effect).
export async function applyServiceControls({ store, log, llmStatus, caseRow, inboundText, channel, msg, replyTo, platform }) {
  let optedOut = tagList(caseRow).includes(OPTED_OUT_TAG)
  const intent = detectContactIntent(inboundText)
  // HELP-RESUME: an opted-out contact who asks for help (any supported language)
  // OPTS BACK IN. Keep this path -- it is the only thing that clears the tag, so
  // without it a STOP is a permanent dead-end.
  if (optedOut && intent === 'help') {
    try { await store.updateCase(caseRow.id, { tags: dropTag(caseRow.tags, OPTED_OUT_TAG) }) }
    catch (e) { log.warn?.('[casey] opt-back-in untag failed', { caseId: caseRow.id, error: e.message }) }
    optedOut = false
    await store.appendEvent(caseRow.id, observation('OPT-BACK-IN: contact asked for help after opting out; messages resumed.'))
    // The state change above is the real, unconditional control. With the LLM
    // down, log loud and send nothing (matching the queue gate) rather than a
    // guessed-language canned string; otherwise fall through so the normal agent
    // turn composes a real, language-mirrored resume acknowledgement from the
    // OPT-BACK-IN observation now on the timeline.
    if (await isLlmDown(llmStatus)) {
      log.error?.('[casey] LLM backend down; opt-back-in state recorded but no reply composed (no hardcoded-language fallback)', { caseId: caseRow.id })
      await store.appendEvent(caseRow.id, observation('RESUME-ACK-DEGRADED: LLM unreachable; opt-back-in was applied, but no acknowledgement reply could be composed.', { degraded_turn: true, reason: 'llm_down_on_irreversible_control' }))
      return { to: replyTo, text: '', platform, caseId: caseRow.id, intent: 'resume', degraded: true }
    }
    return null
  }

  // Respect a prior opt-out: once someone said STOP, do not auto-reply again
  // unless they explicitly ask for help (handled above).
  if (optedOut) {
    await store.appendEvent(caseRow.id, observation('contact previously opted out; no auto-reply'))
    return { to: replyTo, text: '', platform, caseId: caseRow.id, optedOut: true }
  }

  if (intent !== 'stop') return null

  // The opt-out tag write must never be gated behind its own audit append.
  try { await store.updateCase(caseRow.id, { tags: mergeTag(caseRow.tags, OPTED_OUT_TAG) }) }
  catch (e) { log.warn?.('[casey] opt-out flag failed', { caseId: caseRow.id, error: e.message }) }
  try { await store.appendEvent(caseRow.id, observation('OPT-OUT: contact asked to stop messaging.')) }
  catch (e) { log.warn?.('[casey] opt-out audit event failed', { caseId: caseRow.id, error: e.message }) }

  if (await isLlmDown(llmStatus)) {
    log.error?.('[casey] LLM backend down; opt-out state recorded but no reply composed (no hardcoded-language fallback)', { caseId: caseRow.id, intent })
    await store.appendEvent(caseRow.id, observation(`STOP-ACK-DEGRADED: LLM unreachable; the opt-out itself was applied, but no acknowledgement reply could be composed.`, { degraded_turn: true, reason: 'llm_down_on_irreversible_control' }))
    return { to: replyTo, text: '', platform, caseId: caseRow.id, intent, degraded: true }
  }
  // Fall through: the control already took effect unconditionally above, and the
  // normal agent turn now composes a warm, correctly-mirrored acknowledgement.
  return null
}
