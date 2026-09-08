// casey-resume.js -- the boot-time stuck-turn resume sweep.
//
// Lifted verbatim out of Casey.resumePendingTurns, which at 228 lines was the
// largest single method in src/casey.js and is a self-contained algorithm
// rather than part of the class's assembly job: it reads the event log for
// turns that started and never completed, decides which are still worth
// re-driving, and re-drives them spaced apart so a boot cannot stampede the
// provider.
//
// The class keeps the parts that are genuinely its own -- the resumeOnBoot
// option, the gateway-handle check, and the shared `_draining` guard it holds
// in common with drainQueuedTurns -- and delegates the body here. That split
// is not invented for this change: drainQueuedTurns/_drainQueuedTurnsBody in
// the same file already had exactly this shape, and this follows it.
//
// Everything it touched on the instance is now an explicit parameter, which is
// the point: the algorithm's real inputs were four collaborators, and reading
// it no longer means knowing what else lives on Casey.
import { tagList, tsMs } from './timestamp.js'
import { mergeTag } from './hooks/heuristics.js'
import { splitExternalId } from './hooks/handler.js'

export async function resumePendingTurnsBody({ store, log, gateway, adapters, handle }, { maxCases, maxRedrives, spacingMs }) {
  let scanned = 0, resumed = 0
    const openStatuses = new Set(store.getOpenStatuses?.() || [])
    const rows = await store.listCases({}, { limit: maxCases, offset: 0 })
    for (const c of rows) {
      if (resumed >= maxRedrives) break
      // Only re-drive cases still open (a closed/won case wants no further reply).
      if (openStatuses.size && !openStatuses.has(c.status)) continue
      // Skip channels with no live adapter to send on.
      if (!adapters[c.channel]?.send) continue
      // CASE-LEVEL DEAD-LETTER: a case already flagged resume-exhausted (below)
      // has NO genuinely-pending msgId left -- every one it ever had is either
      // completed or has hit RESUME_DEGRADED_RETRY_CAP. Skip it before even
      // fetching its event log, the cheapest possible short-circuit. Without
      // this, the per-msgId cap alone was not enough: a case with MANY
      // historical inbound messages (a contact who sent several messages
      // during an outage) picks a DIFFERENT still-under-cap msgId on each
      // boot's sweep, so the case as a whole never actually stopped being
      // re-driven -- live-witnessed this session as ~28 ancient stuck cases
      // (some carrying 5-10 distinct pending msgIds each) getting walked on
      // EVERY single boot for hours, each walk burning a full provider-chain
      // attempt per msgId and competing directly with live traffic for the
      // same rate-limited capacity. A dead-lettered case still shows up in
      // the operator's needs-human queue (tagged below) -- nothing is lost,
      // it just stops silently consuming provider budget forever.
      if (tagList(c).includes('resume-exhausted')) continue
      let events
      try { events = await store.listEvents(c.id) } catch { continue }
      scanned++
      // Walk chronologically. Track, per msgId, whether its turn started, whether a
      // completion (outbound/draft) followed, and whether a resume was already
      // attempted. A completion or a later inbound for the SAME msgId is positional.
      const started = new Map()       // msgId -> inbound event
      const completedAfter = new Set()
      const attempted = new Set()     // resume-attempted this boot's own pass (same-boot dedup only)
      const degradedCount = new Map() // msgId -> count of resume-degraded markers across ALL boots
      for (const ev of events) {
        if (ev.kind === 'inbound' && ev.msg_id) started.set(ev.msg_id, ev)
        else if (ev.kind === 'observation' && typeof ev.text === 'string') {
          let m = ev.text.match(/^resume-attempted:(.+)$/)
          if (m) attempted.add(m[1])
          m = ev.text.match(/^resume-degraded:(.+)$/)
          if (m) degradedCount.set(m[1], (degradedCount.get(m[1]) || 0) + 1)
        }
        // Any outbound/draft completes EVERY turn started before it: a reply on the
        // conversation answers the latest inbound, so an earlier unanswered inbound
        // is no longer pending (the contact got a response on this thread).
        if (ev.kind === 'outbound' || ev.kind === 'draft') {
          for (const id of started.keys()) completedAfter.add(id)
        }
      }
      // The pending msgId: started, not completed, and either never attempted
      // OR previously attempted-but-degraded (no real reply) with retries
      // still under the cap. A msgId marked resume-attempted with NO
      // resume-degraded marker is treated as a genuine, silent completion
      // (the handler threw, or something unexpected happened with no
      // observation recorded) -- still not retried, matching the ORIGINAL
      // at-most-once-forever behavior for that specific failure shape, since
      // there is no positive signal here (unlike degraded) that another
      // attempt would behave differently. RESUME_DEGRADED_RETRY_CAP bounds
      // total retries across all future boots so a permanently-broken
      // backend still stops trying eventually, same discipline as
      // drainQueuedTurns' retryCap -> queue-drive-failed dead-letter.
      const RESUME_DEGRADED_RETRY_CAP = 5
      // Age ceiling, independent of attempt count: a message that has sat
      // unanswered this long has almost certainly had its sender move on --
      // continuing to resume-retry it provides no real value to anyone and
      // only keeps consuming provider budget shared with live traffic.
      // Bounds the total number of BOOTS a stuck msgId can ever be retried
      // across (not just attempts within one boot), which the attempt-count
      // cap alone did not do: a case with many old distinct pending msgIds
      // could keep finding a fresh under-cap one to retry, boot after boot,
      // indefinitely -- live-witnessed as ~28 cases some untouched for many
      // hours still being walked on every single restart tonight.
      const RESUME_MAX_AGE_MS = Number(process.env.CASEY_RESUME_MAX_AGE_MS) || 24 * 60 * 60 * 1000
      const nowMs = Date.now()
      let pending = null
      let anyCapped = false
      for (const [id, ev] of started) {
        if (completedAfter.has(id)) continue
        const wasAttempted = attempted.has(id)
        const degraded = degradedCount.get(id) || 0
        if (wasAttempted && degraded === 0) continue           // silent non-degraded completion: leave it alone
        // tsMs, not a bare Number(). busybase hands created_at back as a numeric
        // -SECONDS string, so Number() yielded a seconds count subtracted from a
        // MILLISECONDS clock: every pending turn measured ~56 years old and every
        // one of them tripped this ceiling on its very first boot. The sweep could
        // therefore never resume anything -- it only ever dead-lettered, tagging
        // the case resume-exhausted/needs-human with a message claiming a retry cap
        // that had never been reached. A turn interrupted mid-flight (TURN-START
        // written, no outbound) left the reporter in permanent silence. tsMs still
        // returns NaN for an unreadable stamp, so `|| nowMs` keeps the original
        // fail-safe: an unparseable timestamp ages 0 and is never capped.
        const ageMs = nowMs - (tsMs(ev.created_at) || nowMs)
        if (degraded >= RESUME_DEGRADED_RETRY_CAP || ageMs >= RESUME_MAX_AGE_MS) { anyCapped = true; continue }  // exhausted retries or too old: stop trying
        // tsMs, not a bare >= on the raw column. busybase hands created_at
        // back as a numeric-SECONDS STRING, so this was comparing strings --
        // which happens to order correctly only while every value is the same
        // digit length, and silently stops doing so the moment one arrives as
        // an ISO stamp or the epoch gains a digit. The line four above already
        // coerces the same column with Number(), so the function disagreed with
        // itself about whether this value is a number.
        if (!pending || tsMs(ev.created_at) >= tsMs(pending.ev.created_at)) pending = { id, ev }
      }
      if (!pending) {
        // No genuinely-pending msgId survives (each is either completed,
        // a silent non-degraded miss, or capped) -- if at least one was a
        // REAL exhausted retry (anyCapped), this case has demonstrably
        // never going to self-resolve via more resume attempts. Dead-letter
        // it so it stops consuming a scan+event-fetch AND, more importantly,
        // never re-enters the pending selection above on a future boot.
        // A case whose only uncompleted msgIds are silent (non-degraded)
        // misses is left alone deliberately -- unlike a capped degraded
        // retry, a silent miss has no positive signal that resuming would
        // ever have helped in the first place, so there is nothing to
        // conclude by giving up.
        if (anyCapped) {
          try {
            await store.updateCase(c.id, { tags: mergeTag(mergeTag(c.tags, 'resume-exhausted'), 'needs-human') })
            // data.dead_lettered (not just the resume-exhausted TAG/prose text) so
            // GET /api/turns/degraded (operations.js, which filters on structured
            // data fields, not text-prefix parsing) can surface this as its own
            // explicit, queryable terminal state -- distinct from "still queued,
            // will retry" -- rather than an operator only being able to infer
            // dead-letter status from the case simply no longer being re-driven.
            await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: 'resume-exhausted: every pending message hit the resume-degraded retry cap; this case will no longer be auto-resumed and needs a human.', data: { dead_lettered: true, reason: 'resume-exhausted' } })
          } catch (e) { log?.warn?.('[casey] resume-exhausted tag failed', { caseId: c.id, error: e.message }) }
        }
        continue
      }
      // Mark BEFORE re-drive -- at-most-once PER BOOT. A crash now leaves
      // attempted-not-done, and the next boot within the SAME resume pass
      // would otherwise re-drive the same msgId twice; the per-boot marker
      // prevents that immediate double-drive. It does NOT mean permanently
      // done -- see the completion check below, which appends a SEPARATE
      // resume-degraded:<id> marker when the redrive itself came back
      // degraded (blanked, no real reply), so a LATER boot's sweep still
      // sees this msgId as pending (resume-attempted alone no longer
      // suffices to mark it completedAfter-equivalent) and gets another
      // shot once the underlying model/provider issue clears. Previously
      // handle.call(...)'s return value was never inspected -- ANY
      // non-throwing call (including one whose reply was correctly blanked
      // by the degraded-turn guards) was treated as a permanent success,
      // silently abandoning a contact whose message was never actually
      // answered. Witnessed live this session: case mrm1kieg-fdvbupbo had
      // two "hi there I'm in tweni" messages each marked resume-attempted
      // yet neither ever received a real outbound reply -- confirmed via
      // the case's own event log (resume-attempted with no following
      // outbound/degraded-with-no-retry-path).
      // Spaced, not a burst: each re-drive walks the SAME provider chain a
      // brand-new live contact's message would, and a boot with many stuck
      // cases fires them back-to-back with no delay between -- directly
      // competing for the same tiny per-minute rate-limit windows a real
      // inbound needs right now. Live-witnessed: a genuine "hey whats up"
      // arrived mid-sweep and timed out because every configured provider
      // was still rate-limited from the sweep's OWN traffic seconds
      // earlier. maxRedrives also dropped from 50 to a
      // CASEY_RESUME_MAX_REDRIVES-tunable default of 10 for the same
      // reason -- most boots have few or zero genuinely-stuck cases; a high
      // count is itself a symptom (heavy testing/restart churn) that should
      // not compound into starving live traffic. Gated on resumed > 0 so
      // the FIRST re-drive of a boot still fires immediately (nothing to
      // wait behind yet); placed here (immediately before the actual
      // re-drive), not earlier in the loop, so cases skipped by the
      // eligibility filters above never pay the delay.
      // +/-20% jitter on the spacing itself: a fixed delay across many stuck
      // cases still synchronizes this sweep's own retries against each other
      // (thundering-herd risk against the same rate-limited providers live
      // traffic needs), even though the delay already spaces them out from a
      // burst. Jitter breaks that residual synchronization at zero cost --
      // still bounded by the same spacingMs order of magnitude either way.
      if (resumed > 0 && spacingMs > 0) {
        const jitter = spacingMs * (0.8 + Math.random() * 0.4)
        await new Promise(r => setTimeout(r, jitter))
      }
      try {
        await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `resume-attempted:${pending.id}` })
      } catch (e) { log?.warn?.('[casey] resume marker failed', { caseId: c.id, error: e.message }); continue }
      const platform = c.channel
      // external_id is the CASE IDENTITY (conversationKey's container:author
      // shape on a multi-author channel), not a valid Discord channel snowflake
      // on its own -- replyTarget() reads msg.raw.channel_id directly, so
      // passing the combined external_id through unsplit sent every resumed
      // reply on a multi-author Discord channel to Discord as an invalid
      // channel id (400 Invalid Form Body, NUMBER_TYPE_COERCE), silently never
      // reaching the contact even when the LLM call itself succeeded. The
      // compounding-key history behind taking the LAST segment as the author
      // lives on splitExternalId itself (hooks/handler.js) -- read it there
      // before changing either call site.
      const { container, author } = splitExternalId(c.external_id)
      const msg = {
        from: author,
        text: pending.ev.text || '',
        platform,
        resume: true,
        raw: { channel_id: container, id: pending.id, author: {} },
      }
      try {
        const res = await handle.call(gateway, platform, msg)
        resumed++
        if (res && res.degraded) {
          log?.warn?.('[casey] resumed turn came back degraded; still no reply', { caseId: c.id, channel: c.channel })
          try { await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `resume-degraded:${pending.id}` }) }
          catch (e2) { log?.warn?.('[casey] resume-degraded marker failed', { caseId: c.id, error: e2.message }) }
        } else {
          log?.info?.('[casey] resumed pending turn', { caseId: c.id, channel: c.channel })
        }
      } catch (e) {
        // Already marked attempted, so it will not be re-driven again THIS
        // sweep, but the throw itself means no observation was recorded for
        // it either -- log loud so an operator can see the failure even
        // though no resume-degraded marker exists to name it as such.
        log?.warn?.('[casey] resume re-drive failed', { caseId: c.id, error: e.message })
      }
    }
    // Always log the sweep's outcome, not just when it actually redrove
    // something -- a silent "nothing happened" completion is exactly as
    // important to see as a busy one when diagnosing whether the sweep is
    // running at all vs. genuinely idle vs. quietly stuck. Previously
    // gated on `if (resumed)`, so a fully-idle sweep (the common,
    // healthy case once the dead-letter fix above is doing its job) left
    // zero trace it ever ran.
    log?.info?.('[casey] resume sweep complete', { scanned, resumed })
    return { scanned, resumed }
}
