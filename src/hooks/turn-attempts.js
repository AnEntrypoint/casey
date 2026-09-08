// hooks/turn-attempts.js -- the agent turn itself: the bounded retry loop, the
// per-attempt runTurn request, and the in-loop judgement of what came back.
//
// This is the phase between hooks/case-intake.js's gates and
// hooks/turn-outcome.js's post-turn decisions. It owns exactly one question --
// "did this turn produce real, sendable text?" -- and answers it with either
// text plus optional hold reasons, or an empty string plus a classified
// degradation reason. It sends nothing and tags nothing; every delivery
// decision belongs to the caller.

import { runTurn } from '../agent/run-turn.js'
import { observation } from './case-writes.js'
import { caseSystemPrompt } from './prompt.js'
import { judgeReply } from './reply-judge.js'
import { stripThinkingBlock } from './heuristics.js'
import { mutatingActions, hadSuccessfulWrite } from './turn-results.js'
import { reporterTierExcludedToolNames } from '../case-tools.js'
import { FAILURE_REASONS } from '../degraded-turns.js'
import { TURN_HARD_DEADLINE_MS } from './turn-deadlines.js'

// A forced-tool-call turn (tool_choice:'required') that comes back with NO tool
// call at all is retried with a fresh runTurn dispatch before the turn is
// accepted as genuinely degraded -- freddie's own provider fallback chain walks
// a live-availability-ranked model order per call, not a fixed sequence, so each
// attempt is a genuinely different roll, not a repeat of the same failing call.
// Without the retry the structural guard stops a bad refusal from reaching the
// contact and leaves them with total silence instead. 3, not 2: even
// CASEY_LLM_MODEL's own primary misses tool_choice (mistral/codestral-latest
// missed on 2/2 attempts for a plain, unambiguous location report). Capped, not
// unbounded, so a persistently broken backend still fails within a bounded
// number of extra round trips rather than doubling every contact's wait
// indefinitely.
export const MAX_TOOL_CHOICE_ATTEMPTS = 3

// Fail-closed tier resolution, shared by the request's `disabledToolsets` and
// its `toolCtx.tier` so the two stay byte-identical rather than being two
// independent tier expressions that could silently drift apart.
export function resolveTier(contact) {
  return contact?.tier === 'field_worker' ? 'field_worker' : 'reporter'
}

// This attempt's timeout: the configured per-attempt ceiling, additionally
// bounded by whatever remains of the live turn's hard deadline. Returns <= 0
// when the hard deadline is already spent, which stops the retry loop.
//
// The turn's own start time (TURN-START) anchors this, so a multi-attempt retry
// loop can never exceed TURN_HARD_DEADLINE_MS in total even though each
// individual attempt still runs its own bounded per-hop chain walk to
// completion rather than being cut off mid-hop. A background redrive is exempt
// from the budget entirely -- it already ran once as a live turn and is now a
// background catch-up with its own separate retry/cap discipline
// (RESUME_DEGRADED_RETRY_CAP in casey.js), not subject to the live-turn
// guarantee at all.
export function attemptTimeout({ isBackgroundRedrive, turnStartedAt }) {
  const configuredTimeoutMs = Number(process.env.CASEY_LLM_TURN_TIMEOUT_MS) || 120000
  if (isBackgroundRedrive) return configuredTimeoutMs
  const remainingMs = TURN_HARD_DEADLINE_MS - (Date.now() - turnStartedAt)
  return remainingMs <= 0 ? remainingMs : Math.min(configuredTimeoutMs, remainingMs)
}

// Classify a thrown agent-turn failure into one of degraded-turns.js's reasons.
export function classifyTurnError(message) {
  const m = message || ''
  if (m.includes('timeout') || m.includes('deadline')) return FAILURE_REASONS.TIMEOUT
  if (m.includes('provider') || m.includes('unreachable') || m.includes('404') || m.includes('503')) return FAILURE_REASONS.PROVIDER
  return FAILURE_REASONS.RETRY_EXHAUSTED
}

// One attempt's runTurn request. Built fresh per attempt because the prompt
// carries this attempt's own retry feedback and already-completed actions.
export function buildTurnRequest({
  prompt, retryFeedback, completedActions, fresh, events, contact, turnCallLLM,
  resolvedTier, msg, external_id, channel, store, turnBinding, turnDedupeCache, timeoutMs,
}) {
  return {
    // A retry after a judge-blank/false-confirm/empty carries the judge's
    // reasons back to the model as a system note, so the next attempt corrects
    // the actual defect instead of re-rolling blind.
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
    // SECURITY: 'cases' ONLY. freddie's `ctx.tools` is ONE GLOBAL registry
    // shared by every mounted plugin, including @freddie/freddie-base's own
    // real bash/write/edit/file/credential tools and send_message (which
    // bypasses every one of casey's outbound scrubs/reference-sanitization);
    // freddie itself has NO toolset-category filter, so naming anything beyond
    // 'cases' here exposes that library, schema-visible and CALLABLE, to every
    // WhatsApp/Discord message from the public.
    //
    // THIS ARGUMENT IS NOT ITSELF THE ENFORCEMENT. The gate that makes it real
    // is casey's own src/agent/run-turn.js (the enabledToolNames derivation,
    // around lines 139-148): it resolves enabledToolsets/disabledToolsets
    // against buildCaseToolset(null)'s real tool names into an explicit
    // allowlist, and hands that to freddie-bundle/src/case-tools/
    // tool-allowlist.js's installToolAllowlist via ctx.agents.create()'s
    // per-agent setup callback (run-turn.js line 66). installToolAllowlist
    // installs two independent waterfalls: system-prompt/assemble hides every
    // non-allowlisted tool's schema, and tools/pre-execute denies dispatch by
    // name even if the model somehow names a tool outside its visible schema.
    // Keep both -- removing either leaves the base bundle's bash/write/
    // credential tools reachable from a contact-facing conversation.
    enabledToolsets: ['cases'],
    // A reporter-tier turn (the default, and the far more common contact tier
    // per AGENTS.md's contact.tier design) can never call the field_worker-
    // gated query/mutation tools anyway -- gateByTier's runtime handler check
    // (case-tools-gates.js) already rejects them. Excluding their names here
    // too cuts ~10KB/~2500 tokens of dead-weight tool-schema payload off every
    // reporter-tier turn's request, since run-turn.js's allowlist derivation
    // subtracts disabledToolsets by tool NAME before the schemas are ever
    // assembled -- real headroom against a smaller/lower-TPM provider's rate
    // limit, and one less thing for a weak model to waste a turn attempting to
    // call and being rejected. field_worker tier passes an empty array (every
    // tool stays visible).
    disabledToolsets: resolvedTier === 'field_worker' ? [] : reporterTierExcludedToolNames(),
    // Identity for the case/enquiry tools: WHO is asking (the message author),
    // the live store, and the active case. The case toolset reads these from
    // toolCtx rather than a global, so "my cases"/"near me"/"today" answer FOR
    // this worker and writes target the bound case. author = msg.from (the
    // per-author identity); the channel author is the worker (no login).
    toolCtx: {
      author: msg.from || external_id,
      channel,
      // PII PROJECTION IS CHOSEN BY OWNERSHIP, NOT BY THIS FIELD. No
      // case-tools*.js file reads ctx.role (nor principal.role) -- the read
      // tools decide the projection themselves from whether the ASKING author
      // owns the case: case-tools-lookup.js's case_get does
      // `owns ? slimCase(c) : enquiryRow(c)` (around lines 34-36) off
      // ownsCase(c.external_id, author), failing CLOSED to the PII-free
      // enquiryRow when ctx carries no author to prove ownership with, and
      // case_list/case_mine project every row through enquiryRow
      // unconditionally. So a worker asking after someone else's case can never
      // be handed a body carrying external_id/contact_id/phone -- because they
      // do not own it, not because of this string.
      //
      // role/principal are still carried as the identity thatcher's own
      // row-access scoping consumes, and are what distinguishes a channel
      // inbound (no login; the operator is the dashboard) from the dashboard's
      // own read path. `tier` below is a genuinely separate and genuinely
      // enforced axis: it controls which case_* tools are reachable at all.
      role: 'worker',
      // Access tier: 'reporter' (casual/public, report-only) or 'field_worker'
      // (elevated -- agentic case_list/case_mine/case_today queries + location
      // check-ins), enforced at call time by gateByTier (case-tools-gates.js).
      // Read from the contact's own stored tier, operator-assigned via the
      // dashboard, NEVER contact-self-service or LLM-settable. Fails CLOSED to
      // 'reporter' on any falsy/missing/unrecognised value -- a brand new
      // contact, a pre-migration row with no tier populated yet, or a corrupt
      // value all get the LOWER-privilege tier, never silently elevated.
      tier: resolvedTier,
      store,
      principal: { id: msg.from || external_id, role: 'worker' },
      activeCaseRef: turnBinding.ref,
      activeCaseId: turnBinding.id,
      // The SHARED binding object itself: freddie shallow-copies toolCtx per
      // dispatch (host_helpers.js spreads ctx), which kills a bare
      // ctx.activeCaseId mutation from case_new/case_switch -- but the copy
      // keeps this object by REFERENCE, so a rebind through it is visible to
      // every later tool call in the turn and to the next retry attempt
      // (case-tools.js's boundCase reads it first).
      activeCaseBinding: turnBinding,
      // Shared across this turn's attempts -- an exact-repeat mutating call on
      // a retry returns the cached result instead of re-executing.
      dedupeCache: turnDedupeCache,
      now: Date.now(),
    },
    // freddie's runTurn defaults to 30s, which is too tight for a COLD first
    // turn (host boot + first provider probe) against the real bridge and times
    // out into a degraded reply. The lead providers answer in well under a
    // second once warm, so this bound protects the cold start without
    // abandoning a live contact for minutes. CASEY_LLM_TURN_TIMEOUT_MS
    // overrides for slow links / dead-provider walks, and attemptTimeout()
    // additionally bounds it to the REMAINING hard-deadline budget for a live
    // turn.
    timeoutMs,
  }
}

// Judge one attempt's candidate reply. Returns `{ done: false, retryFeedback }`
// to retry, or `{ done: true, text, jargonReasons?, falseConfirmReasons? }`.
//
// Everything here runs INSIDE the attempt loop on purpose: an empty,
// verbatim-repeated, judge-blanked, or false-confirming reply is a RETRYABLE
// miss with the judge's reasons fed straight back to the model on the next
// attempt, never an instant terminal degrade. Judging outside the loop sends a
// healthy model's recoverable miss straight to the "Still working" fallback and
// parks a real report in draft limbo with no reply at all. Retrying re-rolls
// model selection too: the bridge penalizes the served model in the shared
// availability tracker on a detected miss, so a fresh attempt routes around a
// model that keeps misbehaving instead of hitting the identical broken one
// three times in a row.
export async function evaluateCandidate({ store, log, fresh, candidate, attempt, result, lastOutboundText, inboundText, turnCallLLM }) {
  const note = async (text) => {
    try { await store.appendEvent(fresh.id, observation(text)) }
    catch (e) { log.warn?.('[casey] failed to record attempt observation', { caseId: fresh.id, error: e.message }) }
  }
  const canRetry = attempt < MAX_TOOL_CHOICE_ATTEMPTS
  if (!candidate) {
    log.warn?.('[casey] agent turn produced empty reply', { caseId: fresh.id, attempt })
    await note(`empty reply on attempt ${attempt}${canRetry ? '; retrying' : ''}`)
    return { done: false, retryFeedback: "\n\n[System note: your previous reply came back empty and was not sent. Write a direct, warm reply to the contact's latest message.]" }
  }
  // Verbatim repeat-of-last-outbound guard: a structural EQUALITY comparison
  // against this case's own real prior outbound event, not a content classifier
  // -- deterministic on purpose, since the no-deterministic-text-classification
  // directive targets JUDGING what a reply MEANS, not comparing two strings for
  // being the same string. A small model with its own prior outbound visible
  // in-context does parrot the exact previous reply on a real, distinct message.
  if (lastOutboundText) {
    const strip = (s) => String(s).toLowerCase().replace(/CASE-\d+-[a-z0-9]+/gi, '').replace(/\s+/g, ' ').trim()
    if (strip(candidate) === strip(lastOutboundText)) {
      await note(`model repeated its own last outbound verbatim on attempt ${attempt}; retrying`)
      return { done: false, retryFeedback: "\n\n[System note: your previous reply was a verbatim repeat of your earlier message and was not sent. Say something new that responds to the contact's latest message.]" }
    }
  }
  // USER DIRECTIVE: no deterministic text classification anywhere -- what the
  // reply MEANS is judged by the single real-LLM judgeReply call
  // (hooks/reply-judge.js), never a regex/word-list. A jargon-only verdict is
  // NOT retried -- it is the one recoverable shape (real content, just needs a
  // human to reword one word), carried to the post-loop hold.
  const verdict = await judgeReply(turnCallLLM, candidate, { lastOutboundText, hadSuccessfulWrite: hadSuccessfulWrite(result), latestInbound: inboundText })
  if (verdict.clean) return { done: true, text: candidate }
  if (verdict.category === 'jargon') return { done: true, text: candidate, jargonReasons: verdict.reasons }
  if (verdict.reasons?.some(r => /false.?confirm|claims?.*record|confirm.*record/i.test(r))) {
    // False confirmation: the reply claims a write that never happened.
    // Retryable -- tool_choice:'required' already forces a first call, so a
    // fresh attempt with this nudge has a real chance of doing the write for
    // real. Only a budget-exhausted false confirmation falls through to the
    // draft hold.
    if (canRetry) {
      log.warn?.('[casey] reply judge flagged a false confirmation; retrying turn with feedback', { caseId: fresh.id, attempt, reasons: verdict.reasons })
      await note(`REPLY-JUDGE-FLAGGED: ${verdict.reasons.join('; ')}; retrying turn with feedback (attempt ${attempt})`)
      return { done: false, retryFeedback: '\n\n[System note: your previous reply was not sent because it claimed something was recorded or opened when nothing actually was. If the contact reported something new, call the case_new or case_report tool FIRST and wait for its result before replying. Never claim an action you did not actually perform.]' }
    }
    return { done: true, text: candidate, falseConfirmReasons: verdict.reasons }
  }
  if (verdict.reasons?.some(r => /repeated|echo|stock|meta.?commentary|planning narration/i.test(r))) {
    // Blankable shapes -- a fresh attempt with the reasons fed back has a real
    // chance at a genuine reply; only a budget-exhausted flag blanks for real.
    if (canRetry) {
      log.warn?.('[casey] reply judge flagged the composed reply; retrying turn with feedback', { caseId: fresh.id, attempt, reasons: verdict.reasons })
      await note(`REPLY-JUDGE-FLAGGED: ${verdict.reasons.join('; ')}; retrying turn with feedback (attempt ${attempt})`)
      return { done: false, retryFeedback: `\n\n[System note: your previous reply was not sent: ${verdict.reasons.join('; ')}. Write a fresh reply that directly answers the contact's latest message -- do not repeat an earlier message and do not describe your own process or plans.]` }
    }
    log.warn?.('[casey] reply judge flagged the composed reply; blanking', { caseId: fresh.id, reasons: verdict.reasons })
    await store.appendEvent(fresh.id, observation(`REPLY-JUDGE-FLAGGED: ${verdict.reasons.join('; ')}; blanked`))
    return { done: true, text: '' }
  }
  // Flagged but let-through (e.g. a tool refusal -- the model's own words
  // directly answering what it was asked, however poorly, not narration ABOUT a
  // reply).
  log.warn?.('[casey] reply judge flagged the composed reply; sending anyway', { caseId: fresh.id, reasons: verdict.reasons })
  await store.appendEvent(fresh.id, observation(`REPLY-JUDGE-FLAGGED-BUT-SENT: ${verdict.reasons.join('; ')}`))
  return { done: true, text: candidate }
}

// The whole agent turn: up to MAX_TOOL_CHOICE_ATTEMPTS runTurn dispatches inside
// the live turn's hard-deadline budget, each judged in-loop. Returns
// `{ result, text, errored, jargonReasons, falseConfirmReasons, degradedReason }`
// -- `text` is '' exactly when the whole retry budget was spent without a
// sendable reply.
export async function runAgentTurn({
  store, log, callLLM, msg, fresh, events, contact, inboundText, prompt,
  channel, external_id, turnStartedAt, isBackgroundRedrive,
}) {
  // A resume/queue re-drive is retrying a turn already known to have failed
  // before -- exempt it from the shared completion-health window (see llm.js's
  // recordHealth doc) so a burst of boot-time redrives of old stuck cases can
  // never gate a brand-new, unrelated contact's fresh message into the LLM-down
  // queue.
  const turnCallLLM = msg.resume ? (req) => callLLM(req, { recordHealth: false }) : callLLM
  const resolvedTier = resolveTier(contact)
  // Prior outbound for the repeat guard, hoisted: no new outbound can land
  // between attempts of THIS message's own turn, so one lookup serves all.
  const lastOutboundText = [...events].reverse().find(e => e.kind === 'outbound')?.text || null
  // The turn's active-case binding, mutable across attempts: a successful
  // case_new/case_switch inside an attempt rebinds via onActiveCaseChange
  // (case-tools.js), and the NEXT retry attempt's toolCtx must be built with the
  // NEW binding -- otherwise a retried turn's case_report for the freshly-opened
  // case is SECURITY-rejected exactly like the first attempt's was before the
  // rebind existed (live-witnessed: a new case's symptoms/location writes
  // rejected, facts lost).
  const turnBinding = { id: fresh.id, ref: fresh.ref }
  // Shared across ALL attempts: a retry is a FRESH runTurn that cannot see the
  // prior attempt's tool calls, so without cross-attempt dedupe the model
  // blindly repeats mutating calls and opens a SECOND case for the same report.
  const turnDedupeCache = new Map()
  // Human-readable record of successful mutating tool calls across attempts, fed
  // into retry prompts ("already DONE -- do not repeat").
  const completedActions = []

  let result, text = '', errored = false, degradedReason = null
  let jargonReasons = null, falseConfirmReasons = null, retryFeedback = null

  for (let attempt = 1; attempt <= MAX_TOOL_CHOICE_ATTEMPTS; attempt++) {
    const timeoutMs = attemptTimeout({ isBackgroundRedrive, turnStartedAt })
    if (timeoutMs <= 0) {
      log.warn?.('[casey] turn hard deadline reached before this attempt could start; stopping retries', { caseId: fresh.id, attempt })
      if (!degradedReason) degradedReason = FAILURE_REASONS.TIMEOUT
      break
    }
    try {
      result = await runTurn(buildTurnRequest({
        prompt, retryFeedback, completedActions, fresh, events, contact, turnCallLLM,
        resolvedTier, msg, external_id, channel, store, turnBinding, turnDedupeCache, timeoutMs,
      }))
    } catch (e) {
      errored = true
      log.error?.('[casey] agent turn failed', { caseId: fresh.id, error: e.message })
      if (!degradedReason) degradedReason = classifyTurnError(e.message)
      // A failed write here (store down, lock timeout) must not throw OUT of
      // this catch block -- that would propagate as an unhandled rejection from
      // the whole handleInbound call, defeating the very error handling this
      // block exists for. Degrade to a log line; the degraded-turn no-reply path
      // records the failure regardless.
      try { await store.appendEvent(fresh.id, observation(`agent turn error: ${e.message}`)) }
      catch (e2) { log.error?.('[casey] failed to record agent-turn-error observation', { caseId: fresh.id, error: e2.message }) }
      result = {}
      break   // an error is not the forced-tool-choice-miss case; no retry benefit, stop here
    }
    // stripThinkingBlock runs BEFORE anything judges the text: a reasoning-family
    // model's raw <think>...</think> block does leak through server-side, and
    // every check below must only ever reason about the real intended reply,
    // never the reasoning noise around it.
    const candidate = stripThinkingBlock((result?.result || '').toString().trim())
    // Record this attempt's successful mutating tool calls BEFORE any retry
    // decision, so a retry's prompt can name them as already-done.
    for (const action of mutatingActions(result)) completedActions.push(action)
    const verdict = await evaluateCandidate({
      store, log, fresh, candidate, attempt, result, lastOutboundText, inboundText, turnCallLLM,
    })
    if (!verdict.done) { retryFeedback = verdict.retryFeedback; continue }
    text = verdict.text
    jargonReasons = verdict.jargonReasons || null
    falseConfirmReasons = verdict.falseConfirmReasons || null
    break
  }
  return { result, text, errored, jargonReasons, falseConfirmReasons, degradedReason }
}
