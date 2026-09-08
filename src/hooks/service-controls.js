// hooks/service-controls.js -- the IRREVERSIBLE service controls, and the only
// deterministic pre-LLM route left in casey.
//
// STOP (opt-out) and HUMAN (handoff) are legal/service controls, not
// conversation. They must fire synchronously in any phrasing or language even
// with the model down, they are never queued, and they are never left to the
// agent's discretion. They also fire REGARDLESS of autonomy mode: an
// observe-mode contact can still say STOP or ask for a person, and that request
// is irreversible and legal, not something an operator's autonomy setting may
// silently swallow.
//
// ORDERING IS THE WHOLE POINT of this being its own stage, and it is the reason
// it is called where it is called: this runs ABOVE the LLM-down queue gate and
// ABOVE the observe-mode early return. Buried 350 lines into a single function,
// that ordering was a fact you had to reconstruct by reading; as a named stage
// in the handler's own body it is visible at the call site.
//
// The SPLIT that makes all of this work: the STATE CHANGE (opt-out tag,
// needs-human flag, audit trail, handoff notify) is unconditional and does not
// depend on the LLM. The ACKNOWLEDGEMENT TEXT is not -- it goes through the same
// real-LLM turn as any other reply, never a canned per-language string. That
// canned table was the one deterministic-language exception to the
// no-mocks/no-fallbacks invariant, and it turned out not to be needed at all:
// the legal action already survives the model being down, so the reply may fail
// loudly like every other turn.
//
// Everything else -- status, help, greeting, enquiry, report, extraction -- is
// the agent's job via the case tools, not this file's.

import { truncate } from './heuristics.js'
import { tagList } from '../timestamp.js'
import { mergeTag, dropTag, detectContactIntent, OPTED_OUT_TAG } from './heuristics.js'
import { observation, flagNeedsHuman } from './case-writes.js'

// Is the LLM backend reporting itself down right now? Three call sites used to
// spell this out inline, identically, including the swallow-and-assume-up catch:
// a status() that itself throws must never be read as "the provider is down",
// or a broken health probe would gate every inbound into the queue.
export async function isLlmDown(llmStatus) {
  if (typeof llmStatus !== 'function') return false
  try { const st = await llmStatus(); return !!(st && st.ok === false) }
  catch { return false }
}

// Runs the irreversible controls for one inbound. Returns a reply object when
// the turn is finished here, or null to fall through to the ordinary agent turn
// (which is what composes the STOP/HUMAN acknowledgement in the contact's own
// language once the control itself has already taken effect).
export async function applyServiceControls({ store, log, llmStatus, notifyHandoff, caseRow, inboundText, channel, msg, replyTo, platform }) {
  let optedOut = tagList(caseRow).includes(OPTED_OUT_TAG)
  const intent = detectContactIntent(inboundText)

  // HELP-RESUME: an opted-out contact who asks for help (any supported language)
  // OPTS BACK IN. Without this a STOP was a permanent dead-end -- nothing ever
  // cleared the tag.
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
  // unless they explicitly ask for help (handled above) or a human.
  if (optedOut && intent !== 'human') {
    await store.appendEvent(caseRow.id, observation('contact previously opted out; no auto-reply'))
    return { to: replyTo, text: '', platform, caseId: caseRow.id, optedOut: true }
  }

  if (intent !== 'stop' && intent !== 'human') return null

  if (intent === 'human') {
    // STATE-CHANGING WRITE FIRST, independently guarded: this used to run AFTER
    // the audit-trail note below, so a transient store error on that leading
    // append threw before the flag was ever written, silently losing the fact
    // that a handoff was requested. An irreversible control's tag must persist
    // independent of whether its own audit note happens to land.
    //
    // Flag needs-human as an OBSERVABLE signal; do NOT auto-raise priority --
    // casey amplifies the organisers' intent, it does not impose escalation. The
    // tag surfaces the request in the triage inbox; priority stays where the
    // people set it. detectContactIntent returns 'human' for EVERY message with
    // a human keyword, so the notify must fire only on the FIRST handoff for
    // this case: mergeTag is idempotent, the notify is not.
    await flagNeedsHuman({
      store, log, caseRow, notifyHandoff, channel, from: msg.from,
      flagLabel: 'handoff', notifyLabel: 'handoff',
    })
    try { await store.appendEvent(caseRow.id, observation('HANDOFF REQUESTED: contact asked for a human. Needs an operator.')) }
    catch (e) { log.warn?.('[casey] handoff audit event failed', { caseId: caseRow.id, error: e.message }) }
  } else {
    // Same ordering rule as the human branch: the opt-out tag write must never
    // be gated behind its own audit append succeeding first.
    try { await store.updateCase(caseRow.id, { tags: mergeTag(caseRow.tags, OPTED_OUT_TAG) }) }
    catch (e) { log.warn?.('[casey] opt-out flag failed', { caseId: caseRow.id, error: e.message }) }
    try { await store.appendEvent(caseRow.id, observation('OPT-OUT: contact asked to stop messaging.')) }
    catch (e) { log.warn?.('[casey] opt-out audit event failed', { caseId: caseRow.id, error: e.message }) }
    // A stop can arrive packed with real report content ("...please stop
    // messaging me"). The agent never sees it -- opt-out means no further
    // engagement, correctly -- so any facts in the same message would otherwise
    // rest silently in the append-only inbound event with nothing making them
    // actionable. A distinct, worst-first-visible observation gives a human the
    // chance to read and act on it manually.
    if (String(inboundText || '').trim().length >= 20) {
      await store.appendEvent(caseRow.id, observation(
        `STOP-WITH-CONTENT: the opt-out message also carried possible report content -- review manually: ${truncate(inboundText, 300)}`,
        { guardrail: 'stop_with_content' },
      ))
      try { await store.updateCase(caseRow.id, { tags: mergeTag(caseRow.tags, 'needs-human') }) }
      catch (e) { log.warn?.('[casey] stop-with-content flag failed', { caseId: caseRow.id, error: e.message }) }
    }
  }

  if (await isLlmDown(llmStatus)) {
    log.error?.('[casey] LLM backend down; opt-out/handoff state recorded but no reply composed (no hardcoded-language fallback)', { caseId: caseRow.id, intent })
    await store.appendEvent(caseRow.id, observation(`${intent.toUpperCase()}-ACK-DEGRADED: LLM unreachable; the ${intent} control itself was applied, but no acknowledgement reply could be composed.`, { degraded_turn: true, reason: 'llm_down_on_irreversible_control' }))
    return { to: replyTo, text: '', platform, caseId: caseRow.id, intent, degraded: true }
  }
  // Fall through: the control already took effect unconditionally above, and the
  // normal agent turn now composes a warm, correctly-mirrored acknowledgement.
  return null
}
