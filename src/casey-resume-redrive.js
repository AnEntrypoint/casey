// casey-resume-redrive.js  --  the effects the resume sweep performs once
// casey-resume-scan.js has decided what a case needs: dead-letter it, mark an
// attempt, or actually re-drive the interrupted turn through the real handler.
//
// Split out of casey-resume.js verbatim. Every write here is ordered the way it
// is for a reason stated inline; the marker in particular is written BEFORE the
// re-drive, never after.

import { mergeTag } from './hooks/heuristics.js'
import { splitExternalId } from './hooks/handler.js'

// No genuinely-pending msgId survives (each is either completed, a silent
// non-degraded miss, or capped) AND at least one was a REAL exhausted retry:
// this case will not self-resolve via further resume attempts, so dead-letter it.
// It stops consuming a scan + event-fetch and, more importantly, never re-enters
// the pending selection on a future boot. A case whose only uncompleted msgIds
// are silent (non-degraded) misses is left alone deliberately -- unlike a capped
// degraded retry, a silent miss carries no signal that resuming would ever have
// helped, so there is nothing to conclude by giving up.
export async function deadLetterExhaustedCase(store, log, c) {
  try {
    await store.updateCase(c.id, { tags: mergeTag(mergeTag(c.tags, 'resume-exhausted'), 'needs-human') })
    // data.dead_lettered, not just the resume-exhausted TAG/prose text, so GET
    // /api/turns/degraded (operations.js filters on structured data fields, never
    // text-prefix parsing) can surface this as its own explicit, queryable
    // terminal state -- distinct from "still queued, will retry" -- rather than an
    // operator only being able to infer dead-letter status from the case no longer
    // being re-driven.
    await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: 'resume-exhausted: every pending message hit the resume-degraded retry cap; this case will no longer be auto-resumed and needs a human.', data: { dead_lettered: true, reason: 'resume-exhausted' } })
  } catch (e) { log?.warn?.('[casey] resume-exhausted tag failed', { caseId: c.id, error: e.message }) }
}

// Mark BEFORE re-drive -- at-most-once PER BOOT. A crash now leaves
// attempted-not-done, and the next boot within the SAME resume pass would
// otherwise re-drive the same msgId twice; the per-boot marker prevents that
// immediate double-drive. It does NOT mean permanently done -- redrivePendingTurn
// appends a SEPARATE resume-degraded:<id> marker when the redrive itself comes
// back degraded (blanked, no real reply), so a LATER boot's sweep still sees this
// msgId as pending (resume-attempted alone does not make it
// completedAfter-equivalent) and gets another shot once the underlying
// model/provider issue clears.
export async function markResumeAttempted(store, log, c, msgId) {
  try {
    await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `resume-attempted:${msgId}` })
    return true
  } catch (e) {
    log?.warn?.('[casey] resume marker failed', { caseId: c.id, error: e.message })
    return false
  }
}

// external_id is the CASE IDENTITY (conversationKey's container:author shape on a
// multi-author channel), not a valid Discord channel snowflake on its own. Split
// it: container is the FIRST segment, author the LAST. replyTarget() reads
// msg.raw.channel_id directly, so passing the combined external_id through
// unsplit sends every resumed reply on a multi-author Discord channel to Discord
// as an invalid channel id (400 Invalid Form Body, NUMBER_TYPE_COERCE), silently
// never reaching the contact even when the LLM call itself succeeded.
// splitExternalId (hooks/handler.js) owns that rule -- read it there before
// changing either call site.
function resumeMessage(c, pending) {
  const { container, author } = splitExternalId(c.external_id)
  return {
    from: author,
    text: pending.ev.text || '',
    platform: c.channel,
    resume: true,
    raw: { channel_id: container, id: pending.id, author: {} },
  }
}

// handle.call(...)'s return value MUST be inspected: treating ANY non-throwing
// call as a permanent success silently abandons a contact whose reply was
// correctly blanked by the degraded-turn guards and never actually sent.
// Returns true when the turn was actually driven (counts toward maxRedrives),
// false when the call itself threw.
export async function redrivePendingTurn({ store, log, gateway, handle }, c, pending) {
  try {
    const res = await handle.call(gateway, c.channel, resumeMessage(c, pending))
    if (res && res.degraded) {
      log?.warn?.('[casey] resumed turn came back degraded; still no reply', { caseId: c.id, channel: c.channel })
      try { await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `resume-degraded:${pending.id}` }) }
      catch (e2) { log?.warn?.('[casey] resume-degraded marker failed', { caseId: c.id, error: e2.message }) }
    } else {
      log?.info?.('[casey] resumed pending turn', { caseId: c.id, channel: c.channel })
    }
    return true
  } catch (e) {
    // Already marked attempted, so it will not be re-driven again THIS sweep, but
    // the throw itself means no observation was recorded for it either -- log loud
    // so an operator can see the failure even though no resume-degraded marker
    // exists to name it as such.
    log?.warn?.('[casey] resume re-drive failed', { caseId: c.id, error: e.message })
    return false
  }
}

// Spaced, not a burst: each re-drive walks the SAME provider chain a brand-new
// live contact's message would, so firing them back-to-back with no delay
// competes directly for the same tiny per-minute rate-limit windows a real
// inbound needs right now -- a genuine live message arriving mid-sweep times out
// because every configured provider is still rate-limited by the sweep's OWN
// traffic seconds earlier. For the same reason maxRedrives defaults to 10
// (CASEY_RESUME_MAX_REDRIVES-tunable): most boots have few or zero
// genuinely-stuck cases, and a high count is itself a symptom (heavy
// testing/restart churn) that must not compound into starving live traffic.
// Gated on resumed > 0 so the FIRST re-drive of a boot still fires immediately
// (nothing to wait behind yet); called immediately before the actual re-drive,
// not earlier in the loop, so cases skipped by the eligibility filters never pay
// the delay.
// +/-20% jitter on the spacing itself: a fixed delay across many stuck cases
// still synchronizes this sweep's own retries against each other
// (thundering-herd risk against the same rate-limited providers live traffic
// needs), even though the delay already spaces them out from a burst. Jitter
// breaks that residual synchronization at zero cost -- still bounded by the same
// spacingMs order of magnitude either way.
export async function spaceRedrives(resumed, spacingMs) {
  if (!(resumed > 0 && spacingMs > 0)) return
  const jitter = spacingMs * (0.8 + Math.random() * 0.4)
  await new Promise(r => setTimeout(r, jitter))
}
